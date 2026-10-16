// Glasklar – App-Start, Zustandsmaschine und Singleplayer.
// Zustände pro Frage: lobby → frage → reveal → (frage | endabrechnung) → lobby
import { CONFIG } from './config.js';
import { computeQuestionFills, roundSips, drawQuestion, answerFrequencies } from './logic.js';
import { loadIndex, getCatalog, getQuestion, getSearchIndex } from './data.js';
import { store } from './storage.js';
import { initAudio, sfx, isMuted, setMuted } from './audio.js';
import { createGlass } from './glass.js';
import { confetti, sparkle, splash, vibrate, wait, reducedMotion } from './fx.js';
import {
  $, $$, showScreen, initViewport, modal, toast, missingLog, AnswerInput,
  renderCategoryChips, renderAnswerChips, sipsLabel,
} from './ui.js';

/* ------------------------------------------------------------------ */
/* Einstellungen & Statistik                                           */
/* ------------------------------------------------------------------ */

const settings = {
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

function clampTimer(v) {
  const { min, max } = CONFIG.timer;
  return Math.max(min, Math.min(max, Number(v) || CONFIG.timer.default));
}

const stats = {
  get: () => store.get('stats', { rounds: 0, sips: 0, best: null }),
  addRound(sips) {
    const prev = stats.get();
    const isBest = prev.best === null || sips < prev.best;
    store.set('stats', { rounds: prev.rounds + 1, sips: prev.sips + sips, best: isBest ? sips : prev.best });
    return { isBest, hadBest: prev.best !== null, prevBest: prev.best };
  },
  reset: () => store.remove('stats'),
};

const played = {
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
async function requestWake() {
  wantWake = true;
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* nicht erlaubt */ }
}
function releaseWake() {
  wantWake = false;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => { if (wantWake && document.visibilityState === 'visible') requestWake(); });

/* ------------------------------------------------------------------ */
/* Timer (Deadline-basiert; Multiplayer nutzt später Serverzeit)       */
/* ------------------------------------------------------------------ */

class Countdown {
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
      const frac = left / (this.seconds * 1000);
      this.bar.style.transform = `scaleX(${frac})`;
      this.bar.parentElement.dataset.state = frac < 0.2 ? 'danger' : frac < 0.5 ? 'warn' : 'ok';
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
  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastWhole = null;
  }
}

/* ------------------------------------------------------------------ */
/* Spielzustand                                                        */
/* ------------------------------------------------------------------ */

const S = {
  phase: 'lobby',
  mode: 'single',
  enabled: [],
  timerSec: CONFIG.timer.default,
  round: 0,
  qNum: 0, // gewertete Frage in der Runde (1..3)
  fills: [],
  roundQIds: new Set(),
  lastCat: null,
  question: null,
  history: [], // [{ round, sips }]
  busy: false,
};

let index = null;
let catalog = [];
let gameGlass = null;
let resultGlass = null;
let answerInput = null;
let countdown = null;

const catName = (id) => index?.categories.find((c) => c.id === id);

function setPhase(p) {
  S.phase = p;
  document.body.dataset.phase = p;
}

/* ------------------------------------------------------------------ */
/* Lobby / Setup                                                       */
/* ------------------------------------------------------------------ */

function openSetup() {
  const s = settings.get();
  const all = index.categories.map((c) => c.id);
  S.enabled = (s.categories || all).filter((id) => all.includes(id));
  if (!S.enabled.length) S.enabled = all;
  renderCategoryChips($('#setup-categories'), index.categories, S.enabled, (list) => {
    S.enabled = list;
    settings.set({ categories: list });
    $('#btn-start-round').disabled = !list.length;
    $('#setup-hint').hidden = !!list.length;
  });
  $('#btn-start-round').disabled = !S.enabled.length;
  bindTimerSlider($('#setup-timer'), $('#setup-timer-val'));
  showScreen('setup');
}

function bindTimerSlider(slider, out) {
  const { min, max, step } = CONFIG.timer;
  Object.assign(slider, { min, max, step });
  slider.value = settings.get().timer;
  out.textContent = `${slider.value} s`;
  slider.oninput = () => {
    out.textContent = `${slider.value} s`;
    settings.set({ timer: clampTimer(slider.value) });
  };
}

