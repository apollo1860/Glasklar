// Glasklar – gemeinsame Bausteine für Single- und Multiplayer.
import { CONFIG } from './config.js';
import { store } from './storage.js';
import { sfx } from './audio.js';
import { splash, vibrate, wait, reducedMotion } from './fx.js';
import { $ } from './ui.js';

/* ------------------------------------------------------------------ */
/* Einstellungen                                                       */
/* ------------------------------------------------------------------ */

export function clampTimer(v) {
  const { min, max } = CONFIG.timer;
  return Math.max(min, Math.min(max, Number(v) || CONFIG.timer.default));
}

export const settings = {
  get() {
    const s = store.get('settings', {});
    return {
      timer: clampTimer(s.timer ?? CONFIG.timer.default),
      vibrate: s.vibrate !== false,
      categories: Array.isArray(s.categories) ? s.categories : null,
    };
  },
  set(patch) { store.set('settings', { ...this.get(), ...patch }); },
};

export function bindTimerSlider(slider, out, { value = settings.get().timer, onChange = (v) => settings.set({ timer: v }) } = {}) {
  const { min, max, step } = CONFIG.timer;
  Object.assign(slider, { min, max, step });
  slider.value = value;
  out.textContent = `${slider.value} s`;
  slider.oninput = () => { out.textContent = `${slider.value} s`; };
  slider.onchange = () => onChange(clampTimer(slider.value));
}

/* ------------------------------------------------------------------ */
/* Gespielte Fragen pro Gerät                                          */
/* ------------------------------------------------------------------ */

export const played = {
  get: () => new Set(store.get('played', [])),
  add(id) { store.update('played', [], (l) => (l.includes(id) ? l : [...l, id])); },
  resetCategories(catalog, cats) {
    const drop = new Set(catalog.filter((q) => cats.includes(q.kategorie)).map((q) => q.id));
    store.update('played', [], (l) => l.filter((id) => !drop.has(id)));
  },
  clear: () => store.remove('played'),
};

/* ------------------------------------------------------------------ */
/* Wake Lock                                                           */
/* ------------------------------------------------------------------ */

let wakeLock = null;
let wantWake = false;
export async function requestWake() {
  wantWake = true;
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* nicht erlaubt */ }
}
export function releaseWake() {
  wantWake = false;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => { if (wantWake && document.visibilityState === 'visible') requestWake(); });

/* ------------------------------------------------------------------ */
/* Timer – Deadline-basiert, Zeitquelle austauschbar (Serverzeit)      */
/* ------------------------------------------------------------------ */

export class Countdown {
  constructor({ seconds, bar, label, onEnd, now = () => Date.now() }) {
    Object.assign(this, { seconds, bar, label, onEnd, now });
    this.raf = 0;
    this.lastWhole = null;
  }
  start(startAt = this.now()) {
    this.stop();
    this.deadline = startAt + this.seconds * 1000;
    const loop = () => {
      const left = Math.max(0, this.deadline - this.now());
      const frac = Math.min(1, left / (this.seconds * 1000));
      this.bar.style.transform = `scaleX(${frac})`;
      this.bar.parentElement.parentElement.dataset.state = frac < 0.2 ? 'danger' : frac < 0.5 ? 'warn' : 'ok';
      const whole = Math.ceil(left / 1000);
      if (whole !== this.lastWhole) {
        this.lastWhole = whole;
        this.label.textContent = String(whole);
        if (whole <= 5 && whole > 0) sfx.tick();
      }
      if (left <= 0) { this.raf = 0; this.onEnd(); return; }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  /** Anzeige einfrieren (Pause), ohne onEnd. */
  freeze(leftMs) {
    this.stop();
    const frac = Math.min(1, Math.max(0, leftMs / (this.seconds * 1000)));
    this.bar.style.transform = `scaleX(${frac})`;
    this.label.textContent = String(Math.ceil(leftMs / 1000));
  }
  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastWhole = null;
  }
}

/* ------------------------------------------------------------------ */
/* Reveal-Texte & Glas-Animation                                       */
/* ------------------------------------------------------------------ */

const MESSAGES = {
  rare: ['Selten!'],
  low: ['Nicht schlecht', 'Fast originell', 'Knapp daneben'],
  mid: ['Naheliegend', 'Das sagen einige', 'Solide, aber bekannt'],
  top: ['Das sagt jeder', 'Die Standardantwort', 'Wie erwartet'],
  nothing: ['Passen kostet', 'Nichts gepasst'],
  timeout: ['Zeit abgelaufen', 'Zu langsam'],
  // Ranglisten-Fragen: Füllung nach Rang
  hit: ['Volltreffer!'],
  close: ['Knapp dran', 'Fast!'],
  off: ['Daneben', 'Nicht ganz'],
  far: ['Weit daneben', 'Leider nein'],
};
export const pickMsg = (k) => MESSAGES[k][Math.floor(Math.random() * MESSAGES[k].length)];

/** Art des Ergebnisses nach Grundfüllung (ohne Gleiche-Antwort-Aufschlag). */
export function revealKind(sub, base, typ = 'normal') {
  if (!sub || sub.type === 'timeout') return 'timeout';
  if (sub.type === 'nothing') return 'nothing';
  if (typ === 'rangliste') return base === 0 ? 'hit' : base === 1 ? 'close' : base === 2 ? 'off' : 'far';
  return base === 0 ? 'rare' : base === 1 ? 'low' : base === 2 ? 'mid' : 'top';
}

/** Lösung (bei Ranglisten) unter den Antworten anzeigen. */
export function showSolution(q) {
  const el = $('#reveal-solution');
  el.textContent = q.loesung ? `Lösung: ${q.loesung}` : '';
  el.hidden = !q.loesung;
}

export function showRevealMsg(kind) {
  const msg = $('#reveal-msg');
  msg.textContent = pickMsg(kind);
  msg.className = 'reveal-msg';
  void msg.offsetWidth;
  msg.className = `reveal-msg show kind-${kind}`;
}

/** Füllt ein Glas schrittweise von a nach b – mit Shake, Blubbern und Vibration. */
export async function fillGlass(glass, from, to, { stepMs = 420, sound = true } = {}) {
  for (let lvl = from + 1; lvl <= to; lvl++) {
    glass.setLevel(lvl);
    glass.shake(lvl >= 7);
    if (sound) sfx.blub(lvl);
    vibrate(lvl >= 7 ? 45 : 22);
    if (lvl % 2 === 0 && !reducedMotion()) {
      const p = glass.surfacePoint();
      splash(p.x, p.y, 4);
    }
    await wait(reducedMotion() ? 120 : stepMs);
  }
}

/** Fragenkarte, Fortschritt und Spielbildschirm für eine neue Frage vorbereiten. */
export function renderQuestionCard(q, { cat, round, qNum, canSkip }) {
  $('#q-cat').textContent = cat?.name ?? q.kategorie;
  $('#q-text').textContent = q.text;
  $('#q-progress').innerHTML = Array.from({ length: CONFIG.questionsPerRound }, (_, i) =>
    `<span class="dot ${i < qNum - 1 ? 'done' : i === qNum - 1 ? 'now' : ''}"></span>`).join('');
  $('#round-label').textContent = `Runde ${round}`;
  $('#reveal-panel').hidden = true;
  $('#reveal-msg').className = 'reveal-msg';
  $('#reveal-msg').textContent = '';
  $('#answer-area').hidden = false;
  $('#btn-skip').hidden = !canSkip;
  const card = $('#question-card');
  card.classList.remove('pop');
  void card.offsetWidth;
  card.classList.add('pop');
}
