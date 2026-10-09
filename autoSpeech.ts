export class AutoSpeechDetector {
  private speechMillis = 0;
  private lastVoiceMillis = 0;
  private previousMillis = 0;
  private noiseFloor: number | undefined;

  constructor(private readonly timeoutMillis = 60_000) {}

  sample(durationMillis: number, metering?: number): 'wait' | 'send' | 'discard' {
    if (metering === undefined || !Number.isFinite(metering)) {
      if (durationMillis < this.timeoutMillis) return 'wait';
      throw new Error('Microphone level detection is unavailable on this device. Use Puhe instead.');
    }
    const elapsed = Math.max(0, Math.min(200, durationMillis - this.previousMillis));
    this.previousMillis = durationMillis;
    const level = Math.max(-90, metering);
    if (this.noiseFloor === undefined || level < this.noiseFloor) this.noiseFloor = level;
    const threshold = Math.max(-65, Math.min(-38, this.noiseFloor + 8));
    const voiced = metering > threshold && (durationMillis >= 500 || metering > -38);
    if (voiced) {
      this.speechMillis += elapsed;
      this.lastVoiceMillis = durationMillis;
    } else if (this.speechMillis < 300 && durationMillis - this.lastVoiceMillis >= 400) {
      this.speechMillis = 0;
    }
    if (durationMillis >= this.timeoutMillis) return this.speechMillis >= 300 ? 'send' : 'discard';
    return 'wait';
  }
}