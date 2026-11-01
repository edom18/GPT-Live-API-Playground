export function voiceSetting(value) {
  const id = value.trim();
  return id.startsWith('voice_') ? { id } : id;
}

export function voiceValue(value) {
  return typeof value === 'string' ? value : value?.id || '';
}