async function startSingle() {
  S.mode = 'single';
  S.timerSec = settings.get().timer;
  S.round = 0;
  S.history = [];
  S.lastCat = null;
  requestWake();
  await newRound();
}

async function newRound() {
  S.round++;
  S.qNum = 0;
  S.fills = [];
  S.roundQIds = new Set();
  gameGlass.overflow(false);
  gameGlass.setLevel(0, { animate: false });
  showScreen('game');
  await nextQuestion();
}

async function nextQuestion() {
  S.qNum++;
  await showNewQuestion();
}

/** Neue Frage ziehen und anzeigen (auch nach Skip; qNum bleibt dann gleich). */
async function showNewQuestion() {
  if (S.busy) return;
  S.busy = true;
  try {
    const pl = played.get();
    const pick = drawQuestion({ catalog, enabled: S.enabled, played: pl, exclude: S.roundQIds, lastCategory: S.lastCat });
    if (!pick) throw new Error('Keine Kategorie ausgewählt');
    if (pick.reset) {
      played.resetCategories(catalog, S.enabled);
      toast('Alle Fragen gespielt – Stapel neu gemischt 🔀');
    }
    played.add(pick.id); // gilt ab Anzeige als gespielt (auch bei Skip)
    S.roundQIds.add(pick.id);
    S.lastCat = pick.kategorie;
    const question = await getQuestion(pick.id, pick.kategorie);
    S.question = question;
    renderQuestion(question);
    setPhase('frage');
    answerInput.setQuestion(question, getSearchIndex(question));
    countdown.seconds = S.timerSec;
    countdown.start();
  } catch (e) {
    console.error(e);
    toast(`Fehler beim Laden: ${e.message}`, 4000);
  } finally {
    S.busy = false;
  }
}

function renderQuestion(q) {
  const cat = catName(q.kategorie);
  $('#q-cat').textContent = `${cat?.icon ?? ''} ${cat?.name ?? q.kategorie}`;
  $('#q-text').textContent = q.text;
  $('#q-progress').innerHTML = Array.from({ length: CONFIG.questionsPerRound }, (_, i) =>
    `<span class="dot ${i < S.qNum - 1 ? 'done' : i === S.qNum - 1 ? 'now' : ''}"></span>`).join('');
  $('#round-label').textContent = `Runde ${S.round}`;
  $('#reveal-panel').hidden = true;
  $('#reveal-msg').className = 'reveal-msg';
  $('#reveal-msg').textContent = '';
  $('#answer-area').hidden = false;
  $('#btn-skip').hidden = false;
  const card = $('#question-card');
  card.classList.remove('pop');
  void card.offsetWidth;
  card.classList.add('pop');
}

function skipQuestion() {
  if (S.phase !== 'frage' || S.busy) return;
  countdown.stop();
  sfx.pop();
  // Vorhandene Eingabe wird verworfen, Frage zählt nicht als eine der 3
  showNewQuestion();
}

function onTimeout() {
  if (S.phase !== 'frage') return;
  sfx.buzz();
  answerInput.flushNoHit();
  const sel = answerInput.currentSelection();
  answerInput.lock();
  submitAnswer(sel || { type: 'timeout' });
}

function submitAnswer(sub) {
  if (S.phase !== 'frage') return;
  countdown.stop();
  setPhase('reveal');
  reveal(sub);
}

/* ------------------------------------------------------------------ */
/* Reveal                                                              */
/* ------------------------------------------------------------------ */

const MESSAGES = {
  rare: ['Selten! ✨', 'Glasklar! ✨', 'Selten! Stark! ✨'],
  low: ['Gar nicht schlecht!', 'Fast originell!', 'Knapp daneben!'],
  mid: ['Ziemlich naheliegend …', 'Das sagen einige.', 'Solide, aber bekannt.'],
  top: ['Das sagt doch jeder! 🍺', 'Mainstream-Alarm! 🍺', 'Wie erwartet! 🍺'],
  nothing: ['Passen kostet!', 'Nichts gepasst …'],
  timeout: ['Zeit abgelaufen! ⏰', 'Zu langsam! ⏰'],
};
const pickMsg = (k) => MESSAGES[k][Math.floor(Math.random() * MESSAGES[k].length)];

