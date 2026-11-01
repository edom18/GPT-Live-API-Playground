class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = []; this.position = 0; }
  process(inputs, outputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      // Linear resampling keeps the fractional phase between render quanta.
      this.samples.push(...channel);
      const step = sampleRate / 24000;
      this.frame ||= new Int16Array(480); this.used ||= 0;
      while (this.position + 1 < this.samples.length) {
        const i = Math.floor(this.position), f = this.position - i;
        const x = Math.max(-1, Math.min(1, this.samples[i] * (1-f) + this.samples[i+1] * f));
        this.frame[this.used++] = Math.round(x * (x < 0 ? 32768 : 32767));
        this.position += step;
        if (this.used === 480) { this.port.postMessage(this.frame.buffer, [this.frame.buffer]); this.frame = new Int16Array(480); this.used = 0; }
      }
      const discard = Math.floor(this.position); this.samples.splice(0, discard); this.position -= discard;
    }
    for (const channel of outputs[0] || []) channel.fill(0);
    return true;
  }
}
registerProcessor('capture', Capture);
