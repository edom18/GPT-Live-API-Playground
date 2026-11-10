import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { startServer } from '../server.mjs';
import { voiceTestSession } from '../lib/voice-test.mjs';
const waitFor = async predicate => { for (let i = 0; i < 200; i++) { const result = predicate(); if (result) return result; await new Promise(r => setTimeout(r, 20)); } throw new Error('Timed out'); };

test('voice test session validates key, custom voice ID and instructions', () => {
  const valid = voiceTestSession({ apiKey: ' k-123 ', voice: 'voice_abc', instructions: 'hi' });
  assert.equal(valid.apiKey, 'k-123');
  assert.deepEqual(valid.session, { model: 'gpt-live-1', instructions: 'hi', audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: { id: 'voice_abc' } } } });
  assert.throws(() => voiceTestSession({ apiKey: '', voice: 'voice_abc', instructions: '' }));
  assert.throws(() => voiceTestSession({ apiKey: 'k', voice: 'marin', instructions: '' }));
  assert.throws(() => voiceTestSession({ apiKey: 'k', voice: 'voice_abc', instructions: 'a'.repeat(20001) }));
});

test('voice test talks to Live with the page key, relays audio and transcripts, stores nothing', async t => {
  const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => fake.once('listening', resolve));
  const upstream = []; let auth;
  fake.on('connection', (ws, req) => { auth = req.headers.authorization; ws.on('message', data => {
    const e = JSON.parse(data.toString()); upstream.push(e);
    if (e.type === 'session.start') {
      ws.send(JSON.stringify({ type: 'session.started', session: { id: 'live_test' } }));
      ws.send(JSON.stringify({ type: 'session.output_audio.delta', delta: 'AAAA' }));
      ws.send(JSON.stringify({ type: 'session.output_transcript.delta', delta: 'こんにちは' }));
      ws.send(JSON.stringify({ type: 'error', error: { message: 'echo page-key-999' } }));
    }
    if (e.type === 'session.close') ws.send(JSON.stringify({ type: 'session.closed' }));
  }); });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'live-voice-test-'));
  const app = await startServer({ port: 0, apiKey: 'server-env-key', endpoint: `ws://127.0.0.1:${fake.address().port}`, dataDir });
  t.after(async () => { for (const c of fake.clients) c.terminate(); await app.close(); await new Promise(r => fake.close(r)); });
  const wsUrl = app.url.replace('http:', 'ws:') + '/voice-test';
  const rejected = new WebSocket(wsUrl, { origin: 'https://untrusted.example' });
  await new Promise(resolve => rejected.once('error', resolve));
  const messages = []; const client = new WebSocket(wsUrl, { origin: app.url });
  client.on('message', d => messages.push(JSON.parse(d.toString())));
  await new Promise(resolve => client.once('open', resolve));
  client.send(JSON.stringify({ kind: 'start', apiKey: 'page-key-999', voice: 'voice_abc', instructions: 'Voice description: calm' }));
  await waitFor(() => messages.some(m => m.kind === 'status' && m.status === 'connected'));
  assert.equal(auth, 'Bearer page-key-999');
  assert.deepEqual(upstream[0].session.audio.output.voice, { id: 'voice_abc' });
  assert.equal(upstream[0].session.instructions, 'Voice description: calm');
  await waitFor(() => messages.some(m => m.kind === 'transcript'));
  assert.ok(messages.some(m => m.kind === 'audio' && m.audio === 'AAAA'));
  assert.deepEqual(messages.find(m => m.kind === 'transcript'), { kind: 'transcript', role: 'assistant', delta: 'こんにちは' });
  client.send(Buffer.alloc(960, 1));
  await waitFor(() => upstream.some(e => e.type === 'session.input_audio.append' && e.audio !== Buffer.alloc(960).toString('base64')));
  client.send(JSON.stringify({ kind: 'stop' }));
  await waitFor(() => messages.some(m => m.kind === 'status' && m.status === 'disconnected'));
  assert.ok(upstream.some(e => e.type === 'session.close'));
  const debug = messages.filter(m => m.kind === 'debug');
  assert.deepEqual(debug.find(m => m.direction === 'SEND' && m.event.type === 'session.start').event.session.audio.output.voice, { id: 'voice_abc' });
  assert.equal(debug.find(m => m.direction === 'RECV' && m.event.type === 'session.started').event.session.id, 'live_test');
  assert.ok(debug.some(m => m.direction === 'SEND' && m.event.type === 'session.close' && m.event.event_id));
  assert.ok(!debug.some(m => /audio\.(append|delta)$/.test(m.event.type)));
  assert.ok(!JSON.stringify(messages).includes('page-key-999'));
  assert.deepEqual(await readdir(dataDir), []);
  client.terminate();
});
