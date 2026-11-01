import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

export function redact(value, secrets = []) {
  const clean = (v, key = '') => {
    if (/^(authorization|api[_-]?key|access[_-]?token|client_secret|password)$/i.test(key)) return '[REDACTED]';
    if (typeof v === 'string') {
      let text = v.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
      for (const secret of secrets) if (secret?.length > 3) text = text.split(secret).join('[REDACTED]');
      return text;
    }
    if (Array.isArray(v)) return v.map(x => clean(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x, k)]));
    return typeof v === 'bigint' ? String(v) : v;
  };
  return clean(value);
}

export function recordPayload(event) {
  const copy = structuredClone(event);
  if (copy.type === 'session.input_audio.append' || copy.type === 'session.output_audio.fixture.play') {
    copy.audio_bytes = Buffer.from(copy.audio || '', 'base64').length; delete copy.audio;
  }
  if (copy.type === 'session.output_audio.delta') {
    copy.audio_bytes = Buffer.from(copy.delta || '', 'base64').length; delete copy.delta;
  }
  return copy;
}

export function validateConfig(config) {
  if (!config || typeof config.code !== 'string' || config.code.length > 100000) throw new Error('委譲コードを指定してください（最大100KB）');
  if (!['manual', 'auto'].includes(config.mode)) throw new Error('実行モードが不正です');
  const s = config.session;
  if (!s || typeof s.model !== 'string' || !s.model.trim()) throw new Error('モデルが必要です');
  if (s.delegation?.type !== 'client') throw new Error('delegation.type は client 固定です');
  if (!Number.isInteger(s.delegation.acknowledgement_delay_ms) || s.delegation.acknowledgement_delay_ms < 0 || s.delegation.acknowledgement_delay_ms > 800) throw new Error('遅延は0〜800msです');
  if (s.audio?.format?.type !== 'audio/pcm' || s.audio?.format?.rate !== 24000) throw new Error('このアプリの音声形式はPCM16LE / 24kHz固定です');
  if (typeof s.instructions !== 'string') throw new Error('instructionsは文字列で指定してください');
  if (s.input && !Array.isArray(s.input)) throw new Error('inputは配列で指定してください');
  return structuredClone(config);
}

export class Delegations {
  constructor({ code, mode, parameters, send, record, secrets = [] }) {
    Object.assign(this, { code, mode, parameters, send, record, secrets });
    this.tasks = new Map(); this.closed = false;
  }
  async validate() {
    await new Promise((resolve, reject) => {
      const w = new Worker(new URL('./handler-worker.mjs', import.meta.url), { workerData: { code: this.code, validateOnly: true } });
      const timer = setTimeout(() => finish(new Error('コード読み込みがタイムアウトしました')), 5000);
      const finish = error => { clearTimeout(timer); w.terminate(); error ? reject(error) : resolve(); };
      w.on('message', m => { if (m.kind === 'ready') finish(); else if (m.kind === 'failed') finish(new Error(m.error)); });
      w.on('error', finish);
    });
  }
  start(event, transcript) {
    const id = event.delegation?.id;
    if (this.closed || !id || this.tasks.has(id)) return;
    const task = { id, status: 'running', checkpoint: null, worker: null, requestId: null };
    this.tasks.set(id, task);
    const w = new Worker(new URL('./handler-worker.mjs', import.meta.url), { workerData: { code: this.code, event, transcript, parameters: this.parameters } });
    task.worker = w; this.emit(task);
    w.on('message', async m => {
      if (this.closed || task.worker !== w) return;
      try {
        if (m.kind === 'log') this.record('LOG', { type: 'handler.log', delegation_id: id, args: m.args });
        if (m.kind === 'send') {
          const value = await this.send(m.event);
          if (task.worker === w) w.postMessage({ requestId: m.requestId, value });
        }
        if (m.kind === 'checkpoint') {
          if (this.mode === 'auto') {
            this.record('LOCAL', { type: 'checkpoint.passed', delegation_id: id, name: m.name });
            w.postMessage({ requestId: m.requestId });
          } else { task.status = 'waiting'; task.checkpoint = m.name; task.requestId = m.requestId; this.emit(task); }
        }
        if (m.kind === 'completed' || m.kind === 'failed') {
          task.status = m.kind === 'completed' ? 'completed' : 'failed'; task.error = m.error;
          task.worker = null; task.requestId = null; task.checkpoint = null; this.emit(task); w.terminate();
        }
      } catch (error) { if (task.worker === w) w.postMessage({ requestId: m.requestId, error: error.message }); }
    });
    w.on('error', error => { if (task.worker !== w) return; task.status = 'failed'; task.error = error.message; task.worker = null; this.emit(task); });
    w.on('exit', code => { if (task.worker !== w) return; task.worker = null; task.status = 'failed'; task.error = `Worker exited (${code})`; this.emit(task); });
  }
  emit(task) { this.record('LOCAL', { type: 'handler.state', task: { id: task.id, status: task.status, checkpoint: task.checkpoint, error: task.error } }); }
  resume(id) {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'waiting') throw new Error('待機中の委譲がありません');
    task.worker.postMessage({ requestId: task.requestId }); task.requestId = null; task.status = 'running'; task.checkpoint = null; this.emit(task);
  }
  cancel(id) {
    const task = this.tasks.get(id); if (!task?.worker) return;
    const w = task.worker; task.worker = null; task.status = 'cancelled'; task.checkpoint = null; task.requestId = null; this.emit(task); w.terminate();
  }
  close() { this.closed = true; for (const id of this.tasks.keys()) this.cancel(id); }
}

export function withEventId(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') throw new Error('typeを持つJSONオブジェクトが必要です');
  return { ...event, event_id: event.event_id || randomUUID() };
}
