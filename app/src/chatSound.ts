let context: AudioContext | null = null;

export function unlockChatSound() {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume().catch(() => {});
  } catch { /* Audio output is unavailable in this browser. */ }
}

export function playChatSound() {
  unlockChatSound();
  if (!context || context.state !== 'running') return;
  try {
    const now = context.currentTime;
    const tone = context.createOscillator();
    const volume = context.createGain();
    tone.type = 'sine';
    tone.frequency.setValueAtTime(660, now);
    tone.frequency.setValueAtTime(880, now + 0.1);
    volume.gain.setValueAtTime(0.001, now);
    volume.gain.exponentialRampToValueAtTime(0.07, now + 0.015);
    volume.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    tone.connect(volume).connect(context.destination);
    tone.start(now);
    tone.stop(now + 0.26);
  } catch { /* Keep chat usable if audio output fails. */ }
}
