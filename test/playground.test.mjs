import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { WebSocketServer, WebSocket } from 'ws';
import { startServer } from '../server.mjs';
import { Delegations, redact, recordPayload } from '../lib/runtime.mjs';
import { inspect, markdown } from '../public/state.js';
import { connectionSource, sessionStart } from '../lib/connection.mjs';
const waitFor = async predicate => { for (let i = 0; i < 200; i++) { const result = predicate(); if (result) return result; await new Promise(r => setTimeout(r, 20)); } throw new Error('Timed out'); };

test('state projection separates submission, matching acknowledgment, error and historical time', () => {
  const events = [
    { seq: 1, elapsedMs: 10, direction: 'SEND', event: { type: 'session.commentary.append', event_id: 'a', delegation_id: null, content: 'hello' } },
    { seq: 2, elapsedMs: 30, direction: 'RECV', event: { type: 'session.thinking.appended', client_event_id: 'a' } },
    { seq: 3, elapsedMs: 40, direction: 'RECV', event: { type: 'session.commentary.appended', client_event_id: 'a', start_ms: 1, end_ms: 2 } },
  ];
  assert.equal(inspect(events, 2).appends[0].status, '未確認');
  assert.equal(inspect(events).appends[0].status, 'API確認済み');
  assert.equal(inspect(events).appends[0].confirmedAt, 40);
  events.push({ seq: 4, direction: 'RECV', event: { type: 'error', error: { client_event_id: 'a', message: 'bad' } } });
  assert.equal(inspect(events).appends[0].status, 'エラー');
});

test('secrets and audio payloads are removed while transcripts remain', () => {
  assert.deepEqual(redact({ authorization: 'Bearer foo', content: 'secret-value', nested: { api_key: 'bar' } }, ['secret-value']), { authorization: '[REDACTED]', content: '[REDACTED]', nested: { api_key: '[REDACTED]' } });
  assert.deepEqual(recordPayload({ type: 'session.output_audio.delta', delta: 'AAAA' }), { type: 'session.output_audio.delta', audio_bytes: 3 });
  assert.equal(recordPayload({ type: 'session.output_transcript.delta', delta: 'hello' }).delta, 'hello');
});

test('parallel checkpoints resume only selected delegation and cancellation prevents later sends', async () => {
  const sent = [], events = [];
  const runtime = new Delegations({ mode: 'manual', parameters: {}, code: 'export async function onDelegation(e,c) { c.log("start"); await c.checkpoint("wait"); await c.send({type:"session.thinking.append",delegation_id:e.delegation.id,content:"ok"}); }', send: async e => sent.push(e), record: (d,e) => events.push(e) });
  try {
    await runtime.validate();
    runtime.start({ delegation: { id: 'one' } }, {}); runtime.start({ delegation: { id: 'two' } }, {});
    await waitFor(() => runtime.tasks.get('one').status === 'waiting' && runtime.tasks.get('two').status === 'waiting');
    runtime.resume('two'); await waitFor(() => sent.length === 1);
    assert.equal(sent[0].delegation_id, 'two'); assert.equal(runtime.tasks.get('one').status, 'waiting');
    runtime.cancel('one'); assert.throws(() => runtime.resume('one')); assert.equal(sent.length, 1);
    assert.ok(events.some(e => e.type === 'handler.log' && e.delegation_id === 'one'));
  } finally { runtime.close(); }
});

test('auto checkpoints pass and invalid code fails before connecting', async () => {
  const runtime = new Delegations({ mode: 'auto', code: 'export async function onDelegation(e,c){await c.checkpoint("auto");}', record() {}, send() {} });
  try { await runtime.validate(); runtime.start({ delegation: { id: 'auto' } }, {}); await waitFor(() => runtime.tasks.get('auto').status === 'completed'); } finally { runtime.close(); }
  const invalid = new Delegations({ code: 'export function broken(', record() {} });
  await assert.rejects(invalid.validate());
});

