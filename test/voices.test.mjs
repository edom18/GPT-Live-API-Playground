import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { voiceRequest, createVoiceStore } from '../lib/voices.mjs';
import { voiceSetting, voiceValue } from '../public/voice-setting.js';
import { sessionStart } from '../lib/connection.mjs';
import { startServer } from '../server.mjs';

test('prompt voice request follows schema and omits optional blank script', () => {
  assert.deepEqual(voiceRequest({ name: 'Guide', prompt: 'Adult voice', script_hint: '' }), { type: 'prompt', name: 'Guide', prompt: 'Adult voice', model: 'auto' });
  assert.throws(() => voiceRequest({ name: ' ', prompt: 'Adult voice' }));
  assert.throws(() => voiceRequest({ name: 'Guide', prompt: 'a'.repeat(2001) }));
  assert.throws(() => voiceRequest({ name: 'Guide', prompt: 'Adult voice', script_hint: ' ' }));
});

test('custom voice ID survives setting, session.start and restoration; built-in stays string', () => {
  const voice = voiceSetting(' voice_example ');
  assert.deepEqual(voice, { id: 'voice_example' });
  const wire = JSON.parse(JSON.stringify(sessionStart({ audio: { output: { voice } } })));
  assert.equal(voiceValue(wire.session.audio.output.voice), 'voice_example');
  assert.equal(voiceSetting('marin'), 'marin');
  assert.equal(voiceValue('marin'), 'marin');
});

test('voice routes persist metadata, reuse without API calls, reject cross-origin and mask API errors', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'live-voices-'));
  const requests = []; let fail = false;
  const voiceFetch = async (url, options) => {
    requests.push({ url, options });
    return fail ? Response.json({ error: { message: 'invalid key test-voice-secret' } }, { status: 401 })
      : Response.json({ id: 'voice_saved', object: 'audio.voice', name: '成人の声', type: 'prompt', prompt: '自然な日本語を話す成人の声', created_at: 123 });
  };
  const app = await startServer({ port: 0, apiKey: 'test-voice-secret', dataDir, voiceFetch });
  t.after(() => app.close());
  const post = (body, origin = app.url) => fetch(`${app.url}/api/voices`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  const input = { name: '成人の声', prompt: '自然な日本語を話す成人の声', script_hint: 'こんにちは。今日はどんなことをお手伝いしましょうか。' };
  assert.equal((await post(input, 'https://untrusted.example')).status, 403);
  assert.equal(requests.length, 0);
  assert.equal((await post({ name: 'x', prompt: '' })).status, 400);
  const res = await post(input); assert.equal(res.status, 200);
  const created = await res.json(); assert.equal(created.voice.id, 'voice_saved');
  assert.deepEqual(JSON.parse(requests[0].options.body), { ...input, type: 'prompt', model: 'auto' });
  assert.equal(requests[0].url, 'https://api.openai.com/v1/audio/voices');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-voice-secret');
  const saved = await fetch(`${app.url}/api/voices`).then(r => r.json());
  assert.equal(saved[0].prompt, input.prompt); assert.equal(requests.length, 1);
  const reopened = createVoiceStore({ dataDir, apiKey: 'test-voice-secret', safe: x => x, fetchImpl: voiceFetch });
  assert.equal((await reopened.list())[0].id, 'voice_saved'); assert.equal(requests.length, 1);
  fail = true;
  const failed = await post(input); assert.equal(failed.status, 401);
  assert.ok(!(await failed.text()).includes('test-voice-secret'));
  assert.equal((await reopened.list()).length, 1);
});

test('concurrent creation is rejected instead of producing duplicate voices', async () => {
  let release;
  const store = createVoiceStore({ dataDir: await mkdtemp(path.join(os.tmpdir(), 'live-voice-busy-')), apiKey: 'test', safe: x => x,
    fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const input = { name: 'Test', prompt: 'Adult voice' };
  const first = store.create(input);
  await assert.rejects(store.create(input), error => error.status === 409);
  release(Response.json({ id: 'voice_one', name: 'Test', type: 'prompt', created_at: 1 }));
  assert.equal((await first).voice.id, 'voice_one');
});

test('voice creator page uses the per-request key, never stores or echoes it', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'live-voice-creator-'));
  const requests = []; let fail = false;
  const voiceFetch = async (url, options) => {
    requests.push({ url, options });
    return fail ? Response.json({ error: { message: 'Incorrect API key provided: user-key-12345' } }, { status: 401 })
      : Response.json({ id: 'voice_tool', name: 'Tool', type: 'prompt', prompt: 'Adult voice', created_at: 1 });
  };
  const app = await startServer({ port: 0, apiKey: 'server-env-key', dataDir, voiceFetch });
  t.after(() => app.close());
  const post = (body, origin = app.url) => fetch(`${app.url}/api/voice-creator`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  const input = { apiKey: ' user-key-12345 ', name: 'Tool', prompt: 'Adult voice' };
  assert.equal((await fetch(`${app.url}/voice-creator`)).status, 200);
  assert.equal((await post(input, 'https://untrusted.example')).status, 403);
  assert.equal((await post({ ...input, apiKey: '' })).status, 400);
  assert.equal((await post({ ...input, apiKey: 'has space' })).status, 400);
  assert.equal(requests.length, 0);
  const res = await post(input); assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(JSON.parse(text).voice.id, 'voice_tool');
  assert.ok(!text.includes('user-key-12345'));
  assert.equal(requests[0].options.headers.Authorization, 'Bearer user-key-12345');
  assert.deepEqual(JSON.parse(requests[0].options.body), { type: 'prompt', name: 'Tool', prompt: 'Adult voice', model: 'auto' });
  assert.deepEqual(await fetch(`${app.url}/api/voices`).then(r => r.json()), []);
  fail = true;
  const failed = await post(input); assert.equal(failed.status, 401);
  const failedText = await failed.text();
  assert.ok(failedText.includes('[REDACTED]') && !failedText.includes('user-key-12345'));
});
