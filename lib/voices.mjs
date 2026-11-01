import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export function voiceRequest(input) {
  const string = (key, max) => {
    if (typeof input?.[key] !== 'string' || !input[key].trim() || input[key].length > max) {
      throw Object.assign(new Error(`${key} は1〜${max}文字で指定してください`), { status: 400 });
    }
    return input[key].trim();
  };
  const request = { type: 'prompt', name: string('name', 256), prompt: string('prompt', 2000), model: 'auto' };
  if (input.script_hint !== undefined && input.script_hint !== '') request.script_hint = string('script_hint', 2000);
  return request;
}

export function createVoiceStore({ dataDir, apiKey, safe, fetchImpl = fetch, endpoint = 'https://api.openai.com/v1/audio/voices' }) {
  const dir = path.join(dataDir, 'voices');
  let busy = false;
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
      if (!apiKey) throw Object.assign(new Error('.env の OPENAI_API_KEY を設定してサーバーを再起動してください'), { status: 400 });
      const request = voiceRequest(input);
      if (busy) throw Object.assign(new Error('別の音声を作成中です。完了までお待ちください。'), { status: 409 });
      busy = true;
      try {
        let response;
        try {
          response = await fetchImpl(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(120000) });
        } catch {
          throw Object.assign(new Error('音声作成の通信が完了しませんでした。作成済みの可能性があるため、自動再試行はしません。OpenAIのVoices画面で確認してください。'), { status: 502 });
        }
        let body;
        try { body = await response.json(); } catch { throw Object.assign(new Error(`音声APIから不正な応答が返りました（HTTP ${response.status}）。再作成前にVoices画面を確認してください。`), { status: 502 }); }
        if (!response.ok) throw Object.assign(new Error(`音声作成エラー（HTTP ${response.status}）: ${body.error?.message || body.error?.code || '詳細なし'}`), { status: response.status });
        if (typeof body.id !== 'string' || !body.id.startsWith('voice_')) throw Object.assign(new Error('音声IDを取得できませんでした。Voices画面を確認してください。'), { status: 502 });
        const voice = safe({ id: body.id, name: body.name || request.name, type: 'prompt', prompt: body.prompt || request.prompt,
          created_at: body.created_at, saved_at: new Date().toISOString(), model: request.model, script_hint: request.script_hint });
        try {
          await mkdir(dir, { recursive: true });
          const filename = createHash('sha256').update(voice.id).digest('hex') + '.json';
          await writeFile(path.join(dir, filename), JSON.stringify(voice, null, 2), { flag: 'wx' });
        } catch (error) {
          if (error.code !== 'EEXIST') return { voice, warning: 'OpenAIでの作成は成功しましたが、ローカル保存に失敗しました。表示されたIDを控えてください。再作成は不要です。' };
        }
        return { voice };
      } finally { busy = false; }
    },
  };
}
