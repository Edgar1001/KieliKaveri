import { Platform } from 'react-native';
import { isRunningInExpoGo } from 'expo';
import { fetch } from 'expo/fetch';

export type RealtimeEvent = {
  type: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
  item?: { id: string; role?: string };
};

type SessionOptions = {
  apiUrl: string;
  appKey: string;
  level: string;
  languageMode: string;
  history: { transcript: string; reply: string }[];
  signal: AbortSignal;
  onEvent: (event: RealtimeEvent) => void;
  onDisconnect: (error?: Error) => void;
};

export async function connectRealtime(options: SessionOptions): Promise<{ close: () => void }> {
  if (Platform.OS !== 'web' && isRunningInExpoGo()) {
    throw new Error('RT puhe needs the native Android build. Expo Go does not include WebRTC.');
  }
  const native = Platform.OS !== 'web'
    ? require('react-native-webrtc') as typeof import('react-native-webrtc')
    : null;
  const PeerConnection = native
    ? native.RTCPeerConnection as unknown as typeof RTCPeerConnection
    : globalThis.RTCPeerConnection;
  const peer = new PeerConnection();
  const channel = peer.createDataChannel('oai-events');
  let microphone: MediaStream | null = null;
  let audio: HTMLAudioElement | null = null;
  let closed = false;
  let ready = false;
  const request = new AbortController();
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(connectionTimer);
    request.abort();
    options.signal.removeEventListener('abort', close);
    microphone?.getTracks().forEach((track) => track.stop());
    channel.close();
    peer.close();
    if (audio) {
      audio.pause();
      audio.srcObject = null;
    }
  }

  function fail(error: Error) {
    if (closed) return;
    close();
    options.onDisconnect(error);
  }

  function checkCancelled() {
    if (closed || options.signal.aborted) {
      close();
      throw new Error('Realtime connection cancelled.');
    }
  }

  options.signal.addEventListener('abort', close, { once: true });
  connectionTimer = setTimeout(() => fail(new Error('Realtime connection timed out.')), 30_000);
  channel.addEventListener('open', () => {
    if (closed) return;
    ready = true;
    clearTimeout(connectionTimer);
    options.onEvent({ type: 'connected' });
    channel.send(JSON.stringify({
      type: 'response.create',
      response: { instructions: 'Greet the learner briefly in Finnish and ask one opening question, or continue the recent conversation.' },
    }));
  });
  channel.addEventListener('message', ({ data }) => {
    if (closed) return;
    try {
      const event = JSON.parse(data) as RealtimeEvent;
      if (event.type === 'error') {
        fail(new Error(event.error?.message ?? 'Realtime voice failed.'));
      } else {
        options.onEvent(event);
      }
    } catch {
      fail(new Error('The realtime session returned an invalid event.'));
    }
  });
  channel.addEventListener('close', () => {
    if (!closed) fail(new Error('The realtime session disconnected.'));
  });
  peer.addEventListener('connectionstatechange', () => {
    if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
      fail(new Error('The realtime audio connection was lost.'));
    }
  });
  if (Platform.OS === 'web') {
    audio = new Audio();
    audio.autoplay = true;
    peer.addEventListener('track', (event) => {
      if (closed || !audio) return;
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void audio.play().catch(() => fail(new Error('Realtime audio playback could not start.')));
    });
  }

  try {
    checkCancelled();
    microphone = native
      ? await native.mediaDevices.getUserMedia({ audio: true, video: false }) as unknown as MediaStream
      : await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    if (closed) microphone.getTracks().forEach((track) => track.stop());
    checkCancelled();
    microphone.getAudioTracks().forEach((track) => peer.addTrack(track, microphone!));
    const offer = await peer.createOffer();
    checkCancelled();
    await peer.setLocalDescription(offer);
    checkCancelled();
    if (peer.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Audio connection setup timed out.')), 10_000);
        function finish(error?: Error) {
          clearTimeout(timer);
          peer.removeEventListener('icegatheringstatechange', gathered);
          request.signal.removeEventListener('abort', aborted);
          if (error) reject(error);
          else resolve();
        }
        function gathered() {
          if (peer.iceGatheringState === 'complete') finish();
        }
        function aborted() { finish(new Error('Realtime connection cancelled.')); }
        peer.addEventListener('icegatheringstatechange', gathered);
        request.signal.addEventListener('abort', aborted, { once: true });
        gathered();
      });
    }
    checkCancelled();
    const response = await fetch(`${options.apiUrl}/api/realtime/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Key': options.appKey },
      body: JSON.stringify({ sdp: peer.localDescription?.sdp ?? offer.sdp, level: options.level, languageMode: options.languageMode, history: options.history }),
      signal: request.signal,
    });
    const result = await response.json() as { sdp?: string; error?: string };
    if (!response.ok || !result.sdp) {
      throw new Error(result.error ?? 'The realtime API could not connect. Deploy the updated backend first.');
    }
    checkCancelled();
    await peer.setRemoteDescription({ type: 'answer', sdp: result.sdp });
    checkCancelled();
    if (ready) clearTimeout(connectionTimer);
    return { close };
  } catch (error) {
    close();
    throw error;
  }
}