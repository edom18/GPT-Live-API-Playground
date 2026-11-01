export function inspect(events, cutoff = Infinity) {
  const state = { initial: null, confirmedSession: null, appends: [], transcripts: { input: '', output: '' }, tasks: {}, usage: null };
  const byId = new Map();
  for (const row of events) {
    if (row.seq > cutoff) break;
    const e = row.event;
    if (row.direction === 'SEND' && e.type === 'session.start') state.initial = e.session;
    if (row.direction === 'RECV' && ['session.started', 'session.updated'].includes(e.type)) state.confirmedSession = e.session;
    if (row.direction === 'SEND' && /^session\.(instructions|thinking|commentary)\.append$/.test(e.type)) {
      const item = { ...e, seq: row.seq, elapsedMs: row.elapsedMs, status: '未確認' }; state.appends.push(item); byId.set(e.event_id, item);
    }
    if (row.direction === 'RECV') {
      const id = e.client_event_id || e.error?.client_event_id;
      const item = byId.get(id);
      if (item && e.type === item.type + 'ed') { item.status = 'API確認済み'; item.confirmedAt = row.elapsedMs; item.timeline = [e.start_ms, e.end_ms]; }
      if (item && e.type === 'error') { item.status = 'エラー'; item.error = e.error || e; }
      if (e.type === 'session.input_transcript.delta') state.transcripts.input += e.delta || '';
      if (e.type === 'session.output_transcript.delta') state.transcripts.output += e.delta || '';
      if (e.type === 'session.usage.updated') state.usage = e;
    }
    if (e.type === 'handler.state') state.tasks[e.task.id] = e.task;
  }
  return state;
}

export function markdown(run) {
  const events = run.events || [];
  const state = inspect(events);
  const block = data => { const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2); const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(x => x[0].length)); const fence = '`'.repeat(longest + 1); return `${fence}\n${text}\n${fence}`; };
  return `# ${run.config?.title || 'GPT-Live実験'}\n\n日時: ${run.startedAt}\n実験ID: ${run.id}\nコードSHA256: ${run.codeHash}\n\n## 実験条件\n${block(run.config)}\n\n## 観測した文字起こし\n### 入力\n${block(state.transcripts.input)}\n### 出力\n${block(state.transcripts.output)}\n\n## appendの確認状況\n${block(state.appends)}\n\n## 時系列ログ\n${block(events)}\n\n## 解釈と限界\n- 送信、API確認、文字起こし、ブラウザ再生は別の観測です。\n- 文字起こしはフラグメントを受信順に連結。完全なターン境界は推定していません。\n- ブラウザ再生記録はWeb Audioの予定時刻・終了コールバックであり、耳に届いた時刻の保証ではありません。\n- 音声本体は保存していません。モデル内部や圧縮後の完全なプロンプトは取得していません。\n- 環境変数の秘密情報と既知の認証フィールドをマスクしています。公開前に本文も確認してください。\n\n## 考察（追記用）\n\n`;
}
