// Glasklar – App-Start, Zustandsmaschine und Singleplayer.
// Zustände pro Frage: lobby → frage → reveal → (frage | endabrechnung) → lobby
import { CONFIG } from './config.js';
import { computeQuestionFills, roundExact, drinkSips, isMiniSip, drawQuestion, answerFrequencies } from './logic.js';
import { loadIndex, getCatalog, getQuestion, getSearchIndex } from './data.js';
import { store } from './storage.js';
import { initAudio, sfx, isMuted, setMuted } from './audio.js';
import { createGlass } from './glass.js';
import { confetti, sparkle, vibrate, wait, reducedMotion } from './fx.js';
import {
  $, $$, showScreen, initViewport, modal, toast, missingLog, AnswerInput,
  renderCategoryChips, renderAnswerChips, sipsLabel, drinkLabel,
} from './ui.js';
import {
  settings, played, requestWake, releaseWake, Countdown,
  revealKind, showRevealMsg, fillGlass, renderQuestionCard,
} from './common.js';
import { createMultiplayer } from './mp.js';

/* ------------------------------------------------------------------ */
/* Einstellungen & Statistik                                           */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Spielzustand                                                        */
/* ------------------------------------------------------------------ */

const S = {
  phase: 'lobby',
  mode: 'single',
  enabled: [],
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
let mp = null;

function setMode(m) {
  S.mode = m;
  document.body.dataset.mode = m;
}

function goHome() {
  renderStartStats();
  setPhase('lobby');
  showScreen('start');
}

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
  showScreen('setup');
}

async function startSingle() {
  setMode('single');
  countdown.now = () => Date.now();
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
      toast('Alle Fragen gespielt – Stapel neu gemischt');
    }
    played.add(pick.id); // gilt ab Anzeige als gespielt (auch bei Skip)
    S.roundQIds.add(pick.id);
    S.lastCat = pick.kategorie;
    const question = await getQuestion(pick.id, pick.kategorie);
    S.question = question;
    renderQuestionCard(question, { cat: catName(question.kategorie), round: S.round, qNum: S.qNum, canSkip: true });
    setPhase('frage');
    answerInput.setQuestion(question, getSearchIndex(question));
    $('#game-timer').hidden = true; // Singleplayer ohne Zeitlimit
  } catch (e) {
    console.error(e);
    toast(`Fehler beim Laden: ${e.message}`, 4000);
  } finally {
    S.busy = false;
  }
}