test('real local HTTP/WS path: config, audio, handler, persistence, export, origin and disconnect', async t => {
  const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => fake.once('listening', resolve));
  const upstreamEvents = []; let remote;
  fake.on('connection', ws => { remote = ws; ws.on('message', data => {
    const e = JSON.parse(data.toString()); upstreamEvents.push(e);
    if (e.type === 'session.start') ws.send(JSON.stringify({ type: 'session.started', session: { ...e.session, id: 'test-live' } }));
    if (/^session\.(thinking|commentary|instructions)\.append$/.test(e.type)) ws.send(JSON.stringify({ type: e.type+'ed', client_event_id: e.event_id, start_ms: 1, end_ms: 2 }));
    if (e.type === 'session.close') ws.send(JSON.stringify({ type: 'session.closed' }));
  }); });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'live-lab-test-'));
  const app = await startServer({ port: 0, apiKey: 'test-key-secret', endpoint: `ws://127.0.0.1:${fake.address().port}`, dataDir });
  const messages = []; const client = new WebSocket(app.url.replace('http:', 'ws:') + '/control', { origin: app.url });
  client.on('message', d => messages.push(JSON.parse(d.toString())));
  t.after(async () => { client.terminate(); for (const c of fake.clients) c.terminate(); await app.close(); await new Promise(r => fake.close(r)); });
  await new Promise(resolve => client.once('open', resolve));
  const cfg = { title: 'Test', mode: 'manual', parameters: {}, code: 'export async function onDelegation(e,c){await c.checkpoint("pause");await c.send({type:"session.commentary.append",delegation_id:e.delegation.id,content:"done"});}', session: { model: 'gpt-live-1', instructions: 'hello', audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'marin' } }, delegation: { type: 'client', acknowledgement_delay_ms: 800 } } };
  client.send(JSON.stringify({ kind: 'draft', config: cfg }));
  await waitFor(() => messages.some(m => m.kind === 'hello'));
  client.send(JSON.stringify({ kind: 'connect', config: cfg }));
  await waitFor(() => messages.some(m => m.kind === 'status' && m.status === 'connected'));
  assert.equal(upstreamEvents[0].type, 'session.start');
  assert.deepEqual(await fetch(app.url + '/api/draft').then(r => r.json()), cfg);
  await waitFor(() => upstreamEvents.some(e => e.type === 'session.input_audio.append'));
  client.send(Buffer.alloc(960, 1)); await waitFor(() => upstreamEvents.some(e => e.audio === Buffer.alloc(960,1).toString('base64')));
  remote.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' } }));
  await waitFor(() => messages.some(m => m.entry?.event.task?.status === 'waiting'));
  client.send(JSON.stringify({ kind: 'resume', id: 'd1' }));
  await waitFor(() => upstreamEvents.some(e => e.type === 'session.commentary.append' && e.delegation_id === 'd1'));
  client.send(JSON.stringify({ kind: 'send', event: { type: 'session.instructions.append', delegation_id: null, content: 'test-key-secret' } }));
  remote.send(JSON.stringify({ type: 'session.output_audio.delta', delta: 'AAAAAA==' }));
  remote.send(JSON.stringify({ type: 'session.output_transcript.delta', delta: 'hello', start_ms: 1, end_ms: 2 }));
  await waitFor(() => messages.some(m => m.kind === 'audio'));
  await waitFor(() => messages.some(m => m.entry?.event.type === 'session.instructions.appended'));
  const runId = messages.find(m => m.kind === 'run').run.id;
  const saved = await (await fetch(`${app.url}/api/runs/${runId}`)).json();
  assert.deepEqual(saved.connectionSource, connectionSource);
  assert.deepEqual(await fetch(app.url + '/api/connection-source').then(r => r.json()), connectionSource);
  assert.ok(connectionSource.code.includes(sessionStart.toString()));
  assert.deepEqual(saved.events.find(e => e.event.type === 'session.start').event.session, cfg.session);
  assert.equal(inspect(saved.events).appends.find(a => a.type === 'session.instructions.append').status, 'API確認済み');
  assert.ok(!JSON.stringify(saved).includes('test-key-secret'));
  assert.ok(saved.events.some(e => e.event.type === 'session.output_audio.delta' && !('delta' in e.event)));
  assert.ok(markdown(saved).includes('hello'));
  assert.equal((await fetch(app.url + '/.env')).status, 404);
  const invalidHostStatus = await new Promise((resolve, reject) => { const req = http.get(app.url, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(invalidHostStatus, 403);
  const denied = new WebSocket(app.url.replace('http:', 'ws:') + '/control', { origin: 'https://evil.example' });
  await new Promise(resolve => denied.on('error', resolve));
  client.send(JSON.stringify({ kind: 'disconnect' }));
  await waitFor(() => messages.some(m => m.kind === 'status' && m.status === 'disconnected'));
  assert.ok(upstreamEvents.some(e => e.type === 'session.close'));
  assert.equal((await fetch(app.url + '/api/status').then(r => r.json())).busy, false);
});

test('UI element references and module syntax are consistent', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(x => x[1]); assert.equal(ids.length, new Set(ids).size);
  for (const m of js.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(m[1]), `Missing ${m[1]}`);
});

