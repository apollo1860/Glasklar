// Glasklar – Sound per WebAudio, komplett synthetisch (keine Assets).
// Stumm bis zur ersten Interaktion: Der AudioContext entsteht erst beim ersten Tap.
import { store } from './storage.js';

let ctx = null;
let master = null;
let muted = store.get('muted', false);

function ensure() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.55;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function initAudio() {
  const unlock = () => ensure();
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
}

export const isMuted = () => muted;

export function setMuted(m) {
  muted = m;
  store.set('muted', m);
  if (master) master.gain.setTargetAtTime(m ? 0 : 0.55, ctx.currentTime, 0.02);
}

function ready() {
  return ctx && ctx.state === 'running' && !muted ? ctx : null;
}

function tone({ type = 'sine', freq, freqEnd, start = 0, dur = 0.2, gain = 0.3, attack = 0.005 }) {
  const c = ready();
  if (!c) return;
  const t = c.currentTime + start;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.05);
}

export const sfx = {
  /** Blubbern beim Füllen, höher je voller. */
  blub(level = 1) {
    const base = 160 + level * 28;
    tone({ freq: base, freqEnd: base * 2.4, dur: 0.14, gain: 0.32 });
    tone({ freq: base * 1.3, freqEnd: base * 3, start: 0.07, dur: 0.1, gain: 0.18 });
    tone({ freq: base * 0.9, freqEnd: base * 2, start: 0.13, dur: 0.08, gain: 0.1 });
  },
  /** Gläser-Klirren bei seltener Antwort. */
  clink() {
    [2093, 3136, 4186, 5274].forEach((f, i) => {
      tone({ freq: f, dur: 1.1 - i * 0.15, gain: 0.12 / (i + 1) + 0.03 });
      tone({ freq: f * 1.01, start: 0.13, dur: 0.8 - i * 0.12, gain: 0.08 / (i + 1) + 0.02 });
    });
  },
  /** Fanfare bei der Endabrechnung. */
  fanfare() {
    const notes = [[523, 0, 0.16], [659, 0.15, 0.16], [784, 0.3, 0.16], [1047, 0.45, 0.6]];
    for (const [f, s, d] of notes) {
      tone({ type: 'triangle', freq: f, start: s, dur: d + 0.1, gain: 0.25 });
      tone({ type: 'square', freq: f, start: s, dur: d, gain: 0.04 });
    }
    tone({ type: 'triangle', freq: 784, start: 0.45, dur: 0.7, gain: 0.12 });
    tone({ type: 'triangle', freq: 659, start: 0.45, dur: 0.7, gain: 0.1 });
  },
  /** Leises Ticken in den letzten Sekunden. */
  tick() { tone({ type: 'square', freq: 1400, dur: 0.03, gain: 0.05 }); },
  /** Zeit abgelaufen. */
  buzz() {
    tone({ type: 'sawtooth', freq: 180, freqEnd: 110, dur: 0.35, gain: 0.12 });
  },
  /** Kurzer Tap/Pop für UI. */
  pop() { tone({ freq: 700, freqEnd: 1100, dur: 0.06, gain: 0.12 }); },
  /** Auswahl bestätigt. */
  select() {
    tone({ freq: 880, dur: 0.08, gain: 0.12 });
    tone({ freq: 1320, start: 0.06, dur: 0.1, gain: 0.1 });
  },
  /** Spritzer, wenn ein Chip ins Glas fällt. */
  splash() {
    const c = ready();
    if (!c) return;
    const len = 0.25;
    const buf = c.createBuffer(1, c.sampleRate * len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1800;
    const g = c.createGain();
    g.gain.value = 0.3;
    src.connect(f).connect(g).connect(master);
    src.start();
  },
};
