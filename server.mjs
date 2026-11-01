import http from 'node:http';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { Delegations, redact, recordPayload, validateConfig, withEventId } from './lib/runtime.mjs';
import { openLiveSocket, connectionSource } from './lib/connection.mjs';
import { createVoiceStore } from './lib/voices.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export async function startServer({ port = Number(process.env.PORT || 3210), apiKey = process.env.OPENAI_API_KEY,
  endpoint = 'wss://api.openai.com/v1/live/sessions', dataDir = path.join(root, 'data'), userIdleMs = 60000, voiceFetch = fetch } = {}) {
  await mkdir(dataDir, { recursive: true });
  const secrets = Object.entries(process.env).filter(([k]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k)).map(([, v]) => v);
  if (apiKey) secrets.push(apiKey);
  const safe = value => redact(value, secrets);
  const voices = createVoiceStore({ dataDir, apiKey, safe, fetchImpl: voiceFetch });
  let owner = null;
  const clients = new Set();
  const allowedHost = host => host === `localhost:${server.address()?.port}` || host === `127.0.0.1:${server.address()?.port}`;
  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host)) { res.writeHead(403).end('Local host only'); return; }
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/api/voices' && req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
        if (req.headers.origin !== `http://${req.headers.host}` || req.headers['content-type']?.split(';')[0] !== 'application/json') {
          res.writeHead(403).end(JSON.stringify({ error: '同一オリジンのJSONリクエストのみ受け付けます' })); return;
        }
        try {
          const chunks = []; let bytes = 0;
          for await (const chunk of req) { bytes += chunk.length; if (bytes > 24000) throw Object.assign(new Error('リクエストが大きすぎます'), { status: 413 }); chunks.push(chunk); }
          const text = Buffer.concat(chunks).toString('utf8');
          let input; try { input = JSON.parse(text); } catch { throw Object.assign(new Error('JSONが不正です'), { status: 400 }); }
          res.end(JSON.stringify(safe(await voices.create(input))));
        } catch (error) { res.writeHead(error.status || 500).end(JSON.stringify({ error: safe(error.message) })); }
        return;
      }
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      const styleNonce = randomUUID();
      res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'`);
      if (pathname === '/api/status') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ keyConfigured: Boolean(apiKey), busy: Boolean(owner) })); return; }
      if (pathname === '/api/voices') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await voices.list())); return; }
      if (pathname === '/api/connection-source') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(connectionSource)); return; }
      if (pathname === '/api/draft') { res.setHeader('Content-Type', 'application/json'); res.end(await readFile(path.join(dataDir, 'draft.json'), 'utf8').catch(() => 'null')); return; }
      if (pathname === '/api/runs') {
        const runs = [];
        for (const name of (await readdir(dataDir)).filter(x => /^[0-9a-f-]+\.json$/.test(x))) {
          try { const run = JSON.parse(await readFile(path.join(dataDir, name), 'utf8')); runs.push({ id: run.id, title: run.config.title, startedAt: run.startedAt }); } catch {}
        }
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(runs.sort((a,b) => b.startedAt.localeCompare(a.startedAt)))); return;
      }
      if (/^\/api\/runs\/[0-9a-f-]+$/.test(pathname)) {
        const id = pathname.split('/').pop();
        const run = JSON.parse(await readFile(path.join(dataDir, `${id}.json`), 'utf8'));
        const lines = await readFile(path.join(dataDir, `${id}.jsonl`), 'utf8').catch(() => '');
        run.events = lines.trim().split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(run)); return;
      }
      const files = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/audio.js': 'audio.js', '/capture-worklet.js': 'capture-worklet.js', '/state.js': 'state.js' };
      files['/editors.bundle.js'] = 'editors.bundle.js';
      files['/voices.js'] = 'voices.js'; files['/voice-setting.js'] = 'voice-setting.js';
      const name = files[pathname]; if (!name) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
      const file = await readFile(path.join(root, 'public', name));
      res.end(name === 'index.html' ? file.toString('utf8').replace('__STYLE_NONCE__', styleNonce) : file);
    } catch (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Request failed'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/control' || !allowedHost(req.headers.host) || req.headers.origin !== `http://${req.headers.host}`) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', client => {
    clients.add(client);
    let run, upstream, runtime, ready = false, closing = false, audioTimer, startTimer, closeTimer, seq = 0, audioQueue = [], lastPing = Date.now();
    let chain = Promise.resolve(), userIdleTimer, autoCloseReason;
    const emit = data => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(safe(data))); };
    const record = (direction, event) => {
      if (!run) return;
      const entry = safe({ seq: ++seq, at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - run.clock), direction, event: recordPayload(event) });
      appendFileSync(path.join(dataDir, `${run.id}.jsonl`), JSON.stringify(entry) + '\n');
      emit({ kind: 'event', runId: run.id, entry });
      if (event.type === 'session.input_transcript.delta') run.transcript.input += event.delta || '';
      if (event.type === 'session.output_transcript.delta') run.transcript.output += event.delta || '';
    };
    const finish = reason => {
      ready = false; closing = false; clearInterval(audioTimer); clearTimeout(startTimer); clearTimeout(closeTimer); clearTimeout(userIdleTimer); audioQueue = [];
      runtime?.close(); runtime = null;
      if (upstream) { const old = upstream; upstream = null; old.terminate(); }
      if (run) record('LOCAL', { type: 'connection.closed', reason });
      if (owner === client) owner = null;
      emit({ kind: 'status', status: 'disconnected', reason });
    };
    const send = async event => {
      if (!ready || closing || upstream?.readyState !== WebSocket.OPEN) throw new Error('Liveセッションは接続されていません');
      const data = withEventId(event);
      if (data.type === 'session.start') throw new Error('再接続ボタンで新しいセッションを作成してください');
      if (upstream.bufferedAmount > 2 * 1024 * 1024) throw new Error('送信が滞留しています');
      upstream.send(JSON.stringify(data)); record('SEND', data);
      if (data.type === 'session.close') {
        closing = true; ready = false; clearInterval(audioTimer); clearTimeout(userIdleTimer); runtime?.close();
        closeTimer = setTimeout(() => finish(autoCloseReason || 'session.closed待機タイムアウト'), 5000);
      }
      return { event_id: data.event_id }; // Socket submission only; not API acknowledgment.
    };
    const disconnect = () => {
      if (ready && !closing) return send({ type: 'session.close' });
      finish('ローカル切断');
    };
    const resetUserIdleTimer = () => {
      clearTimeout(userIdleTimer);
      if (!ready || closing) return;
      userIdleTimer = setTimeout(() => {
        if (!ready || closing) return;
        autoCloseReason = 'ユーザーの発話を1分間確認できなかったため自動切断しました';
        record('LOCAL', { type: 'connection.user_idle_timeout', timeoutMs: userIdleMs, reason: autoCloseReason });
        send({ type: 'session.close' }).catch(() => finish(autoCloseReason));
      }, userIdleMs);
    };
    const connect = async config => {
      if (owner && owner !== client) throw new Error('別タブが実験を実行中です');
      if (!apiKey) throw new Error('.env に OPENAI_API_KEY を設定してサーバーを再起動してください');
      const valid = validateConfig(config);
      if (upstream || runtime) finish('新しい実験へ再接続');
      autoCloseReason = null;
      owner = client;
      const newRuntime = new Delegations({ ...valid, send, record });
      try { await newRuntime.validate(); } catch (error) { if (owner === client) owner = null; throw error; }
      if (client.readyState !== WebSocket.OPEN) { newRuntime.close(); if (owner === client) owner = null; return; }
      runtime = newRuntime;
      run = { id: randomUUID(), startedAt: new Date().toISOString(), config: safe(valid), codeHash: createHash('sha256').update(valid.code).digest('hex'), clock: performance.now(), transcript: { input: '', output: '' } };
      seq = 0;
      run.connectionSource = connectionSource;
      run.safety = { userIdleMs, activityEvent: 'session.input_transcript.delta (non-empty)' };
      const { clock, transcript, ...meta } = run;
      writeFileSync(path.join(dataDir, `${run.id}.json`), JSON.stringify(meta, null, 2));
      emit({ kind: 'run', run: meta }); emit({ kind: 'status', status: 'connecting' });
      record('LOCAL', { type: 'connection.opening', transport: 'primary-websocket' });
      const ws = openLiveSocket({ WebSocket, endpoint, apiKey, session: valid.session,
        isCurrent: candidate => upstream === candidate,
        onSend: event => record('SEND', event),
      });
      upstream = ws;
      startTimer = setTimeout(() => { if (upstream === ws) finish('session.started待機タイムアウト'); }, 20000);
      ws.on('message', buffer => {
        if (upstream !== ws) return;
        try {
          const event = JSON.parse(buffer.toString());
          record('RECV', event);
          if (event.type === 'session.started') {
            clearTimeout(startTimer); ready = true; emit({ kind: 'status', status: 'connected' });
            resetUserIdleTimer();
            // Maintain the Live input timeline even when the microphone is off.
            clearInterval(audioTimer);
            audioTimer = setInterval(() => {
              if (!ready || closing || upstream !== ws) return;
              if (ws.bufferedAmount > 1024 * 1024) { finish('音声送信の滞留'); return; }
              const audio = audioQueue.shift() || Buffer.alloc(960).toString('base64');
              const event = { type: 'session.input_audio.append', audio };
              ws.send(JSON.stringify(event));
              // Audio payloads are never retained; each frame retains its byte count and source.
              record('SEND', { ...event, source: audio === silence ? 'silence' : 'microphone' });
            }, 20);
          }
          if (event.type === 'session.output_audio.delta' && typeof event.delta === 'string') {
            if (client.bufferedAmount > 2 * 1024 * 1024) { finish('ブラウザへの音声送信が滞留'); return; }
            // Audio bypasses the persisted/redacted event envelope; only this transient message carries it.
            client.send(JSON.stringify({ kind: 'audio', runId: run.id, audio: event.delta, sourceSeq: seq }));
          }
          if (event.type === 'session.delegation.created' && event.delegation?.target === 'client') runtime?.start(event, { ...run.transcript });
          if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string' && event.delta.trim()) resetUserIdleTimer();
          if (event.type === 'session.closed') finish(autoCloseReason || 'APIがセッションを終了しました');
        } catch (error) { record('LOCAL', { type: 'runtime.error', message: error.message }); }
      });
      ws.on('error', error => {
        if (upstream !== ws) return;
        const message = /Unexpected server response: 401/.test(error.message)
          ? 'OpenAI認証エラー（401）。.env の OPENAI_API_KEY を有効なキーに差し替え、サーバーを再起動してください。'
          : `Live接続エラー: ${error.message}`;
        record('LOCAL', { type: 'connection.error', message, detail: error.message });
        emit({ kind: 'error', message });
        finish(message);
      });
      ws.on('close', (code, reason) => { if (upstream === ws) finish(autoCloseReason || `WebSocket closed: ${code} ${reason.toString()}`); });
    };
    const silence = Buffer.alloc(960).toString('base64');
    const heartbeat = setInterval(() => { if (Date.now() - lastPing > 45000) { finish('ブラウザ応答なし'); client.terminate(); } }, 10000);
    emit({ kind: 'hello', keyConfigured: Boolean(apiKey) });
    client.on('message', (buffer, binary) => {
      if (binary) {
        if (ready && buffer.length === 960 && audioQueue.length < 15) audioQueue.push(buffer.toString('base64'));
        return;
      }
      let m; try { m = JSON.parse(buffer.toString()); } catch { emit({ kind: 'error', message: '不正なJSONです' }); return; }
      if (m.kind === 'ping') { lastPing = Date.now(); return; }
      chain = chain.then(async () => {
        if (m.kind === 'draft') { const draft = validateConfig(m.config); writeFileSync(path.join(dataDir, 'draft.json'), JSON.stringify(safe(draft), null, 2)); }
        else if (m.kind === 'connect') await connect(m.config);
        else if (m.kind === 'disconnect') await disconnect();
        else if (m.kind === 'send') await send(m.event);
        else if (m.kind === 'resume') runtime?.resume(m.id);
        else if (m.kind === 'cancel') runtime?.cancel(m.id);
        else if (m.kind === 'browser' && run && m.runId === run.id && typeof m.event?.type === 'string') record('BROWSER', m.event);
      }).catch(error => { emit({ kind: 'error', message: error.message }); if (run) record('LOCAL', { type: 'command.error', message: error.message }); });
    });
    client.on('close', () => { clearInterval(heartbeat); finish('ブラウザ接続終了'); clients.delete(client); });
    client.on('error', () => client.terminate());
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const close = async () => { for (const c of clients) c.terminate(); wss.close(); await new Promise(resolve => server.close(resolve)); };
  return { server, close, url: `http://localhost:${server.address().port}` };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startServer(); console.log(`GPT-Live Lab: ${app.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