test('capture worklet produces continuous 24kHz PCM frames across sample rates', async () => {
  const source = await readFile(new URL('../public/capture-worklet.js', import.meta.url), 'utf8');
  for (const rate of [24000, 44100, 48000]) {
    const frames = []; let Processor;
    const context = vm.createContext({ sampleRate: rate, AudioWorkletProcessor: class { constructor() { this.port = { postMessage: buffer => frames.push(new Int16Array(buffer)) }; } }, registerProcessor: (name, ctor) => { Processor = ctor; } });
    vm.runInContext(source, context); const processor = new Processor();
    for (let n = 0; n < Math.ceil(rate / 128); n++) processor.process([[new Float32Array(128).fill(0.5)]], [[new Float32Array(128)]]);
    assert.ok(frames.length >= 49 && frames.length <= 50, `${rate}: ${frames.length}`);
    assert.ok(frames.every(frame => frame.length === 480 && [...frame].every(x => x === 16384)));
  }
});

test('idle safety closes silent sessions; only user transcript extends deadline; reconnect gets a fresh timer', async t => {
  const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => fake.once('listening', r));
  let remote; const closes = [];
  fake.on('connection', ws => { remote = ws; ws.on('message', buffer => {
    const e = JSON.parse(buffer);
    if (e.type === 'session.start') ws.send(JSON.stringify({ type: 'session.started', session: e.session }));
    if (e.type === 'session.close') { closes.push(Date.now()); ws.send(JSON.stringify({ type: 'session.closed' })); }
  }); });
  const app = await startServer({ port: 0, apiKey: 'test-key', endpoint: `ws://127.0.0.1:${fake.address().port}`, dataDir: await mkdtemp(path.join(os.tmpdir(), 'live-idle-')), userIdleMs: 400 });
  const client = new WebSocket(app.url.replace('http:', 'ws:') + '/control', { origin: app.url });
  const messages = []; client.on('message', d => messages.push(JSON.parse(d)));
  t.after(async () => { client.terminate(); for (const c of fake.clients) c.terminate(); await app.close(); await new Promise(r => fake.close(r)); });
  await new Promise(r => client.once('open', r));
  const config = { mode: 'manual', code: 'export async function onDelegation(){}', session: { model: 'gpt-live-1', instructions: '', audio: { format: { type: 'audio/pcm', rate: 24000 } }, delegation: { type: 'client', acknowledgement_delay_ms: 800 } } };
  const connect = () => client.send(JSON.stringify({ kind: 'connect', config }));
  connect(); await waitFor(() => messages.some(m => m.status === 'connected'));
  await new Promise(r => setTimeout(r, 200));
  remote.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: 'こんにちは' }));
  await waitFor(() => messages.some(m => m.entry?.event.delta === 'こんにちは'));
  await new Promise(r => setTimeout(r, 250));
  assert.equal(closes.length, 0, 'user speech must extend the original deadline');
  const noise = setInterval(() => { if (remote.readyState === WebSocket.OPEN) { remote.send(JSON.stringify({ type: 'session.output_transcript.delta', delta: 'AI is talking' })); remote.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: ' ' })); } }, 30);
  t.after(() => clearInterval(noise));
  await waitFor(() => closes.length === 1); clearInterval(noise);
  await waitFor(() => messages.some(m => m.status === 'disconnected' && m.reason.includes('自動切断')));
  assert.ok(messages.some(m => m.entry?.event.type === 'connection.user_idle_timeout'));
  connect(); await waitFor(() => messages.filter(m => m.status === 'connected').length === 2);
  await waitFor(() => closes.length === 2);
  assert.ok(messages.filter(m => m.entry?.event.type === 'connection.user_idle_timeout').length === 2);
});