async function reveal(sub) {
  const q = S.question;
  $('#btn-skip').hidden = true;
  $('#answer-area').hidden = true;
  const { me } = computeQuestionFills({ me: sub }, q, { multiplayer: false });
  const fill = me.fill;
  const before = Math.min(S.fills.reduce((a, b) => a + b, 0), CONFIG.maxSipsPerRound);
  S.fills.push(fill);
  const total = S.fills.reduce((a, b) => a + b, 0);

  const answer = sub.type === 'answer' ? q.answers.find((a) => a.id === sub.answerId) : null;
  const kind = sub.type === 'timeout' ? 'timeout' : sub.type === 'nothing' ? 'nothing'
    : fill === 0 ? 'rare' : fill === 1 ? 'low' : fill === 2 ? 'mid' : 'top';

  // Antwort-Chips (Häufigkeit), keine Schluck-Anzahl
  const groups = answerFrequencies({ me: sub }, q);
  renderAnswerChips($('#reveal-chips'), groups, { highlightKey: groups[0]?.key });
  $('#reveal-question').textContent = q.text;
  $('#reveal-panel').hidden = false;
  $('#btn-next').hidden = true;

  await wait(250);
  const msg = $('#reveal-msg');
  msg.textContent = pickMsg(kind);
  msg.className = `reveal-msg show kind-${kind}`;

  if (answer && answer.tier === 1) gameGlass.flashRed();
  await fillGlass(gameGlass, before, Math.min(total, CONFIG.maxSipsPerRound));
  if (fill === 0) {
    gameGlass.glow('rare');
    const p = gameGlass.surfacePoint();
    sparkle(p.x, p.y - 30, p.width * 0.8);
    sfx.clink();
    vibrate([20, 40, 20]);
  }
  if (total > CONFIG.maxSipsPerRound) gameGlass.overflow(true);

  const last = S.qNum >= CONFIG.questionsPerRound;
  const next = $('#btn-next');
  next.textContent = last ? 'Zur Abrechnung 🍻' : 'Nächste Frage →';
  next.hidden = false;
  next.focus({ preventScroll: true });
}

