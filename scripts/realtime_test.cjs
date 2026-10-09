const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function harness({ media, response, expoGo = false } = {}) {
  const track = { stops: 0, stop() { this.stops += 1; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const channel = new EventTarget();
  channel.sent = [];
  channel.close = () => { channel.closed = true; };
  channel.send = (data) => channel.sent.push(JSON.parse(data));
  let peer;
  class Peer extends EventTarget {
    constructor() { super(); peer = this; this.iceGatheringState = 'complete'; }
    createDataChannel() { return channel; }
    addTrack() {}
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\noffer' }; }
    async setLocalDescription() {}
    async setRemoteDescription(answer) { this.answer = answer; }
    close() { this.closed = true; }
  }
  const requests = [];
  const code = ts.transpileModule(readFileSync(require.resolve('../realtime.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exported = {};
  vm.runInNewContext(code, {
    exports: exported, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name === 'react-native') return { Platform: { OS: 'android' } };
      if (name === 'expo') return { isRunningInExpoGo: () => expoGo };
      if (name === 'react-native-webrtc') return {
        RTCPeerConnection: Peer, mediaDevices: { getUserMedia: () => media ?? Promise.resolve(stream) },
      };
      if (name === 'expo/fetch') return { fetch: async (url, request) => {
        requests.push({ url, request });
        return response ?? { ok: true, json: async () => ({ sdp: 'v=0\r\nanswer' }) };
      } };
      throw new Error(`Unexpected module: ${name}`);
    },
  });
  const controller = new AbortController();
  const events = [];
  const failures = [];
  const options = {
    apiUrl: 'https://tutor.example', appKey: 'app-key', level: 'B2', languageMode: 'Puhekieli',
    history: [], signal: controller.signal,
    onEvent: (event) => events.push(event), onDisconnect: (error) => failures.push(error),
  };
  return { connect: () => exported.connectRealtime(options), controller, events, failures, channel, track, stream, requests, get peer() { return peer; } };
}

test('connects through authenticated backend and sends only the initial greeting command', async () => {
  const mock = harness();
  const session = await mock.connect();
  assert.equal(mock.requests[0].url, 'https://tutor.example/api/realtime/session');
  assert.equal(mock.requests[0].request.headers['X-App-Key'], 'app-key');
  assert.equal(JSON.parse(mock.requests[0].request.body).level, 'B2');
  assert.equal(mock.peer.answer.sdp, 'v=0\r\nanswer');
  mock.channel.dispatchEvent(new Event('open'));
  assert.equal(mock.events[0].type, 'connected');
  assert.equal(mock.channel.sent[0].type, 'response.create');
  session.close();
  session.close();
  assert.equal(mock.track.stops, 1);
  assert.equal(mock.peer.closed, true);
  assert.equal(mock.channel.closed, true);
});

test('stopping while permission is pending releases the late microphone stream', async () => {
  let grant;
  const mock = harness({ media: new Promise((resolve) => { grant = resolve; }) });
  const pending = mock.connect();
  mock.controller.abort();
  grant(mock.stream);
  await assert.rejects(pending, /cancelled/);
  assert.equal(mock.track.stops, 1);
  assert.equal(mock.requests.length, 0);
});

test('backend errors release microphone and connection', async () => {
  const mock = harness({ response: { ok: false, json: async () => ({ error: 'Realtime unavailable' }) } });
  await assert.rejects(mock.connect(), /Realtime unavailable/);
  assert.equal(mock.track.stops, 1);
  assert.equal(mock.peer.closed, true);
});

test('server errors stop a connected session', async () => {
  const mock = harness();
  await mock.connect();
  mock.channel.dispatchEvent(Object.assign(new Event('message'), {
    data: JSON.stringify({ type: 'error', error: { message: 'Session expired' } }),
  }));
  assert.equal(mock.failures[0].message, 'Session expired');
  assert.equal(mock.track.stops, 1);
});

test('Expo Go fails clearly before requesting microphone access', async () => {
  const mock = harness({ expoGo: true });
  await assert.rejects(mock.connect(), /native Android build/);
  assert.equal(mock.requests.length, 0);
  assert.equal(mock.peer, undefined);
});

function transcript() {
  const exported = {};
  const code = ts.transpileModule(readFileSync(require.resolve('../realtimeTranscript.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports: exported });
  return new exported.RealtimeTranscript();
}

test('pairs a reply with its delayed input transcript', () => {
  const history = transcript();
  history.receive({ type: 'input_audio_buffer.committed', item_id: 'user-1' });
  history.receive({ type: 'response.output_item.added', item: { id: 'reply-1' } });
  assert.equal(history.receive({ type: 'response.output_audio_transcript.done', item_id: 'reply-1', transcript: 'Hei!' }), undefined);
  const turn = history.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-1', transcript: 'Moi!' });
  assert.equal(turn.transcript, 'Moi!');
  assert.equal(turn.reply, 'Hei!');
  assert.equal(history.messages[0].role, 'user');
});

test('keeps overlapping turns and the opening greeting separate', () => {
  const history = transcript();
  assert.equal(history.receive({ type: 'response.output_audio_transcript.done', item_id: 'greeting', transcript: 'Terve!' }), undefined);
  history.receive({ type: 'input_audio_buffer.committed', item_id: 'user-1' });
  history.receive({ type: 'response.output_item.added', item: { id: 'reply-1' } });
  history.receive({ type: 'input_audio_buffer.committed', item_id: 'user-2' });
  history.receive({ type: 'response.output_item.added', item: { id: 'reply-2' } });
  history.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-2', transcript: 'Second' });
  history.receive({ type: 'response.output_audio_transcript.done', item_id: 'reply-1', transcript: 'First reply' });
  const first = history.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-1', transcript: 'First' });
  const second = history.receive({ type: 'response.output_audio_transcript.done', item_id: 'reply-2', transcript: 'Second reply' });
  assert.equal(first.transcript, 'First');
  assert.equal(first.reply, 'First reply');
  assert.equal(second.transcript, 'Second');
  assert.equal(second.reply, 'Second reply');
});