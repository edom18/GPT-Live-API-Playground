import { AudioIO } from './audio.js';

const $ = id => document.getElementById(id);
const message = text => { $('voiceMessage').textContent = text; };
let creating = false, voice = null;

$('voiceForm').onsubmit = async event => {
  event.preventDefault(); if (creating || !$('voiceForm').reportValidity()) return;
  const request = { apiKey: $('apiKey').value.trim(), name: $('voiceName').value.trim(), prompt: $('voicePrompt').value.trim() };
  if ($('voiceScript').value.trim()) request.script_hint = $('voiceScript').value.trim();
  creating = true; $('createVoice').disabled = true; $('createVoice').textContent = '作成中…';
  message('OpenAIで音声を作成しています。完了までお待ちください。');
  try {
    const res = await fetch('/api/voice-creator', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    const result = await res.json(); if (!res.ok) throw new Error(result.error || '作成に失敗しました');
    voice = result.voice;
    $('voiceId').textContent = voice.id;
    $('voiceDetails').textContent = JSON.stringify(voice, null, 2);
    $('voiceResult').hidden = false;
    // A test of the previous voice must not continue under the new voice's heading.
    if (status !== 'disconnected') command({ kind: 'stop' });
    $('voiceTest').hidden = true; $('testInstructions').value = ''; $('testTranscript').replaceChildren(); $('debugLog').replaceChildren(); $('debugCount').textContent = 0;
    message(`「${voice.name}」を作成しました。下のIDを控えてください。`);
  } catch (error) { message(`${error.message} 自動再試行は行っていません。`); }
  finally { creating = false; $('createVoice').disabled = false; $('createVoice').textContent = '作成する'; }
};

$('copyVoiceId').onclick = async () => {
  try { await navigator.clipboard.writeText($('voiceId').textContent); message('IDをコピーしました。'); }
  catch { message('コピーできませんでした。IDを選択してコピーしてください。'); }
};

// --- Live test of the created voice ---
let socket, status = 'disconnected', micOn = false;
const audio = new AudioIO({
  onFrame: frame => { if (status === 'connected' && socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 96000) socket.send(frame); },
  onEvent: () => {},
});
const testStatus = text => { $('testStatus').textContent = text; };
function setStatus(next) {
  status = next;
  $('startTest').disabled = next !== 'disconnected';
  $('stopTest').disabled = next === 'disconnected';
  $('testMic').disabled = next !== 'connected';
  testStatus({ disconnected: '未接続', connecting: '接続中…', connected: '会話中' }[next]);
}
async function setMic(on) {
  await audio.microphone(on); micOn = Boolean(audio.stream);
  $('testMic').textContent = micOn ? 'マイク OFF' : 'マイク ON';
}
function addTranscript(role, delta) {
  const last = $('testTranscript').lastElementChild;
  if (last?.dataset.role === role) { last.lastChild.textContent += delta; return; }
  const bubble = document.createElement('div');
  bubble.className = role === 'assistant' ? 'bubble assistant' : 'bubble'; bubble.dataset.role = role;
  const label = document.createElement('small'); label.textContent = role === 'assistant' ? '音声（AI）' : 'あなた';
  bubble.append(label, document.createTextNode(delta)); $('testTranscript').append(bubble);
  $('testTranscript').scrollTop = $('testTranscript').scrollHeight;
}
function addDebug({ direction, at, event }) {
  const entry = document.createElement('div');
  entry.textContent = `${at} ${direction === 'SEND' ? '→ 送信' : '← 受信'} ${event.type}\n${JSON.stringify(event, null, 2)}`;
  $('debugLog').append(entry);
  $('debugCount').textContent = $('debugLog').childElementCount;
}
function command(data) {
  if (socket?.readyState !== WebSocket.OPEN) throw new Error('サーバーとの接続が切れています。ページを再読み込みしてください。');
  socket.send(JSON.stringify(data));
}
function openSocket() {
  if (socket && socket.readyState <= WebSocket.OPEN) return new Promise(resolve => socket.readyState === WebSocket.OPEN ? resolve() : socket.addEventListener('open', resolve, { once: true }));
  socket = new WebSocket(`ws://${location.host}/voice-test`);
  socket.onmessage = async ({ data }) => {
    const m = JSON.parse(data);
    if (m.kind === 'audio') audio.play(m.audio);
    if (m.kind === 'transcript') addTranscript(m.role, m.delta);
    if (m.kind === 'debug') addDebug(m);
    if (m.kind === 'error') { testStatus(m.message); if (status === 'connecting') setStatus('disconnected'); }
    if (m.kind === 'status') {
      setStatus(m.status);
      if (m.status === 'connected') {
        try { await setMic(true); testStatus('会話中 · マイクで話しかけてください'); }
        catch (error) { testStatus(`マイクを開始できませんでした: ${error.message}`); }
      }
      if (m.status === 'disconnected') { await audio.stop(); micOn = false; $('testMic').textContent = 'マイク ON'; if (m.reason) testStatus(`未接続 · ${m.reason}`); }
    }
  };
  socket.onclose = () => { audio.stop(); micOn = false; setStatus('disconnected'); testStatus('サーバーとの接続が切れました。ページを再読み込みしてください。'); };
  return new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('サーバーに接続できませんでした')); });
}
setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: 'ping' })); }, 10000);

$('openTest').onclick = () => {
  if (!voice) return;
  $('voiceTest').hidden = false;
  if (!$('testInstructions').value) $('testInstructions').value = `日本語で、短く自然に会話してください。\n\nVoice description:\n${voice.prompt}`;
  $('testInstructions').focus();
};
$('startTest').onclick = async () => {
  if (!voice || status !== 'disconnected') return;
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) { testStatus('上のAPIキー欄に、音声を作成したキーを入力してください。'); return; }
  setStatus('connecting'); $('testTranscript').replaceChildren(); $('debugLog').replaceChildren(); $('debugCount').textContent = 0;
  try {
    await audio.unlock(); await openSocket();
    command({ kind: 'start', apiKey, voice: voice.id, instructions: $('testInstructions').value });
  } catch (error) { setStatus('disconnected'); testStatus(error.message); }
};
$('stopTest').onclick = () => { try { command({ kind: 'stop' }); } catch (error) { testStatus(error.message); } };
$('testMic').onclick = async () => {
  $('testMic').disabled = true;
  try { await setMic(!micOn); } catch (error) { testStatus(`マイクを切り替えられませんでした: ${error.message}`); }
  finally { $('testMic').disabled = status !== 'connected'; }
};
