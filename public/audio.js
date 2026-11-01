export class AudioIO {
  constructor({ onFrame, onEvent }) { Object.assign(this, { onFrame, onEvent }); this.sources = new Set(); this.cursor = 0; this.generation = 0; }
  async unlock() {
    this.context ||= new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' });
    await this.context.resume();
  }
  async microphone(on) {
    if (!on) {
      this.capture?.disconnect(); this.input?.disconnect(); this.stream?.getTracks().forEach(t => t.stop());
      this.capture = this.input = this.stream = null; this.onEvent({ type: 'microphone.stopped' }); return;
    }
    if (this.stream) return;
    const gen = this.generation;
    await this.unlock();
    this.moduleReady ||= this.context.audioWorklet.addModule('/capture-worklet.js'); await this.moduleReady;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    if (gen !== this.generation) { stream.getTracks().forEach(t => t.stop()); return; }
    this.stream = stream; this.input = this.context.createMediaStreamSource(stream);
    this.capture = new AudioWorkletNode(this.context, 'capture');
    this.capture.port.onmessage = e => this.onFrame(e.data);
    this.input.connect(this.capture); this.capture.connect(this.context.destination);
    this.onEvent({ type: 'microphone.started', contextSampleRate: this.context.sampleRate, wireSampleRate: 24000 });
  }
  play(base64, sourceSeq) {
    if (!this.context || this.context.state !== 'running') { this.onEvent({ type: 'playback.dropped', reason: 'AudioContext is not running', sourceSeq }); return; }
    const bytes = Uint8Array.from(atob(base64), x => x.charCodeAt(0));
    const view = new DataView(bytes.buffer), samples = Math.floor(bytes.length / 2);
    if (!samples) return;
    if (this.cursor - this.context.currentTime > 2) { this.stopPlayback(); this.onEvent({ type: 'playback.overflow', sourceSeq }); }
    const buffer = this.context.createBuffer(1, samples, 24000), data = buffer.getChannelData(0);
    for (let i = 0; i < samples; i++) data[i] = view.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    const at = Math.max(this.cursor, this.context.currentTime + 0.015); this.cursor = at + buffer.duration;
    const gen = this.generation; this.sources.add(source);
    this.onEvent({ type: 'playback.scheduled', sourceSeq, audioContextTime: at, browserTimeMs: performance.now(), durationMs: buffer.duration * 1000 });
    source.onended = () => { this.sources.delete(source); if (gen === this.generation) this.onEvent({ type: 'playback.chunk_ended', sourceSeq, browserTimeMs: performance.now() }); };
    source.start(at);
  }
  stopPlayback() { this.generation++; for (const s of this.sources) { try { s.stop(); } catch {} } this.sources.clear(); this.cursor = 0; }
  stop() { this.stopPlayback(); return this.microphone(false); }
}
