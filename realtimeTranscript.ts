import type { RealtimeEvent } from './realtime';

export type RealtimeMessage = { id: string; role: 'user' | 'assistant'; text: string };

export class RealtimeTranscript {
  messages: RealtimeMessage[] = [];
  private latestUserId = '';
  private replyUsers = new Map<string, string>();
  private replies = new Map<string, string>();
  private transcripts = new Map<string, string>();

  receive(event: RealtimeEvent): { transcript: string; reply: string } | undefined {
    if (event.type === 'input_audio_buffer.committed' && event.item_id) {
      this.latestUserId = event.item_id;
      this.messages = [...this.messages, { id: event.item_id, role: 'user', text: '' }];
    }
    if (event.type === 'response.output_item.added' && event.item?.id) {
      this.replyUsers.set(event.item.id, this.latestUserId);
    }
    const user = event.type === 'conversation.item.input_audio_transcription.completed';
    const delta = event.type === 'response.output_audio_transcript.delta';
    const done = event.type === 'response.output_audio_transcript.done';
    if (!(user || delta || done) || !event.item_id) return;
    const text = user || done ? event.transcript ?? '' : event.delta ?? '';
    const existing = this.messages.find((message) => message.id === event.item_id);
    const message: RealtimeMessage = {
      id: event.item_id, role: user ? 'user' : 'assistant',
      text: delta ? (existing?.text ?? '') + text : text,
    };
    this.messages = existing
      ? this.messages.map((item) => item.id === message.id ? message : item)
      : [...this.messages, message];
    if (!user && !this.replyUsers.has(event.item_id)) {
      this.replyUsers.set(event.item_id, this.latestUserId);
    }
    const userId = user ? event.item_id : this.replyUsers.get(event.item_id);
    if (!userId) return;
    if (user) this.transcripts.set(userId, text);
    if (done) this.replies.set(userId, text);
    const transcript = this.transcripts.get(userId);
    const reply = this.replies.get(userId);
    if (transcript && reply) {
      this.transcripts.delete(userId);
      this.replies.delete(userId);
      return { transcript, reply };
    }
  }
}