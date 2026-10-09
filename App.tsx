import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import Constants from 'expo-constants';
import { fetch } from 'expo/fetch';
import { File as ExpoFile, Paths } from 'expo-file-system';
import { LinearGradient } from 'expo-linear-gradient';
import * as Speech from 'expo-speech';
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Radio,
  AudioLines,
  Mic,
  MessageSquare,
  Send,
  RotateCcw,
  Square,
  Volume2,
} from 'lucide-react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import Slider from '@react-native-community/slider';
import RealtimeConversation from './RealtimeConversation';
import { AutoSpeechDetector } from './autoSpeech';

type Level = 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
type LanguageMode = 'Puhekieli' | 'Kirjakieli';
type ConversationMode = 'voice' | 'text' | 'realtime' | 'automatic';

type Turn = {
  id: string;
  transcript: string;
  correctedText: string;
  explanation: string;
  reply: string;
  translation: string;
};

type TutorResponse = Omit<Turn, 'id'>;
type Usage = {
  estimatedSpendUsd: number;
  budgetUsd: number;
  percentage: number;
  scope: string;
  transcriptionMinutes: number;
  completedTurns: number;
};

class TutorResponseError extends Error {}

const developmentHost = Constants.expoConfig?.hostUri?.split(':')[0] ?? 'localhost';
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? `http://${developmentHost}:8787`;
const APP_API_KEY = process.env.EXPO_PUBLIC_APP_API_KEY ?? '';
const LEVELS: Level[] = ['A2', 'B1', 'B2', 'C1', 'C2'];
const LANGUAGE_MODES: LanguageMode[] = ['Puhekieli', 'Kirjakieli'];
let webSpeechAudio: HTMLAudioElement | null = null;
let webSpeechRequest: AbortController | null = null;
const SPEECH_RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  directory: 'document' as const,
  numberOfChannels: 1,
  isMeteringEnabled: true,
  android: {
    ...RecordingPresets.HIGH_QUALITY.android,
    audioSource: 'unprocessed' as const,
  },
};

