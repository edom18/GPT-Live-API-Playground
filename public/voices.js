export function setupVoices({ dirty, toast }) {
  const $ = id => document.getElementById(id);
  let voices = [], creating = false;
  const message = text => { $('voiceMessage').textContent = text; };
  function selected() { return voices.find(v => v.id === $('savedVoices').value); }
  function showSelected() {
    const voice = selected();
    $('voiceDetails').textContent = voice ? JSON.stringify(voice, null, 2) : 'まだ保存された音声がありません。';
    $('useVoice').disabled = !voice; $('addVoicePrompt').disabled = !voice?.prompt;
  }
  async function refresh(preferred) {
    const res = await fetch('/api/voices'); if (!res.ok) throw new Error('保存済み音声を読み込めませんでした');
    const saved = await res.json();
    // Keep a newly created ID visible even if disk persistence failed.
    voices = [...saved, ...voices.filter(v => !saved.some(s => s.id === v.id))];
    const current = preferred || $('savedVoices').value;
    $('savedVoices').replaceChildren(); $('voiceOptions').replaceChildren();
    for (const voice of voices) {
      $('savedVoices').add(new Option(`${voice.name} · ${voice.id}`, voice.id));
      $('voiceOptions').append(new Option(voice.name, voice.id));
    }
    if (voices.some(v => v.id === current)) $('savedVoices').value = current;
    showSelected();
  }
  $('openVoices').onclick = () => {
    $('voiceDialog').showModal();
    if (!creating) message('声を作成するか、保存済みの声を選んでください。');
    refresh().catch(e => message(e.message));
  };
  $('closeVoices').onclick = () => $('voiceDialog').close();
  $('refreshVoices').onclick = () => refresh().catch(e => message(e.message));
  $('savedVoices').onchange = showSelected;
  $('useVoice').onclick = () => {
    const voice = selected(); if (!voice) return;
    $('voice').value = voice.id; dirty();
    message(`「${voice.name}」を接続設定に選択しました。最新設定で接続・再接続すると反映されます。`);
    toast('音声を選択しました。次回接続から反映します。');
  };
  $('addVoicePrompt').onclick = () => {
    const voice = selected(); if (!voice?.prompt) return;
    if (!$('instructions').value.includes(voice.prompt)) {
      $('instructions').value = `${$('instructions').value.trimEnd()}\n\nVoice description:\n${voice.prompt}`;
      dirty();
    }
    message('元の声の説明を初期instructionsに追記しました。接続設定で確認・編集できます。');
  };
  $('voiceForm').onsubmit = async event => {
    event.preventDefault(); if (creating || !$('voiceForm').reportValidity()) return;
    const request = { name: $('voiceName').value.trim(), prompt: $('voicePrompt').value.trim() };
    if ($('voiceScript').value.trim()) request.script_hint = $('voiceScript').value.trim();
    creating = true; $('createVoice').disabled = true; $('createVoice').textContent = '作成中…';
    message('OpenAIで音声を作成しています。完了までお待ちください。');
    try {
      const res = await fetch('/api/voices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      const result = await res.json(); if (!res.ok) throw new Error(result.error || '作成に失敗しました');
      voices = [result.voice, ...voices.filter(v => v.id !== result.voice.id)];
      try { await refresh(result.voice.id); }
      catch { $('savedVoices').replaceChildren(new Option(result.voice.name, result.voice.id)); showSelected(); }
      message(result.warning || `「${result.voice.name}」を作成・保存しました。「声に設定」で利用できます。`);
    } catch (error) { message(`${error.message} 自動再試行は行っていません。`); }
    finally { creating = false; $('createVoice').disabled = false; $('createVoice').textContent = '作成して保存'; }
  };
  refresh().catch(() => {});
}