function skipQuestion() {
  if (S.phase !== 'frage' || S.busy) return;
  countdown.stop();
  sfx.pop();
  // Vorhandene Eingabe wird verworfen, Frage zählt nicht als eine der 3
  showNewQuestion();
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

async function reveal(sub) {
  const q = S.question;
  $('#btn-skip').hidden = true;
  $('#btn-q-review').hidden = true;
  $('#answer-area').hidden = true;
  const { me } = computeQuestionFills({ me: sub }, q, { multiplayer: false });
  const fill = me.fill;
  const before = roundExact(S.fills);
  S.fills.push(fill);
  const total = roundExact(S.fills, { maxSipsPerRound: Infinity });

  const answer = sub.type === 'answer' ? q.answers.find((a) => a.id === sub.answerId) : null;
  const kind = revealKind(sub, me.base, q.typ);

  // Antwort-Chips (Häufigkeit), keine Schluck-Anzahl
  const groups = answerFrequencies({ me: sub }, q);
  renderAnswerChips($('#reveal-chips'), groups, { highlightKey: groups[0]?.key });
  $('#reveal-question').textContent = q.text;
  $('#reveal-panel').hidden = false;
  $('#btn-next').hidden = true;

  await wait(250);
  showRevealMsg(kind);

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
  next.textContent = last ? 'Zur Abrechnung' : 'Nächste Frage';
  next.hidden = false;
  next.focus({ preventScroll: true });
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
  const exact = roundExact(S.fills);
  const sips = drinkSips(exact); // ab ,5 aufrunden, darunter abrunden
  const mini = isMiniSip(exact);
  S.history.push({ round: S.round, sips, exact });
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
  if (mini) {
    resultGlass.setLevel(exact);
    big.innerHTML = 'Mini-Schluck trinken';
    sfx.blub(1);
  }
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
    note.textContent = 'Randvoll – das Glas läuft über.';
  } else if (mini) {
    note.textContent = 'Fast glasklar – nur ein Hauch im Glas.';
  } else if (sips === 0) {
    note.textContent = 'Glasklar. Kein einziger Schluck.';
  } else if (exact !== sips) {
    note.textContent = `Genau ${String(exact).replace('.', ',')} – ${exact > sips ? 'abgerundet' : 'aufgerundet'}.`;
  }
  if (best.isBest && best.hadBest) {
    note.textContent = `Neuer Bestwert – vorher ${sipsLabel(best.prevBest)}`;
    confetti();
    sfx.clink();
  } else if (sips === 0 && !mini) {
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
      ${S.history.map((h) => `<li class="${h.sips === best ? 'best' : ''}"><span>Runde ${h.round}</span><b>${drinkLabel(h.exact ?? h.sips)}</b></li>`).join('')}
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
  $('#settings-sound').checked = !isMuted();
  $('#settings-vibrate').checked = s.vibrate;
  updateMissingCount();
  showScreen('settings');
}

function updateMissingCount() {
  const n = missingLog.all().length;
  $('#missing-count').textContent = `${n} ${n === 1 ? 'Eintrag' : 'Einträge'}`;
}

const ICON_SOUND = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>';
const ICON_MUTED = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>';

function updateMuteButtons() {
  for (const b of $$('[data-act="mute"]')) {
    b.innerHTML = isMuted() ? ICON_MUTED : ICON_SOUND;
    b.setAttribute('aria-label', isMuted() ? 'Ton an' : 'Ton aus');
  }
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

async function ageGate() {
  if (store.get('ageOk', false)) return;
  await modal({
    title: 'Bevor es losgeht',
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
      <li>Nach 3 Fragen trinkst du so viele Schlücke, wie dein Glas voll ist (max. ${CONFIG.maxSipsPerRound}). Seltene Antworten geben auch mal 0,3 – abgerechnet wird gerundet (ab ,5 auf), unter 0,5 gibt es nur einen Mini-Schluck.</li>
    </ol>`,
    buttons: [{ label: 'Alles klar', value: true, kind: 'primary' }],
  });
}

function renderStartStats() {
  const st = stats.get();
  $('#start-stats').innerHTML = st.rounds
    ? `<span>Bestwert <b>${sipsLabel(st.best)}</b></span><span><b>${st.rounds}</b> ${st.rounds === 1 ? 'Runde' : 'Runden'} gespielt</span>`
    : '';
}

function bind() {
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (S.mode === 'multi' && mp.onAction(act, el)) return;
    switch (act) {
      case 'single': setMode('single'); openSetup(); break;
      case 'multi': mp.openEntry(); break;
      case 'settings': openSettings(); break;
      case 'howto': howTo(); break;
      case 'home': goHome(); break;
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
  $('#mp-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('[data-act="mp-join"]').click(); });
  $('#mp-code').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });
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
    onSubmit: (sub) => (S.mode === 'multi' ? mp.onSubmit(sub) : submitAnswer(sub)),
  });
  countdown = new Countdown({
    seconds: CONFIG.lastAnswerSeconds, bar: $('#timer-bar'), label: $('#timer-num'),
    onEnd: () => { if (S.mode === 'multi') mp.onTimeout(); },
  });
  mp = createMultiplayer({
    gameGlass, answerInput, countdown, setPhase, setMode, goHome, catName,
    getIndex: () => index,
    getCatalog: () => catalog,
  });
  setMode('single');
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
    for (const b of $$('[data-act="single"], [data-act="multi"]')) b.disabled = true;
    return;
  }
  await ageGate();
  await mp.resume();
}

init();
