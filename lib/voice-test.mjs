import { redact, withEventId } from './runtime.mjs';
import { openLiveSocket } from './connection.mjs';
import { apiKeyValue } from './voices.mjs';

const FRAME_BYTES = 960; // 20ms of mono PCM16LE at 24kHz.
const silence = Buffer.alloc(FRAME_BYTES).toString('base64');

export function voiceTestSession(input) {
  const apiKey = apiKeyValue(input?.apiKey);
  const voice = typeof input?.voice === 'string' ? input.voice.trim() : '';
  if (!/^voice_[A-Za-z0-9_-]{1,200}$/.test(voice)) throw new Error('テストする音声IDが不正です（voice_ で始まるID）');
  if (typeof input.instructions !== 'string' || input.instructions.length > 20000) throw new Error('指示プロンプトは20,000文字以内で指定してください');
  return { apiKey, session: { model: 'gpt-live-1', instructions: input.instructions,
    audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: { id: voice } } } } };
}

// One short conversation per browser socket. Nothing is written to disk and the key lives only in this closure.
export function handleVoiceTest(client, { WebSocket, endpoint, userIdleMs, safe }) {
  let upstream, apiKey, stopReason, ready = false, audioTimer, startTimer, closeTimer, idleTimer, audioQueue = [], lastPing = Date.now();
  const mask = value => redact(safe(value), [apiKey]);
  const emit = data => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(mask(data))); };
  // Debug view of the Live wire. Audio frames are omitted: they arrive every 20ms and carry no settings.
  const debug = (direction, event) => emit({ kind: 'debug', direction, at: new Date().toISOString(), event });
  const finish = reason => {
    ready = false; clearInterval(audioTimer); clearTimeout(startTimer); clearTimeout(closeTimer); clearTimeout(idleTimer); audioQueue = [];
    if (!upstream) return;
    const old = upstream; upstream = null; old.terminate();
    emit({ kind: 'status', status: 'disconnected', reason });
  };
  const stop = reason => {
    if (!ready || upstream?.readyState !== WebSocket.OPEN) { finish(reason); return; }
    ready = false; clearInterval(audioTimer); clearTimeout(idleTimer);
    const close = withEventId({ type: 'session.close' });
    upstream.send(JSON.stringify(close)); debug('SEND', close);
    stopReason = reason;
    closeTimer = setTimeout(() => finish(reason), 5000); // Normally session.closed arrives first.
  };
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop('発話を1分間確認できなかったため自動終了しました'), userIdleMs);
  };
  const start = input => {
    const valid = voiceTestSession(input);
    finish('新しいテストを開始');
    apiKey = valid.apiKey; stopReason = null;
    emit({ kind: 'status', status: 'connecting' });
    const ws = openLiveSocket({ WebSocket, endpoint, apiKey, session: valid.session, isCurrent: candidate => upstream === candidate, onSend: event => debug('SEND', event) });
    upstream = ws;
    startTimer = setTimeout(() => { if (upstream === ws) finish('session.started待機タイムアウト'); }, 20000);
    ws.on('message', buffer => {
      if (upstream !== ws) return;
      let event; try { event = JSON.parse(buffer.toString()); } catch { return; }
      if (event.type !== 'session.output_audio.delta') debug('RECV', event);
      if (event.type === 'session.started') {
        clearTimeout(startTimer); ready = true; emit({ kind: 'status', status: 'connected' }); resetIdle();
        // Live expects a continuous input timeline, so silence fills the gaps while the microphone is quiet.
        audioTimer = setInterval(() => {
          if (!ready || upstream !== ws) return;
          if (ws.bufferedAmount > 1024 * 1024) { finish('音声送信の滞留'); return; }
          ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: audioQueue.shift() || silence }));
        }, 20);
      }
      if (event.type === 'session.output_audio.delta' && typeof event.delta === 'string') {
        if (client.bufferedAmount > 2 * 1024 * 1024) { finish('ブラウザへの音声送信が滞留'); return; }
        client.send(JSON.stringify({ kind: 'audio', audio: event.delta }));
      }
      if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string') {
        emit({ kind: 'transcript', role: 'user', delta: event.delta });
        if (event.delta.trim()) resetIdle();
      }
      if (event.type === 'session.output_transcript.delta' && typeof event.delta === 'string') emit({ kind: 'transcript', role: 'assistant', delta: event.delta });
      if (event.type === 'error') emit({ kind: 'error', message: `Liveエラー: ${event.error?.message || event.error?.code || '詳細なし'}` });
      if (event.type === 'session.closed') finish(stopReason || 'APIがセッションを終了しました');
    });
    ws.on('error', error => {
      if (upstream !== ws) return;
      const message = /Unexpected server response: 401/.test(error.message) ? 'OpenAI認証エラー（401）。APIキーを確認してください。' : `Live接続エラー: ${error.message}`;
      emit({ kind: 'error', message }); finish(message);
    });
    ws.on('close', (code, reason) => { if (upstream === ws) finish(stopReason || `WebSocket closed: ${code} ${reason.toString()}`); });
  };
  const heartbeat = setInterval(() => { if (Date.now() - lastPing > 45000) { finish('ブラウザ応答なし'); client.terminate(); } }, 10000);
  client.on('message', (buffer, binary) => {
    if (binary) { if (ready && buffer.length === FRAME_BYTES && audioQueue.length < 15) audioQueue.push(buffer.toString('base64')); return; }
    let m; try { m = JSON.parse(buffer.toString()); } catch { emit({ kind: 'error', message: '不正なJSONです' }); return; }
    try {
      if (m.kind === 'ping') lastPing = Date.now();
      else if (m.kind === 'start') start(m);
      else if (m.kind === 'stop') stop('テストを終了しました');
    } catch (error) { emit({ kind: 'error', message: error.message }); }
  });
  client.on('close', () => { clearInterval(heartbeat); finish('ブラウザ接続終了'); });
  client.on('error', () => client.terminate());
}
