import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Mic, Radio, Square } from 'lucide-react-native';
import { connectRealtime, type RealtimeEvent } from './realtime';
import { RealtimeTranscript, type RealtimeMessage } from './realtimeTranscript';

type Props = {
  apiUrl: string;
  appKey: string;
  level: string;
  languageMode: string;
  history: { transcript: string; reply: string }[];
  onTurn: (transcript: string, reply: string) => void;
  onActiveChange: (active: boolean) => void;
};

export default function RealtimeConversation(props: Props) {
  const [status, setStatus] = useState<'idle' | 'connecting' | 'listening' | 'speaking'>('idle');
  const [messages, setMessages] = useState<RealtimeMessage[]>([]);
  const [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<{ close: () => void } | null>(null);
  const transcriptRef = useRef(new RealtimeTranscript());
  const scrollRef = useRef<ScrollView>(null);
  const callbacksRef = useRef(props);
  callbacksRef.current = props;

  function stop() {
    requestRef.current?.abort();
    requestRef.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    setStatus('idle');
    callbacksRef.current.onActiveChange(false);
  }

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') stop();
    });
    return () => {
      subscription.remove();
      requestRef.current?.abort();
      sessionRef.current?.close();
      callbacksRef.current.onActiveChange(false);
    };
  }, []);

  function receive(event: RealtimeEvent) {
    if (event.type === 'connected' || event.type === 'output_audio_buffer.stopped'
      || event.type === 'input_audio_buffer.speech_started') setStatus('listening');
    if (event.type === 'output_audio_buffer.started') setStatus('speaking');
    const turn = transcriptRef.current.receive(event);
    setMessages(transcriptRef.current.messages);
    if (turn) callbacksRef.current.onTurn(turn.transcript, turn.reply);
  }

  async function start() {
    if (requestRef.current) return;
    const request = new AbortController();
    requestRef.current = request;
    setError('');
    transcriptRef.current = new RealtimeTranscript();
    setMessages([]);
    setStatus('connecting');
    callbacksRef.current.onActiveChange(true);
    try {
      const session = await connectRealtime({
        ...props, signal: request.signal,
        history: props.history.slice(-4).map((turn) => ({
          transcript: turn.transcript.slice(0, 600), reply: turn.reply.slice(0, 600),
        })),
        onEvent: receive,
        onDisconnect: (failure) => {
          if (requestRef.current !== request) return;
          stop();
          setError(failure?.message ?? 'Realtime voice disconnected.');
        },
      });
      if (requestRef.current !== request) session.close();
      else sessionRef.current = session;
    } catch (failure) {
      if (requestRef.current !== request) return;
      stop();
      setError(failure instanceof Error ? failure.message : 'Realtime voice could not start.');
    }
  }

  const active = status !== 'idle';
  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.messages}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {messages.length === 0 && <View style={styles.empty}><Radio color="#165B4D" size={40} /><Text style={styles.heading}>RT puhe</Text></View>}
        {messages.filter((message) => message.text !== '').map((message) => (
          <View key={message.id} style={[styles.message, message.role === 'user' && styles.userMessage]}>
            <Text style={[styles.speaker, message.role === 'user' && styles.light]}>{message.role === 'user' ? 'SINÄ' : 'KIELIKAVERI'}</Text>
            <Text style={[styles.messageText, message.role === 'user' && styles.light]}>{message.text}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={styles.controls}>
        {error !== '' && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        <Text accessibilityLiveRegion="polite" style={styles.status}>
          {status === 'connecting' ? 'Yhdistetään...' : status === 'listening' ? 'Kuuntelen...' : status === 'speaking' ? 'Kielikaveri puhuu...' : 'Valmis'}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel={active ? 'Stop realtime conversation' : 'Start realtime conversation'} onPress={active ? stop : () => void start()} style={[styles.button, active && styles.activeButton]}>
          {status === 'connecting' ? <ActivityIndicator color="#FFFDF7" /> : active ? <Square size={24} color="#FFFDF7" /> : <Mic size={24} color="#FFFDF7" />}
          <Text style={styles.buttonText}>{active ? 'Lopeta' : 'Aloita RT puhe'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  messages: { padding: 22, gap: 16, flexGrow: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  heading: { color: '#173E35', fontFamily: 'serif', fontSize: 24 },
  message: { alignSelf: 'flex-start', maxWidth: '92%', paddingVertical: 12 },
  userMessage: { alignSelf: 'flex-end', backgroundColor: '#165B4D', paddingHorizontal: 16, borderRadius: 8 },
  speaker: { color: '#4E766B', fontSize: 10, fontWeight: '800' },
  messageText: { color: '#173E35', fontSize: 18, lineHeight: 26, marginTop: 5 },
  light: { color: '#FFFDF7' },
  controls: { borderTopWidth: 1, borderColor: '#DCE3DC', backgroundColor: 'rgba(255,253,247,0.88)', alignItems: 'center', padding: 18, gap: 10 },
  status: { color: '#31564D', fontSize: 13 },
  error: { color: '#9B3024', fontSize: 13, textAlign: 'center' },
  button: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: '#C64B38', paddingHorizontal: 20, borderRadius: 8 },
  activeButton: { backgroundColor: '#173E35' },
  buttonText: { color: '#FFFDF7', fontSize: 15, fontWeight: '700' },
});