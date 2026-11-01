import { inspect, markdown } from './state.js';
import { AudioIO } from './audio.js';
import { voiceSetting, voiceValue } from './voice-setting.js';
import { setupVoices } from './voices.js';
const $ = id => document.getElementById(id);
let socket, liveRun = null, viewedRun = null, selected = null, status = 'disconnected', micOn = false, micBusy = false, redrawTimer, reconnectTimer, draftTimer;
const presets = kind => `export async function onDelegation(event, ctx) {
  const { send, log, checkpoint, sleep, parameters, transcript } = ctx;
  const id = event.delegation.id;
  // 委譲イベントはタスク本文を含みません。必要ならtranscriptを参照します。
  ${kind === 'silent' ? 'await send({ type: "session.thinking.append", delegation_id: id, content: "" });' : kind === 'speak' ? 'await send({ type: "session.commentary.append", delegation_id: id, content: "ちょっと調べてくるね！" });' : '// 自動応答と比較するため、ここでは何も送りません。'}
  log("委譲開始", { id, input: transcript.input });
  await checkpoint("開始直後");
  await sleep(parameters.waitMs);
  log("模擬結果を準備しました");
  await checkpoint("結果返却前");
  await send({
    type: "session.commentary.append",
    delegation_id: id,
    content: parameters.result
  });
  log("結果を送信しました（API確認・発話とは別）");
}`;
const templates = {
  'session.thinking.append': { delegation_id: null, content: '' },
  'session.commentary.append': { delegation_id: null, content: '調査を進めています。' },
  'session.instructions.append': { delegation_id: null, content: '簡潔に日本語で話してください。' },
  'session.update': { session: { delegation: { type: 'client', acknowledgement_delay_ms: 800 } } },
  'session.input_audio.mute': {}, 'session.input_audio.unmute': {}, 'session.close': {},
};
function toast(message) { $('toast').textContent = message; $('toast').classList.remove('hidden'); clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 5000); }
function error(message) { $('errors').textContent = message; $('errors').classList.remove('hidden'); }
const DEFAULT_INSTRUCTIONS = 'あなたは親しみやすい日本語の音声アシスタントです。簡潔に話してください。\nBackend tools: 調査・複雑な推論はバックエンドへ委譲できます。\nGenerate <|SpawnThinking|> when:\n- ユーザーの要求に外部情報の調査や複雑な推論が必要な場合。\n結果を受け取る前に成功や調査内容を断定しないでください。';
function setupInstructionPresets() {
  const key = 'gpt-live-lab.instructions.v1';
  const note = text => { $('instructionsSaveStatus').textContent = text; };
  const read = () => {
    const saved = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(saved) || saved.some(item => !item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.content !== 'string')) {
      throw new Error('保存済みinstructionsの形式が不正です');
    }
    return saved;
  };
  const updateButtons = () => {
    const empty = !$('savedInstructions').value;
    $('loadInstructions').disabled = empty;
    $('deleteInstructions').disabled = empty;
  };
  const renderSaved = (items, selected = $('savedInstructions').value) => {
    $('savedInstructions').replaceChildren(new Option('保存した内容を選択', ''));
    for (const item of items) $('savedInstructions').add(new Option(item.name, item.id));
    if (items.some(item => item.id === selected)) $('savedInstructions').value = selected;
    updateButtons();
  };
  const action = fn => () => { try { fn(); } catch (e) { note(`保存操作に失敗しました: ${e.message}`); } };
  $('savedInstructions').onchange = updateButtons;
  $('resetInstructions').onclick = () => {
    $('instructions').value = DEFAULT_INSTRUCTIONS;
    $('instructionName').value = '';
    $('savedInstructions').value = '';
    updateButtons();
    dirty();
    note('初期instructionsを標準の内容に戻しました。保存済みの内容は残ります。次回接続から反映します。');
  };
  $('saveInstructions').onclick = action(() => {
    const name = $('instructionName').value.trim();
    if (!name) { note('保存名を入力してください。'); $('instructionName').focus(); return; }
    const items = read();
    if (items.some(item => item.name === name)) { note('同じ名前が保存されています。別の保存名を指定してください。'); return; }
    const item = { id: crypto.randomUUID(), name, content: $('instructions').value };
    items.push(item);
    localStorage.setItem(key, JSON.stringify(items));
    renderSaved(items, item.id);
    note(`「${name}」をこのブラウザに保存しました。`);
  });
  $('loadInstructions').onclick = action(() => {
    const item = read().find(item => item.id === $('savedInstructions').value);
    if (!item) { renderSaved(read()); return; }
    $('instructions').value = item.content;
    $('instructionName').value = item.name;
    dirty();
    note(`「${item.name}」を読み込みました。次回接続から反映します。`);
  });
  $('deleteInstructions').onclick = action(() => {
    const items = read();
    const item = items.find(item => item.id === $('savedInstructions').value);
    if (!item || !confirm(`保存済みの「${item.name}」を削除しますか？ 編集中の内容は残ります。`)) return;
    const remaining = items.filter(saved => saved.id !== item.id);
    localStorage.setItem(key, JSON.stringify(remaining));
    renderSaved(remaining);
    note(`保存済みの「${item.name}」を削除しました。`);
  });
  window.addEventListener('storage', event => { if (event.key === key || event.key === null) action(() => renderSaved(read()))(); });
  action(() => renderSaved(read()))();
}
function command(m) { if (socket?.readyState !== WebSocket.OPEN) throw new Error('ローカルサーバーへ接続されていません'); socket.send(JSON.stringify(m)); }
function send(event) { if (status !== 'connected') throw new Error('Liveへ接続してください'); command({ kind: 'send', event }); }
function bind(id, action) { $(id).addEventListener('click', async () => { try { await action(); } catch (e) { error(e.message); } }); }
function browserEvent(event) { if (liveRun && socket?.readyState === WebSocket.OPEN) command({ kind: 'browser', runId: liveRun.id, event }); }
const audio = new AudioIO({ onFrame: frame => { if (status === 'connected' && socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 96000) socket.send(frame); }, onEvent: browserEvent });
function config() {
  const initial = $('initialText').value;
  const session = { model: $('model').value.trim(), instructions: $('instructions').value,
    audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: voiceSetting($('voice').value) } },
    delegation: { type: 'client', acknowledgement_delay_ms: Number($('delay').value) } };
  if (initial) session.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: initial }] }];
  return { title: $('title').value, session, code: $('code').value, mode: $('mode').value,
    browserSource: `${voiceSetting.toString()}\n\n${config.toString()}\n\n${command.toString()}`,
    parameters: { waitMs: Math.max(0, Math.min(600000, Number($('waitMs').value) || 0)), result: $('result').value } };
}
function applyConfig(c) {
  $('title').value = c.title || '委譲中の一言を比較'; $('model').value = c.session.model; $('instructions').value = c.session.instructions;
  $('voice').value = voiceValue(c.session.audio.output.voice); $('delay').value = c.session.delegation.acknowledgement_delay_ms;
  $('initialText').value = c.session.input?.find(x => x.role === 'user')?.content?.[0]?.text || '';
  $('code').value = c.code; $('mode').value = c.mode; $('waitMs').value = c.parameters?.waitMs ?? 3000; $('result').value = c.parameters?.result ?? '';
  dirty();
}
function dirty() {
  $('dirty').textContent = liveRun && JSON.stringify(config()) !== JSON.stringify(liveRun.config) ? '編集内容あり · 次回接続に反映' : '';
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { if (socket?.readyState === WebSocket.OPEN) command({ kind: 'draft', config: config() }); }, 700);
}
function setStatus(s) {
  status = s;
  $('status').textContent = { connected: '● Live 接続中', connecting: '○ Live 接続中…', disconnected: '○ Live 未接続' }[s] || s;
  $('connect').disabled = s === 'connecting'; $('disconnect').disabled = s === 'disconnected';
  $('connect').textContent = s === 'connected' ? '最新設定で再接続' : '最新設定で接続';
  for (const id of ['send','rawSend','chatSend','mic']) $(id).disabled = s !== 'connected';
  if (s === 'disconnected') { audio.stop(); micOn = false; $('mic').textContent = 'マイク ON'; $('audioState').textContent = 'マイク OFF'; refreshHistory(); }
}
function openControl() {
  socket = new WebSocket(`ws://${location.host}/control`);
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.kind === 'hello') $('keyStatus').textContent = m.keyConfigured ? 'APIキー設定済み' : 'APIキー未設定（.env）';
    if (m.kind === 'run') { liveRun = { ...m.run, events: [] }; viewedRun = liveRun; selected = null; $('revision').textContent = m.run.codeHash.slice(0, 8); $('runMode').textContent = m.run.config.mode === 'manual' ? '手動モード' : '自動モード'; dirty(); render(); }
    if (m.kind === 'status') { setStatus(m.status); if (m.reason) toast(m.reason); }
    if (m.kind === 'error') { error(m.message); if (status === 'connecting') setStatus('disconnected'); }
    if (m.kind === 'event' && liveRun?.id === m.runId) { liveRun.events.push(m.entry); scheduleRender(); }
    if (m.kind === 'audio' && liveRun?.id === m.runId) audio.play(m.audio, m.sourceSeq);
  };
  socket.onclose = () => { setStatus('disconnected'); $('keyStatus').textContent = 'ローカルサーバーとの接続が切れました'; clearTimeout(reconnectTimer); reconnectTimer = setTimeout(openControl, 3000); };
}
setInterval(() => { if (socket?.readyState === WebSocket.OPEN) command({ kind: 'ping' }); }, 10000);
function scheduleRender() { if (!redrawTimer) redrawTimer = setTimeout(() => { redrawTimer = null; render(); }, 250); }
function element(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
function time(ms) { return (ms / 1000).toFixed(3) + 's'; }
function render() {
  const run = viewedRun; const events = run?.events || []; const state = inspect(events, selected ?? Infinity);
  $('viewMode').textContent = run && run !== liveRun ? '保存済み実験を表示中（操作対象は実行中セッション）' : '';
  $('inputTranscript').textContent = state.transcripts.input || 'まだありません'; $('outputTranscript').textContent = state.transcripts.output || 'まだありません';
  $('timepoint').textContent = selected ? `イベント #${selected} 時点` : '現在';
  $('confirmed').textContent = JSON.stringify(state.confirmedSession, null, 2); $('usage').textContent = JSON.stringify(state.usage, null, 2);
  const context = $('context'); const initialOpen = context.querySelector('details')?.open; const scroll = context.scrollTop; context.replaceChildren();
  const initial = element('details'); initial.open = Boolean(initialOpen); const summary = element('summary', '初期指示・入力（送信内容）'); initial.append(summary, element('pre', JSON.stringify(state.initial ? { instructions: state.initial.instructions, input: state.initial.input || [] } : {}, null, 2))); context.append(initial);
  for (const a of state.appends) {
    const box = element('div', undefined, 'context'); box.append(element('b', a.type), element('p', a.content === '' ? '（空文字）' : a.content), element('small', `${a.status} · ID: ${a.delegation_id ?? 'null'} · ${time(a.elapsedMs)}`));
    if (a.confirmedAt !== undefined) box.append(element('p', `確認まで ${a.confirmedAt-a.elapsedMs}ms / API timeline ${a.timeline.join('–')}ms`, 'hint'));
    if (a.error) box.append(element('pre', JSON.stringify(a.error, null, 2)));
    context.append(box);
  }
  context.scrollTop = scroll;
  // Task controls always operate on the live run; historical state stays read-only.
  const taskState = inspect(events).tasks; $('tasks').replaceChildren(); $('taskCount').textContent = `${Object.keys(taskState).length}件`;
  for (const task of Object.values(taskState)) {
    const box = element('div', undefined, 'task'); box.append(element('b', { running: '実行中', waiting: '待機中', completed: 'ローカル処理完了', failed: 'エラー', cancelled: '中止' }[task.status] || task.status), element('p', task.id, 'mono'), element('p', task.checkpoint || task.error || ''));
    const next = element('button', 'この委譲を次へ →', 'primary'); next.disabled = task.status !== 'waiting' || run !== liveRun || status !== 'connected'; next.onclick = () => { next.disabled = true; command({ kind: 'resume', id: task.id }); };
    const cancel = element('button', 'ローカル処理を中止'); cancel.disabled = !['waiting','running'].includes(task.status) || run !== liveRun || status !== 'connected'; cancel.onclick = () => command({ kind: 'cancel', id: task.id }); box.append(next, cancel); $('tasks').append(box);
  }
  const search = $('search').value.toLowerCase(); const filter = $('filter').value;
  const rows = events.filter(row => (filter === 'ALL' || filter === row.direction) && ($('showAudio').checked || !/^(session\.(input_audio\.append|output_audio\.delta)|playback\.(scheduled|chunk_ended))$/.test(row.event.type)) && (!search || JSON.stringify(row).toLowerCase().includes(search)));
  const list = $('events'); const wasBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 30; list.replaceChildren();
  for (const row of rows.slice(-300)) {
    const b = element('button', undefined, 'event' + (row.seq === selected ? ' selected' : ''));
    b.append(element('span', time(row.elapsedMs)), element('span', row.direction, row.direction === 'SEND' ? 'blue' : row.direction === 'LOG' ? 'amber' : 'green'), element('span', row.event.type));
    b.onclick = () => { selected = row.seq; $('detail').textContent = JSON.stringify(row, null, 2); $('diff').textContent = row.direction === 'SEND' && row.event.content !== undefined ? `+ ${row.event.type}\n${row.event.content || '（空文字）'}` : JSON.stringify(row.event, null, 2); render(); }; list.append(b);
  }
  if (wasBottom && !selected) list.scrollTop = list.scrollHeight;
  $('eventCount').textContent = `全${events.length}件 / 条件一致${rows.length}件 / 最新300件を表示（書き出しは全件）`;
}
function preview() { $('payload').textContent = JSON.stringify({ type: $('method').value, event_id: '送信時に自動生成', delegation_id: null, content: $('content').value }, null, 2); }
function rawTemplate() { const type = $('rawTemplate').value; $('rawCode').value = JSON.stringify({ type, ...templates[type] }, null, 2); }
let loadedConnectionSource;
async function renderConnectionCode() {
  const historical = $('connectionScope').value === 'run';
  const run = viewedRun;
  if (!loadedConnectionSource) {
    const res = await fetch('/api/connection-source');
    if (!res.ok) throw new Error('送信コードを取得できません。サーバーを最新版で再起動してください。');
    loadedConnectionSource = await res.json();
  }
  const source = historical ? run?.connectionSource : loadedConnectionSource;
  const sent = run?.events?.find(row => row.direction === 'SEND' && row.event.type === 'session.start');
  const ack = run?.events?.find(row => row.direction === 'RECV' && row.event.type === 'session.started');
  $('configSource').textContent = historical ? (run?.config?.browserSource || 'この実験にはブラウザコードの記録がありません。') : `${voiceSetting.toString()}\n\n${config.toString()}\n\n${command.toString()}`;
  $('connectionSource').textContent = source?.code || 'この実験には送信コードの記録がありません。更新前の実験に現在のコードを実行済みとして表示することはしません。';
  $('connectionHash').textContent = source ? `${source.file} · SHA256 ${source.sha256}` : '';
  $('connectionExplanation').textContent = historical
    ? (run ? `実験 ${run.id} / ${run.startedAt}。開始時に保存したソースと送信ログです。表示はモーダルを開いた時点のスナップショットです。` : '表示する実験がありません。')
    : '現在ロードされた関数のソースです。接続ボタン → config() → command({ kind: "connect", config: config() }) → Nodeで検証 → openLiveSocket() → session.start の順に実行します。下の設定値は未送信です。';
  $('connectionPayloadTitle').textContent = historical ? '3. 実際のsession.start送信ログ（マスク済み）' : '3. この設定で渡すsession引数（未送信）';
  $('connectionPayload').textContent = historical ? (sent ? JSON.stringify(sent, null, 2) : 'session.startの送信記録がありません。') : JSON.stringify(config().session, null, 2);
  $('connectionAck').textContent = historical ? (ack ? JSON.stringify(ack, null, 2) : 'session.startedの受信記録がありません。送信済みと受理済みは別です。') : '未送信の設定にはAPI確認はありません。';
}
bind('showConnectionCode', async () => { $('connectionScope').value = viewedRun ? 'run' : 'draft'; await renderConnectionCode(); $('connectionDialog').showModal(); });
bind('closeConnectionCode', () => $('connectionDialog').close());
$('connectionScope').onchange = () => renderConnectionCode().catch(e => error(e.message));
async function refreshHistory() { try { const runs = await (await fetch('/api/runs')).json(); const selected = $('history').value; $('history').replaceChildren(new Option('実験を選択', '')); for (const run of runs) $('history').add(new Option(`${run.startedAt.slice(0,19)} · ${run.title}`, run.id)); $('history').value = selected; } catch {} }
async function fullRun() { if (!viewedRun) throw new Error('保存する実験がありません'); const res = await fetch(`/api/runs/${viewedRun.id}`); if (!res.ok) throw new Error('保存済み実験を取得できません'); return res.json(); }
async function download(md) { const run = await fullRun(); const text = md ? markdown(run) : JSON.stringify(run, null, 2); const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([text], { type: md ? 'text/markdown' : 'application/json' })); link.download = `${run.id}.${md ? 'md' : 'json'}`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }
bind('connect', async () => { await audio.unlock(); await audio.stop(); micOn = false; $('mic').textContent = 'マイク ON'; $('audioState').textContent = 'マイク OFF'; $('errors').classList.add('hidden'); setStatus('connecting'); try { command({ kind: 'connect', config: config() }); } catch(e) { setStatus('disconnected'); throw e; } });
bind('disconnect', () => command({ kind: 'disconnect' }));
bind('send', () => send({ type: $('method').value, delegation_id: null, content: $('content').value }));
bind('rawSend', () => send(JSON.parse($('rawCode').value)));
bind('chatSend', () => { if (!$('chat').value.trim()) return; send({ type: 'session.thinking.append', delegation_id: null, content: $('chat').value }); $('chat').value = ''; });
bind('mic', async () => { if (micBusy) return; micBusy = true; try { await audio.microphone(!micOn); micOn = Boolean(audio.stream); $('mic').textContent = micOn ? 'マイク OFF' : 'マイク ON'; $('audioState').textContent = micOn ? 'マイク ON · 入力中' : 'マイク OFF · 無音フレーム送信'; } finally { micBusy = false; } });
bind('stopAudio', () => { audio.stopPlayback(); browserEvent({ type: 'playback.stopped_locally' }); });
bind('latest', () => { selected = null; $('diff').textContent = '現在の送信履歴'; render(); });
bind('loadPreset', () => { $('code').value = presets($('preset').value); dirty(); toast('プリセットを読み込みました。次回接続から反映します。'); });
bind('exportJson', () => download(false)); bind('exportMd', () => download(true));
bind('loadHistory', async () => { if (!$('history').value) return; const res = await fetch('/api/runs/' + $('history').value); if (!res.ok) throw new Error('実験の取得に失敗しました'); viewedRun = await res.json(); selected = null; render(); });
bind('restore', () => { if (!viewedRun) return; applyConfig(viewedRun.config); toast('設定を編集欄に読み込みました。まだ接続していません。'); });
bind('liveView', () => { viewedRun = liveRun; selected = null; render(); });
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { document.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x === b)); document.querySelectorAll('.tab').forEach(x => x.classList.toggle('hidden', x.id !== b.dataset.tab)); });
for (const id of ['search','filter','showAudio']) $(id).addEventListener('input', render);
for (const id of ['title','model','voice','instructions','initialText','delay','mode','code','waitMs','result']) $(id).addEventListener('input', dirty);
$('method').onchange = preview; $('content').oninput = preview; $('rawTemplate').onchange = rawTemplate;
for (const name of Object.keys(templates)) $('rawTemplate').add(new Option(name, name));
$('instructions').value = DEFAULT_INSTRUCTIONS;
$('code').value = presets('silent');
try { const draft = await fetch('/api/draft').then(r => r.json()); if (draft) applyConfig(draft); } catch {}
preview(); rawTemplate(); setStatus('disconnected'); openControl(); render();
setupVoices({ dirty, toast });
setupInstructionPresets();
try { const { mountEditors } = await import('/editors.bundle.js'); mountEditors(); }
catch { toast('コードエディタを読み込めませんでした。通常の入力欄で編集できます。'); }
window.addEventListener('beforeunload', () => socket?.close());
