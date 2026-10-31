import type { AlarmLevel } from '../types';

let audioContext: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') return null;
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

/** 在用户点击等手势中调用，避免浏览器拦截后续提示音。 */
export function primeAlertAudio(): void {
  const context = getContext();
  if (!context) return;
  if (context.state === 'suspended') {
    void context.resume().catch(() => undefined);
  }
}

export function playAlertSound(level: AlarmLevel): void {
  const context = getContext();
  if (!context) return;
  if (context.state === 'suspended') {
    void context.resume().catch(() => undefined);
  }

  const start = context.currentTime + 0.03;
  const tones =
    level === 'fire'
      ? [880, 1040, 880]
      : level === 'offline'
        ? [320, 260]
        : [660, 520];
  tones.forEach((frequency, index) => {
    const offset = start + index * 0.16;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(frequency, offset);
    gain.gain.setValueAtTime(0.0001, offset);
    gain.gain.exponentialRampToValueAtTime(0.075, offset + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, offset + 0.13);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(offset);
    oscillator.stop(offset + 0.14);
  });
}
