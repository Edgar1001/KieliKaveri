export class AutoSpeechDetector {
  private speechMillis = 0;
  private lastVoiceMillis = 0;
  private previousMillis = 0;

  sample(durationMillis: number, metering?: number): 'wait' | 'send' | 'discard' {
    if (metering === undefined || !Number.isFinite(metering)) {
      throw new Error('Microphone level detection is unavailable on this device. Use Puhe instead.');
    }
    const elapsed = Math.max(0, Math.min(200, durationMillis - this.previousMillis));
    this.previousMillis = durationMillis;
    if (metering > -38) {
      this.speechMillis += elapsed;
      this.lastVoiceMillis = durationMillis;
    } else if (this.speechMillis < 300) {
      this.speechMillis = 0;
    }
    if (this.speechMillis >= 300 && durationMillis - this.lastVoiceMillis >= 1600) return 'send';
    if (durationMillis >= 60_000) return this.speechMillis >= 300 ? 'send' : 'discard';
    return 'wait';
  }
}