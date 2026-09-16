import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
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
import { Mic, RotateCcw, Sparkles, Square, Volume2 } from 'lucide-react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

type Topic = 'Arki' | 'Kahvila' | 'Työ';
type Level = 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
type LanguageMode = 'Puhekieli' | 'Kirjakieli';

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
const TOPICS: Topic[] = ['Arki', 'Kahvila', 'Työ'];
const LEVELS: Level[] = ['A2', 'B1', 'B2', 'C1', 'C2'];
const LANGUAGE_MODES: LanguageMode[] = ['Puhekieli', 'Kirjakieli'];
let webSpeechAudio: HTMLAudioElement | null = null;
let webSpeechRequest: AbortController | null = null;
const SPEECH_RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
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
  const finnishVoiceRef = useRef<string | undefined>(undefined);
  const [topic, setTopic] = useState<Topic>('Arki');
  const [level, setLevel] = useState<Level>('B2');
  const [languageMode, setLanguageMode] = useState<LanguageMode>('Puhekieli');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: 'doNotMix',
    }).catch(() => undefined);
    Speech.getAvailableVoicesAsync()
      .then((voices) => {
        const finnishVoices = voices.filter((voice) => voice.language.toLowerCase().startsWith('fi'));
        finnishVoiceRef.current = (
          finnishVoices.find((voice) => voice.quality === Speech.VoiceQuality.Enhanced)
          ?? finnishVoices[0]
        )?.identifier;
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
      }
    } catch {
    }
  }

  useEffect(() => {
    void refreshUsage();
    const usageInterval = setInterval(() => void refreshUsage(), 60_000);
    return () => clearInterval(usageInterval);
  }, []);

  async function startRecording() {
    try {
      await stopSpeaking();
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Microphone access needed',
          'Enable microphone access to practise speaking Finnish.',
        );
        return;
      }

      await setAudioModeAsync({ allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordingTimeoutRef.current = setTimeout(() => {
        recordingTimeoutRef.current = null;
        void stopAndSend();
      }, 60_000);
    } catch (error) {
      showError(error);
    }
  }

  async function stopAndSend() {
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }

    try {
      const audioDurationMs = recorderState.durationMillis;
      await recorder.stop();
      const audioUri = recorder.uri;
      if (!audioUri) {
        throw new Error('The recording could not be saved. Please try again.');
      }

      setIsProcessing(true);
      const formData = new FormData();
      if (Platform.OS === 'web') {
        const audioBlob = await globalThis.fetch(audioUri).then((response) => response.blob());
        formData.append('audio', audioBlob, 'speech.webm');
      } else {
        formData.append('audio', new ExpoFile(audioUri));
      }
      formData.append('topic', topic);
      formData.append('level', level);
      formData.append('languageMode', languageMode);
      formData.append('audioDurationMs', `${audioDurationMs}`);
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

      const turn = { ...result, id: `${Date.now()}` };
      setTurns((current) => [...current, turn]);
      void refreshUsage();
      await setAudioModeAsync({ allowsRecording: false });
      speak(turn.reply);
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
    } catch (error) {
      showError(error);
    } finally {
      setIsProcessing(false);
    }
  }

  function showError(error: unknown) {
    const message = error instanceof Error ? error.message : 'Something went wrong.';
    const apiHint = error instanceof TutorResponseError
      ? ''
      : `\n\nCheck that the tutor API is running at ${API_URL}.`;
    Alert.alert('Could not continue', `${message}${apiHint}`);
  }

  async function stopSpeaking() {
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
    await stopSpeaking();
    setTurns([]);
  }

  function speak(text: string) {
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
    void stopSpeaking().then(async () => {
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
      const speechFile = new ExpoFile(Paths.cache, 'kielikaveri-speech.wav');
      speechFile.write(await response.bytes());
      speechPlayer.replace(speechFile.uri);
      speechPlayer.play();
    }).catch(() => {
      Speech.speak(text, {
        language: 'fi-FI',
        pitch: 1,
        rate: 0.9,
        voice: finnishVoiceRef.current,
      });
    });
  }

  const seconds = Math.floor(recorderState.durationMillis / 1000);
  const openingQuestion = languageMode === 'Puhekieli'
    ? 'Moi! Mitä sulle kuuluu tänään?'
    : 'Hei! Mitä sinulle kuuluu tänään?';

  return (
    <SafeAreaProvider>
      <LinearGradient colors={['#F4F0E6', '#F8FAF4', '#E6F2ED']} style={styles.background}>
        <StatusBar style="dark" />
        <SafeAreaView style={styles.safeArea}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.safeArea}
          >
          <View style={styles.header}>
            <View>
              <Text style={styles.eyebrow}>PUHEKAVERI</Text>
              <Text style={styles.title}>Finnish, out loud.</Text>
            </View>
            <View style={styles.levelBadge}>
              <Sparkles color="#F7C948" size={16} strokeWidth={2.4} />
              <Text style={styles.levelText}>{level}</Text>
            </View>
          </View>

          {usage && (
            <View accessibilityLabel="Estimated OpenAI budget usage" style={styles.usagePanel}>
              <View style={styles.usageHeader}>
                <Text style={styles.usageLabel}>ARVIOITU API-KÄYTTÖ</Text>
                <Text style={styles.usageValue}>
                  {usage.percentage.toFixed(2)}%  (${usage.estimatedSpendUsd.toFixed(4)} / ${usage.budgetUsd.toFixed(2)})
                </Text>
              </View>
              <View style={styles.usageTrack}>
                <View style={[styles.usageFill, { width: `${usage.percentage}%` }]} />
              </View>
              <Text style={styles.usageScope}>
                {usage.completedTurns} vastausta · {usage.transcriptionMinutes.toFixed(1)} min · {usage.scope === 'persistent estimate' ? 'tallennettu arvio' : 'nykyinen käyttökerta'}
              </Text>
            </View>
          )}

          <View style={styles.practiceSettings}>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>TASO</Text>
              <View accessibilityRole="tablist" style={styles.compactSelector}>
                {LEVELS.map((item) => (
                  <Pressable
                    accessibilityRole="tab"
                    accessibilityState={{ selected: level === item }}
                    disabled={isProcessing || recorderState.isRecording}
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
                    disabled={isProcessing || recorderState.isRecording}
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

          <View accessibilityRole="tablist" style={styles.topicSelector}>
            {TOPICS.map((item) => (
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: topic === item }}
                key={item}
                onPress={() => setTopic(item)}
                style={[styles.topicButton, topic === item && styles.topicButtonActive]}
              >
                <Text style={[styles.topicText, topic === item && styles.topicTextActive]}>
                  {item}
                </Text>
              </Pressable>
            ))}
          </View>

          <ScrollView
            contentContainerStyle={styles.conversation}
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
                <Pressable
                  accessibilityLabel="Play the opening tutor message"
                  hitSlop={12}
                  onPress={() => speak(openingQuestion)}
                  style={styles.replayButton}
                >
                  <Volume2 color="#165B4D" size={19} />
                </Pressable>
              </View>
            </View>

            {turns.map((turn) => (
              <View key={turn.id} style={styles.turnBlock}>
                <View style={styles.userMessage}>
                  <Text style={styles.speakerLight}>SINÄ SANOIT</Text>
                  <Text style={styles.userText}>{turn.transcript}</Text>
                </View>

                <View style={styles.feedback}>
                  <Text style={styles.feedbackLabel}>
                    {turn.correctedText === turn.transcript ? 'HYVIN SANOTTU' : 'KORJAUS'}
                  </Text>
                  <Text style={styles.correctedText}>{turn.correctedText}</Text>
                  <Text style={styles.explanation}>{turn.explanation}</Text>
                </View>

                <View style={styles.tutorMessage}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>K</Text>
                  </View>
                  <View style={styles.messageBody}>
                    <Text style={styles.speaker}>KIELIKAVERI</Text>
                    <Text style={styles.reply}>{turn.reply}</Text>
                    <Text style={styles.translation}>{turn.translation}</Text>
                    <Pressable
                      accessibilityLabel="Play the tutor reply again"
                      hitSlop={12}
                      onPress={() => speak(turn.reply)}
                      style={styles.replayButton}
                    >
                      <Volume2 color="#165B4D" size={19} />
                    </Pressable>
                  </View>
                </View>
              </View>
            ))}

            {isProcessing && (
              <View style={styles.thinkingRow}>
                <ActivityIndicator color="#165B4D" />
                <Text style={styles.thinkingText}>Kuuntelen ja mietin...</Text>
              </View>
            )}
          </ScrollView>

          <View style={styles.controls}>
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
                onPress={recorderState.isRecording ? stopAndSend : startRecording}
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
            </View>
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
              <RotateCcw color="#31564D" size={18} />
              <Text style={styles.restartButtonText}>Uusi keskustelu</Text>
            </Pressable>
          </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </LinearGradient>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  background: { flex: 1 },
  safeArea: { flex: 1 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingBottom: 18,
    paddingTop: Platform.OS === 'android' ? 46 : 12,
  },
  eyebrow: { color: '#C64B38', fontSize: 11, fontWeight: '800', letterSpacing: 0 },
  title: { color: '#173E35', fontFamily: 'serif', fontSize: 31, fontWeight: '700', marginTop: 3 },
  levelBadge: {
    alignItems: 'center',
    backgroundColor: '#173E35',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  levelText: { color: '#FFFDF7', fontSize: 13, fontWeight: '800' },
  usagePanel: { paddingBottom: 10, paddingHorizontal: 22 },
  usageHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  usageLabel: { color: '#587068', fontSize: 9, fontWeight: '900' },
  usageValue: { color: '#31564D', fontSize: 11, fontWeight: '800' },
  usageTrack: { backgroundColor: '#DCE5DE', borderRadius: 3, height: 5, marginTop: 5, overflow: 'hidden' },
  usageFill: { backgroundColor: '#C64B38', borderRadius: 3, height: '100%' },
  usageScope: { color: '#84958F', fontSize: 9, marginTop: 3 },
  practiceSettings: { gap: 8, paddingBottom: 12, paddingHorizontal: 22 },
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
  topicSelector: {
    alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.62)',
    borderColor: '#D8DED5',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    padding: 3,
  },
  topicButton: { borderRadius: 6, minWidth: 78, paddingHorizontal: 14, paddingVertical: 8 },
  topicButtonActive: { backgroundColor: '#F7C948' },
  topicText: { color: '#587068', fontSize: 13, fontWeight: '700', textAlign: 'center' },
  topicTextActive: { color: '#173E35' },
  conversation: { gap: 20, paddingHorizontal: 22, paddingBottom: 28, paddingTop: 28 },
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
  controlRow: { alignItems: 'center', flexDirection: 'row', gap: 26 },
  micButton: {
    alignItems: 'center',
    backgroundColor: '#C64B38',
    borderRadius: 38,
    elevation: 5,
    height: 76,
    justifyContent: 'center',
    shadowColor: '#7D2B20',
    shadowOffset: { height: 5, width: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 9,
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
    gap: 8,
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 40,
    paddingHorizontal: 14,
  },
  restartButtonPressed: { backgroundColor: '#E3ECE7' },
  restartButtonText: { color: '#31564D', fontSize: 13, fontWeight: '800' },
});