export default function App() {
  const recorder = useAudioRecorder(SPEECH_RECORDING_OPTIONS);
  const speechPlayer = useAudioPlayer(null);
  const recorderState = useAudioRecorderState(recorder, 100);
  const scrollRef = useRef<ScrollView>(null);
  const recordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopAndSendInProgressRef = useRef(false);
  const finnishVoiceRef = useRef<string | undefined>(undefined);
  const [level, setLevel] = useState<Level>('B2');
  const [languageMode, setLanguageMode] = useState<LanguageMode>('Puhekieli');
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const [conversations, setConversations] = useState<Record<ConversationMode, Turn[]>>({
    voice: [], text: [], automatic: [], realtime: [],
  });
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageUnavailable, setUsageUnavailable] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [conversationMode, setConversationMode] = useState<ConversationMode>('voice');
  const turns = conversations[conversationMode];
  function setTurns(update: Turn[] | ((current: Turn[]) => Turn[])) {
    const mode = conversationMode;
    setConversations((current) => ({
      ...current, [mode]: typeof update === 'function' ? update(current[mode]) : update,
    }));
  }
  const [draft, setDraft] = useState('');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [realtimeActive, setRealtimeActive] = useState(false);
  const textSendInProgressRef = useRef(false);
  const [autoPhase, setAutoPhase] = useState<'off' | 'ready' | 'listening' | 'thinking' | 'speaking'>('off');
  const [autoTimeoutSeconds, setAutoTimeoutSeconds] = useState(60);
  const [autoError, setAutoError] = useState('');
  const autoSessionRef = useRef<AbortController | null>(null);
  const autoDetectorRef = useRef(new AutoSpeechDetector());
  const startingRecordingRef = useRef(false);
  const requestingPermissionRef = useRef(false);
  const speechEpochRef = useRef(0);
  const playbackSubscriptionRef = useRef<{ remove: () => void } | null>(null);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background' && !requestingPermissionRef.current && autoSessionRef.current) void stopAutomatic();
    });
    return () => {
      subscription.remove();
      autoSessionRef.current?.abort();
      speechEpochRef.current += 1;
      playbackSubscriptionRef.current?.remove();
      void Speech.stop();
    };
  }, []);

  useEffect(() => {
    if (conversationMode !== 'text') {
      setKeyboardVisible(false);
      return;
    }
    const subscription = Keyboard.addListener('keyboardDidShow', () => {
      setKeyboardVisible(true);
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => { subscription.remove(); hidden.remove(); };
  }, [conversationMode]);

  useEffect(() => {
    if (autoPhase === 'ready' && !isProcessing && autoSessionRef.current) {
      void startRecording(autoSessionRef.current);
    }
  }, [autoPhase, isProcessing]);

  useEffect(() => {
    if (autoPhase !== 'listening' || !recorderState.isRecording || recorderState.durationMillis === 0 || !autoSessionRef.current
      || stopAndSendInProgressRef.current) return;
    try {
      const decision = autoDetectorRef.current.sample(recorderState.durationMillis, recorderState.metering);
      if (decision === 'send') {
        setAutoPhase('thinking');
        void stopAndSend(autoSessionRef.current);
      } else if (decision === 'discard') {
        void recycleAutomaticRecording(autoSessionRef.current);
      }
    } catch (error) {
      setAutoError(error instanceof Error ? error.message : 'Automatic recording failed.');
      void stopAutomatic();
      showError(error);
    }
  }, [autoPhase, recorderState]);

  async function recycleAutomaticRecording(session: AbortController) {
    if (session.signal.aborted || stopAndSendInProgressRef.current) return;
    stopAndSendInProgressRef.current = true;
    if (recordingTimeoutRef.current) clearTimeout(recordingTimeoutRef.current);
    recordingTimeoutRef.current = null;
    try {
      await recorder.stop();
      if (Platform.OS !== 'web' && recorder.uri) {
        const recording = new ExpoFile(recorder.uri);
        if (recording.exists) recording.delete();
      }
      if (!session.signal.aborted) setAutoPhase('ready');
    } catch (error) {
      if (!session.signal.aborted) {
        setAutoError(error instanceof Error ? error.message : 'Automatic recording could not restart.');
        void stopAutomatic();
      }
    } finally {
      stopAndSendInProgressRef.current = false;
    }
  }

  async function stopAutomatic() {
    autoSessionRef.current?.abort();
    autoSessionRef.current = null;
    setAutoPhase('off');
    if (recordingTimeoutRef.current) clearTimeout(recordingTimeoutRef.current);
    recordingTimeoutRef.current = null;
    await stopSpeaking();
    if (recorder.isRecording && !stopAndSendInProgressRef.current) {
      await recorder.stop();
      if (Platform.OS !== 'web' && recorder.uri) {
        const recording = new ExpoFile(recorder.uri);
        if (recording.exists) recording.delete();
      }
    }
  }

  function startAutomatic() {
    if (autoSessionRef.current || isProcessing || startingRecordingRef.current) return;
    if (Platform.OS === 'web') {
      showError(new Error('Auto puhe requires Android microphone metering. Use Puhe on the web.'));
      return;
    }
    autoSessionRef.current = new AbortController();
    setAutoError('');
    setAutoPhase('ready');
  }

  useEffect(() => {
    setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: 'doNotMix',
    }).catch(() => undefined);
    Speech.getAvailableVoicesAsync()
      .then((voices) => {
        const finnishVoices = voices.filter((voice) => voice.language.toLowerCase().startsWith('fi'));
        const selectedVoice = finnishVoices.find(
          (voice) => voice.language.toLowerCase() === 'fi-fi'
            && voice.quality === Speech.VoiceQuality.Enhanced,
        ) ?? finnishVoices.find(
          (voice) => voice.quality === Speech.VoiceQuality.Enhanced,
        ) ?? finnishVoices[0];
        finnishVoiceRef.current = selectedVoice?.identifier;
        console.info('Selected Finnish Android voice:', selectedVoice?.identifier ?? 'system default');
      })
      .catch(() => undefined);

    return () => {
      if (recordingTimeoutRef.current) {
        clearTimeout(recordingTimeoutRef.current);
      }
    };
  }, []);

  async function refreshUsage() {
    try {
      const response = await fetch(`${API_URL}/api/usage`, {
        headers: { 'X-App-Key': APP_API_KEY },
      });
      if (response.ok) {
        setUsage((await response.json()) as Usage);
        setUsageUnavailable(false);
      } else {
        setUsageUnavailable(true);
      }
    } catch {
      setUsageUnavailable(true);
    }
  }

  async function openBilling() {
    try {
      await Linking.openURL('https://platform.openai.com/settings/organization/billing/overview');
    } catch {
      Alert.alert('Could not open billing', 'Please open the OpenAI billing dashboard in your browser.');
    }
  }

  useEffect(() => {
    void refreshUsage();
    const usageInterval = setInterval(() => void refreshUsage(), 60_000);
    return () => clearInterval(usageInterval);
  }, []);

  async function startRecording(automatic?: AbortController) {
    const timeoutMillis = automatic ? autoTimeoutSeconds * 1000 : 60_000;
    if (stopAndSendInProgressRef.current || isProcessing || startingRecordingRef.current) {
      return;
    }
    startingRecordingRef.current = true;
    try {
      await stopSpeaking();
      requestingPermissionRef.current = true;
      let permission;
      try {
        permission = await AudioModule.requestRecordingPermissionsAsync();
      } finally {
        requestingPermissionRef.current = false;
      }
      if (!permission.granted) {
        if (automatic) void stopAutomatic();
        Alert.alert(
          'Microphone access needed',
          'Enable microphone access to practise speaking Finnish.',
        );
        return;
      }

      await setAudioModeAsync({ allowsRecording: true });
      if (automatic?.signal.aborted) return;
      await recorder.prepareToRecordAsync(SPEECH_RECORDING_OPTIONS);
      if (automatic?.signal.aborted) {
        await recorder.stop();
        return;
      }
      recorder.record();
      if (automatic) {
        autoDetectorRef.current = new AutoSpeechDetector(timeoutMillis);
        setAutoPhase('listening');
      }
      recordingTimeoutRef.current = setTimeout(() => {
        recordingTimeoutRef.current = null;
        if (automatic) {
          if (automatic.signal.aborted) return;
          try {
            if (autoDetectorRef.current.sample(timeoutMillis, recorder.getStatus().metering) === 'send') {
              setAutoPhase('thinking');
              void stopAndSend(automatic);
            } else void recycleAutomaticRecording(automatic);
          } catch (error) {
            void stopAutomatic();
            showError(error);
          }
        } else void stopAndSend();
      }, timeoutMillis);
    } catch (error) {
      if (automatic) {
        setAutoError(error instanceof Error ? error.message : 'Automatic recording could not start.');
        void stopAutomatic();
      }
      showError(error);
    } finally {
      startingRecordingRef.current = false;
    }
  }

  async function stopAndSend(automatic?: AbortController) {
    if (stopAndSendInProgressRef.current) {
      return;
    }
    stopAndSendInProgressRef.current = true;
    setIsProcessing(true);
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }

    let recordingFile: ExpoFile | null = null;
    let requestStarted = false;
    try {
      const audioDurationMs = recorder.getStatus().durationMillis;
      await recorder.stop();
      const audioUri = recorder.uri;
      if (!audioUri) {
        throw new Error('The recording could not be saved. Please try again.');
      }

      const formData = new FormData();
      if (Platform.OS === 'web') {
        const audioBlob = await globalThis.fetch(audioUri).then((response) => response.blob());
        formData.append('audio', audioBlob, 'speech.webm');
      } else {
        recordingFile = new ExpoFile(audioUri);
        if (!recordingFile.exists || recordingFile.size === 0) {
          throw new Error('The recording file was lost. Please record again.');
        }
        formData.append('audio', recordingFile);
      }
      formData.append('topic', 'Arki');
      formData.append('level', level);
      formData.append('languageMode', languageMode);
      formData.append('audioDurationMs', `${audioDurationMs}`);
      formData.append(
        'history',
        JSON.stringify(turns.slice(-4).map(({ transcript, reply }) => ({ transcript, reply }))),
      );

      requestStarted = true;
      const response = await fetch(`${API_URL}/api/conversation`, {
        method: 'POST',
        headers: { 'X-App-Key': APP_API_KEY },
        body: formData,
        signal: automatic?.signal,
      });
      const result = (await response.json()) as TutorResponse | { error: string };
      if (!response.ok || 'error' in result) {
        throw new TutorResponseError('error' in result ? result.error : 'The tutor could not answer.');
      }
      if (automatic?.signal.aborted) return;

      const turn = { ...result, id: `${Date.now()}` };
      setTurns((current) => [...current, turn]);
      void refreshUsage();
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: 'doNotMix',
        shouldRouteThroughEarpiece: false,
      });
      if (automatic?.signal.aborted) return;
      if (automatic) setAutoPhase('speaking');
      speak(turn.reply, automatic ? () => {
        if (!automatic.signal.aborted) setAutoPhase('ready');
      } : undefined);
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    } catch (error) {
      if (!automatic?.signal.aborted) {
        if (automatic && error instanceof TutorResponseError && error.message === 'No Finnish speech was detected. Please try again.') {
          setAutoPhase('ready');
          void refreshUsage();
        } else {
          if (automatic) void stopAutomatic();
          showError(error, requestStarted);
        }
      }
    } finally {
      stopAndSendInProgressRef.current = false;
      setIsProcessing(false);
      if (recordingFile?.exists) {
        try {
          recordingFile.delete();
        } catch {
        }
      }
    }
  }

  async function sendText() {
    const text = draft.trim();
    if (!text || isProcessing || textSendInProgressRef.current) {
      return;
    }
    textSendInProgressRef.current = true;
    setIsProcessing(true);
    Keyboard.dismiss();
    try {
      const formData = new FormData();
      formData.append('text', text);
      formData.append('topic', 'Arki');
      formData.append('level', level);
      formData.append('languageMode', languageMode);
      formData.append(
        'history',
        JSON.stringify(turns.slice(-4).map(({ transcript, reply }) => ({ transcript, reply }))),
      );
      const response = await fetch(`${API_URL}/api/conversation`, {
        method: 'POST',
        headers: { 'X-App-Key': APP_API_KEY },
        body: formData,
      });
      const result = (await response.json()) as TutorResponse | { error: string };
      if (!response.ok || 'error' in result) {
        throw new TutorResponseError('error' in result ? result.error : 'The tutor could not answer.');
      }
      setTurns((current) => [...current, { ...result, id: `${Date.now()}` }]);
      setDraft('');
      void refreshUsage();
    } catch (error) {
      showError(error, true);
    } finally {
      textSendInProgressRef.current = false;
      setIsProcessing(false);
    }
  }

  async function switchConversationMode(mode: ConversationMode) {
    if ((!autoSessionRef.current && (isProcessing || recorderState.isRecording)) || mode === conversationMode) {
      return;
    }
    if (autoSessionRef.current) await stopAutomatic();
    await stopSpeaking();
    Keyboard.dismiss();
    setConversationMode(mode);
  }

  function showError(error: unknown, requestStarted = false) {
    const message = error instanceof Error ? error.message : 'Something went wrong.';
    const apiHint = !requestStarted || error instanceof TutorResponseError
      ? ''
      : `\n\nCheck that the tutor API is running at ${API_URL}.`;
    Alert.alert('Could not continue', `${message}${apiHint}`);
  }

  async function stopSpeaking() {
    speechEpochRef.current += 1;
    playbackSubscriptionRef.current?.remove();
    playbackSubscriptionRef.current = null;
    if (Platform.OS === 'web') {
      webSpeechRequest?.abort();
      webSpeechRequest = null;
      if (webSpeechAudio) {
        webSpeechAudio.pause();
        URL.revokeObjectURL(webSpeechAudio.src);
        webSpeechAudio = null;
      }
      return;
    }
    speechPlayer.pause();
    await Speech.stop();
  }

  async function restartConversation() {
    if (autoSessionRef.current) await stopAutomatic();
    await stopSpeaking();
    setTurns([]);
    setDraft('');
  }

  function speak(text: string, onComplete?: () => void) {
    const playbackFailed = (error: unknown) => {
      console.warn('Finnish playback failed.', error);
      if (onComplete && autoSessionRef.current) {
        void stopAutomatic();
        showError(error);
      }
    };
    if (Platform.OS === 'web') {
      void stopSpeaking().then(async () => {
        const request = new AbortController();
        webSpeechRequest = request;
        const response = await fetch(`${API_URL}/api/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: request.signal,
        });
        if (!response.ok) {
          throw new Error('Finnish speech playback is unavailable.');
        }
        const audioUrl = URL.createObjectURL(await response.blob());
        if (webSpeechRequest !== request) {
          URL.revokeObjectURL(audioUrl);
          return;
        }
        webSpeechRequest = null;
        const audio = new Audio(audioUrl);
        webSpeechAudio = audio;
        const releaseAudio = () => {
          URL.revokeObjectURL(audioUrl);
          if (webSpeechAudio === audio) {
            webSpeechAudio = null;
          }
        };
        audio.onended = releaseAudio;
        audio.onerror = releaseAudio;
        await audio.play();
      }).catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          showError(error);
        }
      });
      return;
    }
    if (!finnishVoiceRef.current) {
      void stopSpeaking().then(() => playNeuralSpeech(text, onComplete)).catch(playbackFailed);
      return;
    }
    void stopSpeaking().then(() => {
      const epoch = speechEpochRef.current;
      let fallbackStarted = false;
      let speechStarted = false;
      const fallbackToNeuralSpeech = () => {
        if (fallbackStarted || speechStarted || epoch !== speechEpochRef.current) {
          return;
        }
        fallbackStarted = true;
        console.warn('Android speech did not start; trying neural audio.');
        void Speech.stop().then(() => playNeuralSpeech(text, onComplete)).catch(playbackFailed);
      };
      const fallbackTimer = setTimeout(fallbackToNeuralSpeech, 3000);
      Speech.speak(text, {
        language: 'fi-FI',
        pitch: 1,
        rate: 0.86,
        volume: 1,
        voice: finnishVoiceRef.current,
        onStart: () => {
          speechStarted = true;
          clearTimeout(fallbackTimer);
          console.info('Finnish Android speech started.');
        },
        onDone: () => {
          clearTimeout(fallbackTimer);
          console.info('Finnish Android speech finished.');
          if (epoch === speechEpochRef.current && !fallbackStarted) onComplete?.();
        },
        onError: (error) => {
          clearTimeout(fallbackTimer);
          if (epoch !== speechEpochRef.current || fallbackStarted) return;
          console.warn('Android Finnish speech failed; trying neural audio.', error);
          fallbackStarted = true;
          void playNeuralSpeech(text, onComplete).catch(playbackFailed);
        },
      });
    }).catch((error: unknown) => {
      console.warn('Android speech setup failed; trying neural audio.', error);
      void playNeuralSpeech(text, onComplete).catch(playbackFailed);
    });
  }

  async function playNeuralSpeech(text: string, onComplete?: () => void) {
    const epoch = speechEpochRef.current;
    const response = await fetch(`${API_URL}/api/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-App-Key': APP_API_KEY,
      },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      throw new Error('Finnish neural speech is unavailable.');
    }
    if (epoch !== speechEpochRef.current) return;
    const speechFile = new ExpoFile(Paths.cache, `kielikaveri-speech-${Date.now()}.wav`);
    const audioBytes = await response.bytes();
    if (epoch !== speechEpochRef.current) return;
    speechFile.write(audioBytes);
    speechPlayer.volume = 1;
    speechPlayer.replace(speechFile.uri);
    for (let attempt = 0; attempt < 100 && !speechPlayer.isLoaded; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!speechPlayer.isLoaded) {
      throw new Error('Finnish neural speech could not be loaded.');
    }
    if (epoch !== speechEpochRef.current) return;
    playbackSubscriptionRef.current = speechPlayer.addListener('playbackStatusUpdate', (status) => {
      if (status.didJustFinish || status.error) {
        playbackSubscriptionRef.current?.remove();
        playbackSubscriptionRef.current = null;
        if (speechFile.exists) speechFile.delete();
        if (epoch !== speechEpochRef.current) return;
        if (status.error) {
          if (onComplete) void stopAutomatic();
          showError(new Error(status.error));
        } else onComplete?.();
      }
    });
    speechPlayer.play();
  }

  const seconds = Math.floor(recorderState.durationMillis / 1000);
  const openingQuestion = languageMode === 'Puhekieli'
    ? 'Moi! Mitä sulle kuuluu tänään?'
    : 'Hei! Mitä sinulle kuuluu tänään?';

  return (
    <SafeAreaProvider>
      <LinearGradient colors={['#F4F0E6', '#F8FAF4', '#E6F2ED']} style={styles.background}>
        <StatusBar style="dark" />
        <SafeAreaView edges={conversationMode === 'realtime' ? undefined : ['top', 'left', 'right']} style={styles.safeArea}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.safeArea}
          >
          <View style={styles.header}>
            <View>
              <Text style={styles.eyebrow}>PUHEKAVERI</Text>
              <Text style={styles.title}>{conversationMode === 'text' ? 'Finnish, in words.' : 'Finnish, out loud.'}</Text>
            </View>
            <View style={styles.headerActions}>
              <View accessibilityRole="tablist" style={styles.conversationSelector}>
                {(['voice', 'text', 'automatic', 'realtime'] as const).map((mode) => (
                  <Pressable
                    key={mode}
                    accessibilityRole="tab"
                    accessibilityLabel={mode === 'voice' ? 'Voice conversation' : mode === 'text' ? 'Written conversation' : mode === 'automatic' ? 'Automatic voice conversation' : 'Realtime voice conversation'}
                    accessibilityState={{ selected: conversationMode === mode }}
                    disabled={!autoSessionRef.current && (isProcessing || recorderState.isRecording)}
                    onPress={() => void switchConversationMode(mode)}
                    style={[styles.conversationTab, (mode === 'automatic' || mode === 'realtime') && styles.longConversationTab, conversationMode === mode && styles.compactButtonActive]}
                  >
                    {mode === 'voice'
                      ? <Mic size={16} color={conversationMode === mode ? '#FFFDF7' : '#31564D'} />
                      : mode === 'text'
                        ? <MessageSquare size={16} color={conversationMode === mode ? '#FFFDF7' : '#31564D'} />
                        : mode === 'automatic'
                          ? <AudioLines size={16} color={conversationMode === mode ? '#FFFDF7' : '#31564D'} />
                          : <Radio size={16} color={conversationMode === mode ? '#FFFDF7' : '#31564D'} />}
                    <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={[styles.compactText, styles.conversationTabText, conversationMode === mode && styles.compactTextActive]}>
                      {mode === 'voice' ? 'Puhe' : mode === 'text' ? 'Viestit' : mode === 'automatic' ? 'Auto puhe' : 'RT puhe'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>

            {!keyboardVisible && <View accessibilityLabel="OpenAI spending" style={styles.usagePanel}>
              <View style={styles.usageHeader}>
                <Text style={styles.usageLabel}>
                  {usage?.scope === 'OpenAI Platform, current month' ? 'KULUT TÄSSÄ KUUSSA' : 'SOVELLUKSEN KULUARVIO'}
                </Text>
                <View style={styles.usageActions}>
                  <Text style={styles.usageValue}>
                    {usage ? `$${usage.estimatedSpendUsd.toFixed(2)}` : usageUnavailable ? 'Ei saatavilla' : '...'}
                  </Text>
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel="Open OpenAI billing dashboard"
                    onPress={() => void openBilling()}
                    style={styles.billingButton}
                  >
                    <ExternalLink color="#31564D" size={18} />
                  </Pressable>
                </View>
              </View>
              {usage && <View style={styles.usageTrack}>
                <View style={[styles.usageFill, {
                  width: `${Math.max(0, Math.min(100, usage.percentage))}%`,
                }]} />
              </View>}
              <Text style={styles.usageScope}>
                {usage
                  ? `${usage.scope === 'OpenAI Platform, current month' ? 'OpenAI-organisaatio' : 'Vain tämä sovellus'} · budjetti $${usage.budgetUsd.toFixed(2)}${usageUnavailable ? ' · vanhentunut' : ''}`
                  : 'OpenAI'}
              </Text>
            </View>}

          {!keyboardVisible && <View style={styles.practiceSettings}>
            <Pressable
              accessibilityLabel={settingsExpanded ? 'Collapse practice settings' : 'Expand practice settings'}
              accessibilityRole="button"
              accessibilityState={{ expanded: settingsExpanded }}
              onPress={() => setSettingsExpanded((current) => !current)}
              style={({ pressed }) => [styles.settingsToggle, pressed && styles.settingsTogglePressed]}
            >
              <Text style={styles.settingsSummary}>TASO {level} · TYYLI {languageMode}</Text>
              {settingsExpanded
                ? <ChevronUp color="#31564D" size={20} />
                : <ChevronDown color="#31564D" size={20} />}
            </Pressable>

            {settingsExpanded && (
              <View style={styles.expandedSettings}>
                <View style={styles.settingRow}>
                  <Text style={styles.settingLabel}>TASO</Text>
                  <View accessibilityRole="tablist" style={styles.compactSelector}>
                    {LEVELS.map((item) => (
                      <Pressable
                        accessibilityRole="tab"
                        accessibilityState={{ selected: level === item }}
                        disabled={isProcessing || recorderState.isRecording || realtimeActive || autoPhase !== 'off'}
                        key={item}
                        onPress={() => setLevel(item)}
                        style={[styles.compactButton, level === item && styles.compactButtonActive]}
                      >
                        <Text style={[styles.compactText, level === item && styles.compactTextActive]}>
                          {item}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>

                <View style={styles.settingRow}>
                  <Text style={styles.settingLabel}>TYYLI</Text>
                  <View accessibilityRole="tablist" style={styles.compactSelector}>
                    {LANGUAGE_MODES.map((item) => (
                      <Pressable
                        accessibilityRole="tab"
                        accessibilityState={{ selected: languageMode === item }}
                        disabled={isProcessing || recorderState.isRecording || realtimeActive || autoPhase !== 'off'}
                        key={item}
                        onPress={() => setLanguageMode(item)}
                        style={[styles.modeButton, languageMode === item && styles.compactButtonActive]}
                      >
                        <Text
                          style={[styles.compactText, languageMode === item && styles.compactTextActive]}
                        >
                          {item}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              </View>
            )}
          </View>}

          {conversationMode === 'automatic' && <View style={styles.automaticTimeout}>
            <Text style={styles.automaticTimeoutLabel}>Vastausaika: {autoTimeoutSeconds} s</Text>
            <Slider
              accessibilityLabel="Automatic reply timeout"
              minimumValue={10}
              maximumValue={60}
              step={1}
              value={autoTimeoutSeconds}
              onValueChange={setAutoTimeoutSeconds}
              minimumTrackTintColor="#31564D"
              maximumTrackTintColor="#DDECE6"
              thumbTintColor="#31564D"
              style={styles.automaticTimeoutSlider}
            />
          </View>}

          {conversationMode === 'realtime' ? (
            <RealtimeConversation
              apiUrl={API_URL}
              appKey={APP_API_KEY}
              level={level}
              languageMode={languageMode}
              history={turns}
              onActiveChange={setRealtimeActive}
              onTurn={(transcript, reply) => {
                setTurns((current) => [...current, {
                  id: `${Date.now()}`, transcript, reply,
                  correctedText: transcript, explanation: '', translation: '',
                }]);
                void refreshUsage();
              }}
            />
          ) : <>
          <ScrollView
            style={styles.conversationScroll}
            contentContainerStyle={styles.conversation}
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
            onLayout={() => scrollRef.current?.scrollToEnd({ animated: false })}
            ref={scrollRef}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.tutorMessage}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>K</Text>
              </View>
              <View style={styles.messageBody}>
                <Text style={styles.speaker}>KIELIKAVERI</Text>
                <Text style={styles.reply}>{openingQuestion}</Text>
                <Text style={styles.translation}>Hi! How are you today?</Text>
                {conversationMode === 'voice' && <Pressable
                  accessibilityLabel="Play the opening tutor message"
                  hitSlop={12}
                  onPress={() => speak(openingQuestion)}
                  style={styles.replayButton}
                >
                  <Volume2 color="#165B4D" size={19} />
                </Pressable>}
              </View>
            </View>

            {turns.map((turn) => (
              <View key={turn.id} style={styles.turnBlock}>
                <View style={styles.userMessage}>
                  <Text style={styles.speakerLight}>{conversationMode === 'voice' ? 'SINÄ SANOIT' : 'SINÄ'}</Text>
                  <Text style={styles.userText}>{turn.transcript}</Text>
                </View>

                {turn.explanation !== '' && <View style={styles.feedback}>
                  <Text style={styles.feedbackLabel}>
                    {turn.correctedText === turn.transcript ? 'HYVIN SANOTTU' : 'KORJAUS'}
                  </Text>
                  <Text style={styles.correctedText}>{turn.correctedText}</Text>
                  <Text style={styles.explanation}>{turn.explanation}</Text>
                </View>}

                <View style={styles.tutorMessage}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>K</Text>
                  </View>
                  <View style={styles.messageBody}>
                    <Text style={styles.speaker}>KIELIKAVERI</Text>
                    <Text style={styles.reply}>{turn.reply}</Text>
                    <Text style={styles.translation}>{turn.translation}</Text>
                    {conversationMode === 'voice' && <Pressable
                      accessibilityLabel="Play the tutor reply again"
                      hitSlop={12}
                      onPress={() => speak(turn.reply)}
                      style={styles.replayButton}
                    >
                      <Volume2 color="#165B4D" size={19} />
                    </Pressable>}
                  </View>
                </View>
              </View>
            ))}

            {isProcessing && (
              <View style={styles.thinkingRow}>
                <ActivityIndicator color="#165B4D" />
                <Text style={styles.thinkingText}>{conversationMode === 'voice' ? 'Kuuntelen ja mietin...' : 'Mietin vastausta...'}</Text>
              </View>
            )}
          </ScrollView>

          <SafeAreaView
            accessibilityLabel="Conversation controls"
            edges={conversationMode === 'text' && keyboardVisible ? [] : ['bottom']}
            style={[styles.controls, conversationMode === 'text' && keyboardVisible && styles.writtenKeyboardControls]}
          >
            {conversationMode === 'text' ? (
              <View style={styles.writtenControls}>
                <View style={styles.composer}>
                  <TextInput
                    accessibilityLabel="Written Finnish message"
                    placeholder="Viesti suomeksi..."
                    placeholderTextColor="#71847E"
                    value={draft}
                    onChangeText={setDraft}
                    editable={!isProcessing}
                    multiline
                    maxLength={4000}
                    style={styles.textInput}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Send written message"
                    disabled={!draft.trim() || isProcessing}
                    onPress={() => void sendText()}
                    style={[styles.sendButton, (!draft.trim() || isProcessing) && styles.disabled]}
                  >
                    {isProcessing
                      ? <ActivityIndicator color="#FFFDF7" />
                      : <Send color="#FFFDF7" size={21} />}
                  </Pressable>
                </View>
                <Pressable
                  accessibilityLabel="Start a new conversation"
                  disabled={isProcessing}
                  onPress={() => void restartConversation()}
                  style={styles.writtenRestart}
                >
                  <RotateCcw color="#31564D" size={17} />
                  <Text style={styles.restartButtonText}>Uusi keskustelu</Text>
                </Pressable>
              </View>
            ) : conversationMode === 'automatic' ? <>
              {autoError !== '' && <Text accessibilityRole="alert" style={styles.automaticError}>{autoError}</Text>}
              <Text accessibilityLiveRegion="polite" style={styles.recordingHint}>
                {autoPhase === 'listening' ? 'Kuuntelen...' : autoPhase === 'thinking' ? 'Rakennan vastausta' : autoPhase === 'speaking' ? 'Kielikaveri puhuu...' : autoPhase === 'ready' ? 'Valmistaudutaan...' : 'Valmis'}
              </Text>
              <View style={styles.automaticControlRow}>
                <Pressable accessibilityRole="button" accessibilityLabel={autoPhase === 'off' ? 'Start automatic conversation' : 'Stop automatic conversation'}
                  disabled={autoPhase === 'off' && isProcessing}
                  onPress={() => autoPhase === 'off' ? startAutomatic() : void stopAutomatic()}
                  style={[styles.automaticButton, autoPhase !== 'off' && styles.compactButtonActive]}>
                  {autoPhase === 'off' ? <AudioLines color="#31564D" size={20} /> : <Square color="#FFFDF7" size={20} />}
                  <Text style={[styles.restartButtonText, autoPhase !== 'off' && styles.compactTextActive]}>{autoPhase === 'off' ? 'Aloita Auto puhe' : 'Lopeta'}</Text>
                </Pressable>
                <Pressable accessibilityLabel="Start a new conversation" disabled={isProcessing} onPress={() => void restartConversation()} style={styles.automaticButton}>
                  <RotateCcw color="#31564D" size={17} />
                  <Text style={styles.restartButtonText}>Uusi keskustelu</Text>
                </Pressable>
              </View>
            </> : <>
            <Text style={styles.recordingHint}>
              {recorderState.isRecording
                ? `Puhut nyt  0:${seconds.toString().padStart(2, '0')}`
                : isProcessing
                  ? 'Rakennan vastausta'
                  : 'Napauta ja puhu suomea'}
            </Text>
            <View style={styles.controlRow}>
              <Pressable
                accessibilityLabel={recorderState.isRecording ? 'Stop recording' : 'Start recording'}
                disabled={isProcessing}
                onPress={() => recorderState.isRecording ? void stopAndSend() : void startRecording()}
                style={({ pressed }) => [
                  styles.micButton,
                  recorderState.isRecording && styles.micButtonRecording,
                  pressed && styles.micButtonPressed,
                  isProcessing && styles.disabled,
                ]}
              >
                {isProcessing ? (
                  <ActivityIndicator color="#FFFDF7" size="large" />
                ) : recorderState.isRecording ? (
                  <Square color="#FFFDF7" fill="#FFFDF7" size={28} />
                ) : (
                  <Mic color="#FFFDF7" size={34} strokeWidth={2.2} />
                )}
              </Pressable>
              <Pressable
                accessibilityLabel="Start a new conversation"
                disabled={isProcessing || recorderState.isRecording}
                onPress={() => void restartConversation()}
                style={({ pressed }) => [
                  styles.restartButton,
                  pressed && styles.restartButtonPressed,
                  (isProcessing || recorderState.isRecording) && styles.disabled,
                ]}
              >
                <RotateCcw color="#31564D" size={17} />
                <Text style={styles.restartButtonText}>Uusi keskustelu</Text>
              </Pressable>
            </View>
            </>}
          </SafeAreaView>
          </>}
          </KeyboardAvoidingView>
        </SafeAreaView>
      </LinearGradient>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  automaticTimeout: { width: '100%', maxWidth: 400, alignSelf: 'center', paddingHorizontal: 24 },
  automaticTimeoutLabel: { color: '#587068', fontSize: 12, fontWeight: '700' },
  automaticTimeoutSlider: { width: '100%', height: 40 },
  background: { flex: 1 },
  safeArea: { flex: 1 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingBottom: 18,
    paddingTop: Platform.OS === 'android' ? 46 : 12,
  },
  eyebrow: { color: '#C64B38', fontSize: 11, fontWeight: '800', letterSpacing: 0 },
  title: { color: '#173E35', fontFamily: 'serif', fontSize: 31, fontWeight: '700', marginTop: 3 },
  headerActions: {
    alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between',
    gap: 8, width: '100%',
  },
  conversationSelector: {
    flex: 1, minWidth: 0, flexDirection: 'row', backgroundColor: '#DDECE6', borderRadius: 8, padding: 2,
  },
  conversationTab: {
    flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 3, minHeight: 36, paddingHorizontal: 3, borderRadius: 6,
  },
  longConversationTab: { flex: 1.3 },
  conversationTabText: { fontSize: 11, flexShrink: 1 },
  conversationScroll: { flex: 1 },
  writtenControls: { width: '100%', paddingHorizontal: 22, gap: 10 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  textInput: {
    flex: 1, minHeight: 48, maxHeight: 120, borderColor: '#B8C7C1', borderWidth: 1,
    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16,
    color: '#173E35', backgroundColor: '#FFFDF7', textAlignVertical: 'top',
  },
  sendButton: {
    width: 48, height: 48, borderRadius: 8, backgroundColor: '#165B4D',
    alignItems: 'center', justifyContent: 'center',
  },
  writtenRestart: {
    alignSelf: 'flex-end', flexDirection: 'row', alignItems: 'center',
    gap: 5, minHeight: 36,
  },
  usagePanel: { paddingBottom: 10, paddingHorizontal: 22 },
  usageHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  usageActions: { alignItems: 'center', flexDirection: 'row', gap: 6 },
  billingButton: { alignItems: 'center', justifyContent: 'center', height: 36, width: 36 },
  usageLabel: { color: '#587068', fontSize: 9, fontWeight: '900' },
  usageValue: { color: '#31564D', fontSize: 11, fontWeight: '800' },
  usageTrack: { backgroundColor: '#DCE5DE', borderRadius: 3, height: 5, marginTop: 5, overflow: 'hidden' },
  usageFill: { backgroundColor: '#C64B38', borderRadius: 3, height: '100%' },
  usageScope: { color: '#84958F', fontSize: 9, marginTop: 3 },
  practiceSettings: { paddingBottom: 8, paddingHorizontal: 22 },
  settingsToggle: {
    alignItems: 'center',
    borderBottomColor: '#D8DED5',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 36,
  },
  settingsTogglePressed: { opacity: 0.65 },
  settingsSummary: { color: '#31564D', fontSize: 11, fontWeight: '900' },
  expandedSettings: { gap: 8, paddingTop: 8 },
  settingRow: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  settingLabel: { color: '#587068', fontSize: 10, fontWeight: '900', width: 38 },
  compactSelector: {
    backgroundColor: 'rgba(255,255,255,0.62)',
    borderColor: '#D8DED5',
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    padding: 3,
  },
  compactButton: {
    alignItems: 'center',
    borderRadius: 6,
    flex: 1,
    minHeight: 30,
    justifyContent: 'center',
  },
  modeButton: {
    alignItems: 'center',
    borderRadius: 6,
    flex: 1,
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  compactButtonActive: { backgroundColor: '#173E35' },
  compactText: { color: '#587068', fontSize: 12, fontWeight: '800' },
  compactTextActive: { color: '#FFFDF7' },
  conversation: { gap: 20, paddingHorizontal: 22, paddingBottom: 28, paddingTop: 14 },
  tutorMessage: { alignItems: 'flex-start', flexDirection: 'row', gap: 12, maxWidth: '92%' },
  avatar: {
    alignItems: 'center',
    backgroundColor: '#F7C948',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  avatarText: { color: '#173E35', fontFamily: 'serif', fontSize: 21, fontWeight: '800' },
  messageBody: { flex: 1, paddingTop: 3 },
  speaker: { color: '#4E766B', fontSize: 10, fontWeight: '800', letterSpacing: 0 },
  reply: { color: '#173E35', fontFamily: 'serif', fontSize: 22, lineHeight: 29, marginTop: 4 },
  translation: { color: '#71847E', fontSize: 13, fontStyle: 'italic', marginTop: 5 },
  turnBlock: { gap: 17 },
  userMessage: {
    alignSelf: 'flex-end',
    backgroundColor: '#165B4D',
    borderRadius: 8,
    maxWidth: '84%',
    paddingHorizontal: 17,
    paddingVertical: 13,
  },
  speakerLight: { color: '#A9D8CC', fontSize: 10, fontWeight: '800', letterSpacing: 0 },
  userText: { color: '#FFFDF7', fontSize: 17, lineHeight: 24, marginTop: 4 },
  feedback: {
    alignSelf: 'flex-end',
    backgroundColor: '#FFF8DD',
    borderColor: '#E9C453',
    borderLeftWidth: 3,
    borderRadius: 6,
    maxWidth: '84%',
    padding: 13,
  },
  feedbackLabel: { color: '#9B661D', fontSize: 10, fontWeight: '900', letterSpacing: 0 },
  correctedText: { color: '#433611', fontSize: 16, fontWeight: '700', marginTop: 5 },
  explanation: { color: '#735F2C', fontSize: 13, lineHeight: 19, marginTop: 4 },
  replayButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: '#DDECE6',
    borderRadius: 20,
    height: 36,
    justifyContent: 'center',
    marginTop: 9,
    width: 36,
  },
  thinkingRow: { alignItems: 'center', flexDirection: 'row', gap: 10, paddingLeft: 56 },
  thinkingText: { color: '#4E766B', fontSize: 14, fontStyle: 'italic' },
  controls: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,253,247,0.88)',
    borderColor: '#DCE3DC',
    borderTopWidth: 1,
    paddingBottom: Platform.OS === 'ios' ? 12 : 18,
    paddingTop: 12,
  },
  recordingHint: { color: '#587068', fontSize: 12, fontWeight: '700', marginBottom: 10 },
  writtenKeyboardControls: { paddingBottom: 6 },
  controlRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    position: 'relative',
    width: '100%',
  },
  automaticControlRow: {
    width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center',
    alignItems: 'center', paddingHorizontal: 20, gap: 12,
  },
  automaticError: { color: '#9B3024', fontSize: 13, textAlign: 'center', paddingHorizontal: 20, marginBottom: 10 },
  automaticButton: {
    minHeight: 48, paddingHorizontal: 12, borderWidth: 1, borderColor: '#B8C7C1',
    borderRadius: 6, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8,
  },
  micButton: {
    alignItems: 'center',
    backgroundColor: '#C64B38',
    borderRadius: 38,
    height: 76,
    justifyContent: 'center',
    width: 76,
  },
  micButtonRecording: { backgroundColor: '#173E35' },
  micButtonPressed: { opacity: 0.82, transform: [{ scale: 0.97 }] },
  disabled: { opacity: 0.55 },
  restartButton: {
    alignItems: 'center',
    borderColor: '#B8C7C1',
    borderRadius: 6,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 5,
    justifyContent: 'center',
    minHeight: 36,
    paddingHorizontal: 8,
    position: 'absolute',
    right: 10,
  },
  restartButtonPressed: { backgroundColor: '#E3ECE7' },
  restartButtonText: { color: '#31564D', fontSize: 11, fontWeight: '800' },
});
