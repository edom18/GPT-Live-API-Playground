import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const failure = (message, status) => Object.assign(new Error(message), { status });

export function voiceRequest(input) {
  const string = (key, max) => {
    if (typeof input?.[key] !== 'string' || !input[key].trim() || input[key].length > max) throw failure(`${key} は1〜${max}文字で指定してください`, 400);
    return input[key].trim();
  };
  const request = { type: 'prompt', name: string('name', 256), prompt: string('prompt', 2000), model: 'auto' };
  if (input.script_hint !== undefined && input.script_hint !== '') request.script_hint = string('script_hint', 2000);
  return request;
}

export function apiKeyValue(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!/^[\x21-\x7e]{1,512}$/.test(key)) throw failure('APIキーを入力してください（空白を含まない512文字以内）', 400);
  return key;
}

// One request per call. Never retried: a lost response may still have created the voice.
async function requestVoice({ apiKey, request, fetchImpl, endpoint }) {
  let response;
  try {
    response = await fetchImpl(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(120000) });
  } catch {
    throw failure('音声作成の通信が完了しませんでした。作成済みの可能性があるため、自動再試行はしません。OpenAIのVoices画面で確認してください。', 502);
  }
  let body;
  try { body = await response.json(); } catch { throw failure(`音声APIから不正な応答が返りました（HTTP ${response.status}）。再作成前にVoices画面を確認してください。`, 502); }
  if (!response.ok) throw failure(`音声作成エラー（HTTP ${response.status}）: ${body.error?.message || body.error?.code || '詳細なし'}`, response.status);
  if (typeof body.id !== 'string' || !body.id.startsWith('voice_')) throw failure('音声IDを取得できませんでした。Voices画面を確認してください。', 502);
  return { id: body.id, name: body.name || request.name, type: 'prompt', prompt: body.prompt || request.prompt,
    created_at: body.created_at, model: request.model, script_hint: request.script_hint };
}

// Rejects overlapping creations so a double submit cannot produce duplicate voices.
function exclusive() {
  let busy = false;
  return async task => {
    if (busy) throw failure('別の音声を作成中です。完了までお待ちください。', 409);
    busy = true;
    try { return await task(); } finally { busy = false; }
  };
}

const VOICES_ENDPOINT = 'https://api.openai.com/v1/audio/voices';

export function createVoiceStore({ dataDir, apiKey, safe, fetchImpl = fetch, endpoint = VOICES_ENDPOINT }) {
  const dir = path.join(dataDir, 'voices');
  const once = exclusive();
  return {
    async list() {
      await mkdir(dir, { recursive: true });
      const entries = [];
      for (const name of await readdir(dir)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        entries.push(JSON.parse(await readFile(path.join(dir, name), 'utf8')));
      }
      return entries.sort((a, b) => b.saved_at.localeCompare(a.saved_at));
    },
    async create(input) {
      if (!apiKey) throw failure('.env の OPENAI_API_KEY を設定してサーバーを再起動してください', 400);
      const request = voiceRequest(input);
      return once(async () => {
        const voice = safe({ ...await requestVoice({ apiKey, request, fetchImpl, endpoint }), saved_at: new Date().toISOString() });
        try {
          await mkdir(dir, { recursive: true });
          const filename = createHash('sha256').update(voice.id).digest('hex') + '.json';
          await writeFile(path.join(dir, filename), JSON.stringify(voice, null, 2), { flag: 'wx' });
        } catch (error) {
          if (error.code !== 'EEXIST') return { voice, warning: 'OpenAIでの作成は成功しましたが、ローカル保存に失敗しました。表示されたIDを控えてください。再作成は不要です。' };
        }
        return { voice };
      });
    },
  };
}

// Standalone creator: the caller supplies the API key per request; nothing is stored.
export function createVoiceCreator({ fetchImpl = fetch, endpoint = VOICES_ENDPOINT } = {}) {
  const once = exclusive();
  return {
    async create(input) {
      const apiKey = apiKeyValue(input?.apiKey);
      const request = voiceRequest(input);
      return { voice: await once(() => requestVoice({ apiKey, request, fetchImpl, endpoint })) };
    },
  };
}