/** Füllt ein Glas schrittweise von a nach b – mit Shake, Blubbern und Vibration. */
async function fillGlass(glass, from, to, { stepMs = 420, sound = true } = {}) {
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

function onNext() {
  if (S.phase !== 'reveal') return;
  if (S.qNum >= CONFIG.questionsPerRound) showResult();
  else nextQuestion();
}

/* ------------------------------------------------------------------ */
/* Endabrechnung                                                       */
/* ------------------------------------------------------------------ */

async function showResult() {
  setPhase('endabrechnung');
  const sips = roundSips(S.fills);
  S.history.push({ round: S.round, sips });
  const best = stats.addRound(sips);
  const st = stats.get();

  showScreen('result');
  $('#result-title').textContent = `Runde ${S.round} – Abrechnung`;
  const big = $('#result-big');
  big.innerHTML = 'Du trinkst <span class="count">0</span> <span class="unit">Schlücke</span>';
  $('#result-note').textContent = '';
  $('#result-actions').classList.remove('show');
  const sessionSips = S.history.reduce((a, h) => a + h.sips, 0);
  $('#result-stats').innerHTML = `
    <div class="stat"><b>${sessionSips}</b><span>Schlücke diese Sitzung</span></div>
    <div class="stat"><b>${st.best ?? '–'}</b><span>Bestwert (wenigste)</span></div>
    <div class="stat"><b>${st.rounds}</b><span>Runden gesamt</span></div>
    <div class="stat"><b>${st.rounds ? (st.sips / st.rounds).toFixed(1).replace('.', ',') : '–'}</b><span>Ø pro Runde</span></div>`;

  resultGlass.overflow(false);
  resultGlass.setLevel(0, { animate: false });
  await wait(500);
  sfx.fanfare();
  const count = big.querySelector('.count');
  const unit = big.querySelector('.unit');
  for (let lvl = 1; lvl <= sips; lvl++) {
    resultGlass.setLevel(lvl);
    resultGlass.shake(lvl >= 7);
    count.textContent = String(lvl);
    unit.textContent = lvl === 1 ? 'Schluck' : 'Schlücke';
    sfx.blub(lvl);
    vibrate(lvl >= 7 ? 40 : 18);
    await wait(reducedMotion() ? 80 : 260);
  }
  big.classList.remove('bump');
  void big.offsetWidth;
  big.classList.add('bump');

  const note = $('#result-note');
  if (sips >= CONFIG.maxSipsPerRound) {
    resultGlass.overflow(true);
    note.textContent = 'Randvoll! Das Glas läuft über 🍺';
  } else if (sips === 0) {
    note.textContent = 'Glasklar! Kein einziger Schluck.';
  }
  if (best.isBest && best.hadBest) {
    note.textContent = `Neuer Bestwert! Vorher: ${sipsLabel(best.prevBest)} 🏆`;
    confetti();
    sfx.clink();
  } else if (sips === 0) {
    confetti();
    sfx.clink();
  }
  $('#result-actions').classList.add('show');
}

function showSummary() {
  setPhase('lobby');
  releaseWake();
  countdown.stop();
  const total = S.history.reduce((a, h) => a + h.sips, 0);
  const best = S.history.length ? Math.min(...S.history.map((h) => h.sips)) : null;
  $('#summary-body').innerHTML = S.history.length ? `
    <div class="summary-hero">
      <div class="big">${sipsLabel(total)}</div>
      <div class="sub">in ${S.history.length} ${S.history.length === 1 ? 'Runde' : 'Runden'}</div>
    </div>
    <ol class="summary-rounds">
      ${S.history.map((h) => `<li class="${h.sips === best ? 'best' : ''}"><span>Runde ${h.round}</span><b>${sipsLabel(h.sips)}</b></li>`).join('')}
    </ol>
    <p class="muted">Beste Runde: ${sipsLabel(best)} · Ø ${(total / S.history.length).toFixed(1).replace('.', ',')}</p>`
    : '<p class="muted">Keine Runde beendet.</p>';
  showScreen('summary');
}

async function exitGame() {
  if (S.phase === 'lobby') { showScreen('start'); return; }
  const ok = await modal({
    title: 'Spiel beenden?',
    html: '<p>Die laufende Runde wird nicht gewertet.</p>',
    buttons: [{ label: 'Weiterspielen', value: false, kind: 'secondary' }, { label: 'Beenden', value: true, kind: 'danger' }],
  });
  if (!ok) return;
  countdown.stop();
  showSummary();
}

/* ------------------------------------------------------------------ */
/* Einstellungen-Screen                                                */
/* ------------------------------------------------------------------ */

function openSettings() {
  const s = settings.get();
  bindTimerSlider($('#settings-timer'), $('#settings-timer-val'));
  $('#settings-sound').checked = !isMuted();
  $('#settings-vibrate').checked = s.vibrate;
  updateMissingCount();
  showScreen('settings');
}

function updateMissingCount() {
  const n = missingLog.all().length;
  $('#missing-count').textContent = `${n} ${n === 1 ? 'Eintrag' : 'Einträge'}`;
}

function updateMuteButtons() {
  for (const b of $$('[data-act="mute"]')) {
    b.textContent = isMuted() ? '🔇' : '🔊';
    b.setAttribute('aria-label', isMuted() ? 'Ton an' : 'Ton aus');
  }
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

async function ageGate() {
  if (store.get('ageOk', false)) return;
  await modal({
    title: 'Kurz vorab 🍻',
    html: `<p><b>Glasklar ist ein Trinkspiel für Erwachsene ab 18.</b></p>
      <p>Trink verantwortungsvoll. Wasser, Saft oder alkoholfreies Bier funktionieren genauso gut – ein Schluck ist ein Schluck.</p>
      <p>Niemand muss trinken. Und nie trinken und fahren.</p>`,
    buttons: [{ label: 'Ich bin 18+ – los!', value: true, kind: 'primary' }],
    dismissable: false,
  });
  store.set('ageOk', true);
}

function howTo() {
  modal({
    title: 'So geht\'s',
    html: `<ol class="howto">
      <li>Alle bekommen dieselbe Frage: <i>„Nenne ein …"</i></li>
      <li>Tippe deine Antwort als <b>ganzes Wort</b>. Erst dann erscheint sie zum Antippen – nur Einträge aus der Liste zählen, kleine Tippfehler werden erkannt.</li>
      <li><b>Je offensichtlicher</b> die Antwort, desto <b>voller</b> das Glas. Seltene Antworten halten es leer.</li>
      <li>„Nichts passt" oder keine Antwort füllt das Glas auch.</li>
      <li>Nach 3 Fragen trinkst du so viele Schlücke, wie dein Glas voll ist (max. ${CONFIG.maxSipsPerRound}).</li>
    </ol>`,
    buttons: [{ label: 'Alles klar', value: true, kind: 'primary' }],
  });
}

function renderStartStats() {
  const st = stats.get();
  $('#start-stats').innerHTML = st.rounds
    ? `<span>🏆 Bestwert: <b>${sipsLabel(st.best)}</b></span><span>🍺 ${st.rounds} ${st.rounds === 1 ? 'Runde' : 'Runden'}</span>`
    : '';
}

function bind() {
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    switch (act) {
      case 'single': openSetup(); break;
      case 'multi': toast('Multiplayer kommt in Phase 2 🛠️'); break;
      case 'settings': openSettings(); break;
      case 'howto': howTo(); break;
      case 'home': renderStartStats(); setPhase('lobby'); showScreen('start'); break;
      case 'start-round': if (S.enabled.length) startSingle(); break;
      case 'skip': skipQuestion(); break;
      case 'next': onNext(); break;
      case 'new-round': setPhase('lobby'); newRound(); break;
      case 'end-game': showSummary(); break;
      case 'exit': exitGame(); break;
      case 'mute': setMuted(!isMuted()); updateMuteButtons(); break;
      case 'export-missing':
        if (!missingLog.all().length) toast('Noch keine Einträge');
        else missingLog.export();
        break;
      case 'clear-missing':
        if (await modal({ title: 'Log leeren?', html: '<p>Alle gespeicherten fehlenden Antworten werden gelöscht.</p>', buttons: [{ label: 'Abbrechen', value: false }, { label: 'Leeren', value: true, kind: 'danger' }] })) {
          missingLog.clear();
          updateMissingCount();
        }
        break;
      case 'reset-stats':
        if (await modal({ title: 'Statistik zurücksetzen?', html: '<p>Bestwert und Rundenzähler werden gelöscht.</p>', buttons: [{ label: 'Abbrechen', value: false }, { label: 'Zurücksetzen', value: true, kind: 'danger' }] })) {
          stats.reset();
          toast('Statistik zurückgesetzt');
        }
        break;
      case 'reset-played':
        played.clear();
        toast('Alle Fragen sind wieder im Stapel');
        break;
      default: break;
    }
  });
  $('#settings-sound').addEventListener('change', (e) => { setMuted(!e.target.checked); updateMuteButtons(); });
  $('#settings-vibrate').addEventListener('change', (e) => settings.set({ vibrate: e.target.checked }));
}

async function init() {
  initViewport();
  initAudio();
  gameGlass = createGlass($('#glass-stage'));
  resultGlass = createGlass($('#result-glass'));
  createGlass($('#logo-glass'), { compact: true }).setLevel(6, { animate: false });
  answerInput = new AnswerInput({
    root: $('#answer-area'),
    onSubmit: (sub) => submitAnswer(sub),
  });
  countdown = new Countdown({ seconds: S.timerSec, bar: $('#timer-bar'), label: $('#timer-num'), onEnd: onTimeout });
  bind();
  updateMuteButtons();
  setPhase('lobby');
  renderStartStats();
  showScreen('start');
  try {
    index = await loadIndex();
    catalog = await getCatalog();
    $('#start-count').textContent = `${catalog.length} Fragen in ${index.categories.length} Kategorien`;
  } catch (e) {
    console.error(e);
    $('#start-count').textContent = 'Fragen konnten nicht geladen werden. Läuft ein lokaler Server (npx serve)?';
    for (const b of $$('[data-act="single"]')) b.disabled = true;
  }
  await ageGate();
}

init();
