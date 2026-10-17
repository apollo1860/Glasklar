// Glasklar – Multiplayer-Steuerung.
// Jeder Client leitet seine Ansicht aus dem Raumzustand ab (meta, players, question, answered, fills, history).
// Der aktuelle Host (ältester verbundener Spieler, falls der ursprüngliche weg ist) treibt die Übergänge:
//   lobby → frage → reveal → (frage | endabrechnung) → … → ende
import { CONFIG } from './config.js';
import {
  computeQuestionFills, drawQuestion, answerFrequencies, electHost, activePlayers, allAnswered,
  revealSubmissions, sipsByPlayer, totalsFromHistory, rankBySips, roundWinners, compareDe, round1, drinkSips, isMiniSip,
} from './logic.js';
import { getQuestion, getSearchIndex } from './data.js';
import { store } from './storage.js';
import { sfx } from './audio.js';
import { createGlass } from './glass.js';
import { confetti, sparkle, splash, vibrate, wait, reducedMotion, flyInto } from './fx.js';
import { $, esc, showScreen, modal, toast, renderCategoryChips, sipsLabel, drinkLabel } from './ui.js';
import {
  settings, played, requestWake, releaseWake, revealKind, assessment, showRevealMsg, fillGlass, renderQuestionCard,
} from './common.js';
import {
  getBackend, backendMode, roomPath, session, createRoom, joinRoom, startPresence, leaveRoom,
} from './net.js';

const GAME_PHASES = new Set(['frage', 'reveal', 'endabrechnung']);
const REVEAL_GRACE_MS = 800; // Host wartet nach Ablauf der letzten 20 s kurz auf späte Antworten
const FALLBACK_MS = 4000; // danach darf jeder Client auflösen (Host im Hintergrund/weg)

export function createMultiplayer(ctx) {
  const M = {
    be: null, code: null,
    meta: null, players: {}, question: null, answered: {}, fills: {}, history: {}, played: {},
    q: null, // geladene Frage (mit Antworten)
    loadingSeq: null, shownSeq: null, revealedSeq: null, resultRound: null, revealTriggered: null,
    submitted: false, timerKey: null, fallbackTimer: 0,
    unsubs: [], presenceUnsub: null, loaded: false,
    syncing: false, syncAgain: false, lobbySettingsKey: null,
  };

  const uid = () => M.be?.uid;
  const me = () => M.players?.[uid()];
  const isHost = () => !!M.meta && electHost(M.meta.hostId, M.players) === uid();
  const active = () => activePlayers(M.players);
  const isPaused = () => !!M.meta && GAME_PHASES.has(M.meta.phase) && active().length < CONFIG.minPlayers;
  const nameOf = (pid) => M.players?.[pid]?.name ?? 'Unbekannt';
  const R = (p = '') => (p ? `${roomPath(M.code)}/${p}` : roomPath(M.code));
  const allCategories = () => ctx.getIndex()?.categories.map((c) => c.id) ?? [];

  /* ---------------------------------------------------------------- */
  /* Einstieg                                                          */
  /* ---------------------------------------------------------------- */

  function modeNote() {
    return backendMode() === 'local'
      ? 'Lokaler Testmodus – Firebase ist noch nicht eingerichtet. Öffne diese Seite in einem zweiten Tab, um gegen dich selbst zu spielen.'
      : '';
  }

  function openEntry(prefillCode = '') {
    ctx.setMode('multi');
    $('#mp-name').value = store.get('name', '');
    $('#mp-code').value = prefillCode;
    for (const el of [$('#mp-mode-note'), $('#lobby-mode-note')]) {
      el.textContent = modeNote();
      el.hidden = !modeNote();
    }
    showScreen('mp');
    ctx.setPhase('lobby');
    if (prefillCode && !$('#mp-name').value) $('#mp-name').focus();
  }

  function readName() {
    const n = $('#mp-name').value.trim().replace(/\s+/g, ' ').slice(0, 16);
    if (!n) {
      toast('Bitte gib zuerst deinen Namen ein');
      $('#mp-name').focus();
      return null;
    }
    store.set('name', n);
    return n;
  }

  async function withBusy(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(); } catch (e) {
      console.error(e);
      toast(friendlyError(e), 6000);
    } finally { btn.disabled = false; }
  }

  function friendlyError(e) {
    const code = String(e?.code || '');
    const msg = String(e?.message || '');
    if (code.includes('operation-not-allowed') || code.includes('admin-restricted-operation')) {
      return 'Firebase: Anonyme Anmeldung ist nicht aktiviert (Authentication → Anmeldemethode → Anonym).';
    }
    if (code.includes('unauthorized-domain')) {
      return `Firebase: Diese Domain ist nicht autorisiert (Authentication → Einstellungen → Autorisierte Domains → ${location.hostname}).`;
    }
    if (code.includes('network-request-failed')) return 'Keine Verbindung zu Firebase – Internet prüfen.';
    if (/permission/i.test(code + msg)) return 'Firebase: Keine Berechtigung – sind die Regeln aus database.rules.json veröffentlicht?';
    if (/Failed to fetch dynamically imported module|Importing a module script failed/i.test(msg)) {
      return 'Firebase-SDK konnte nicht geladen werden – Internet prüfen.';
    }
    return msg || 'Verbindung fehlgeschlagen';
  }

  function create(btn) {
    const name = readName();
    if (!name) return;
    withBusy(btn, async () => {
      const be = await getBackend();
      const s = settings.get();
      const all = allCategories();
      const cats = (s.categories || all).filter((id) => all.includes(id));
      const code = await createRoom(be, { name, categories: cats.length ? cats : all });
      await enter(be, code);
    });
  }

  function join(btn) {
    const name = readName();
    if (!name) return;
    const code = $('#mp-code').value.trim();
    if (!/^\d{4}$/.test(code)) {
      toast('Der Raumcode hat 4 Ziffern');
      $('#mp-code').focus();
      return;
    }
    withBusy(btn, async () => {
      const be = await getBackend();
      await joinRoom(be, code, name);
      await enter(be, code);
    });
  }

  async function enter(be, code) {
    teardown();
    Object.assign(M, {
      be, code, meta: null, players: {}, question: null, answered: {}, fills: {}, history: {}, played: {},
      q: null, loadingSeq: null, shownSeq: null, revealedSeq: null, resultRound: null, revealTriggered: null,
      submitted: false, timerKey: null, loaded: false, lobbySettingsKey: null,
    });
    session.set({ code, uid: be.uid });
    ctx.setMode('multi');
    ctx.countdown.now = () => be.now();
    setUrlCode(code);
    M.presenceUnsub = startPresence(be, code);
    const keys = { meta: null, players: {}, question: null, answered: {}, fills: {}, history: {}, played: {} };
    for (const [key, empty] of Object.entries(keys)) {
      M.unsubs.push(be.on(R(key), (v) => {
        M[key] = v ?? empty;
        if (key === 'meta') M.loaded = true;
        queueSync();
      }));
    }
    requestWake();
  }

  function teardown() {
    for (const u of M.unsubs) { try { u(); } catch { /* egal */ } }
    M.unsubs = [];
    try { M.presenceUnsub?.(); } catch { /* egal */ }
    M.presenceUnsub = null;
    clearTimeout(M.fallbackTimer);
    ctx.countdown.stop();
    $('#pause-overlay').hidden = true;
    releaseWake();
  }

  async function leave() {
    const { be, code } = M;
    teardown();
    session.clear();
    M.code = null;
    setUrlCode(null);
    if (be && code) await leaveRoom(be, code).catch(() => {});
    ctx.setMode('single');
    ctx.goHome();
  }

  function setUrlCode(code) {
    try {
      const url = new URL(location.href);
      if (code) url.searchParams.set('raum', code);
      else url.searchParams.delete('raum');
      history.replaceState(null, '', url);
    } catch { /* egal */ }
  }

  async function share() {
    const url = new URL(location.href);
    url.searchParams.set('raum', M.code);
    const text = `Spiel Glasklar mit mir! Raumcode ${M.code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Glasklar', text, url: url.toString() });
      else {
        await navigator.clipboard.writeText(`${text} – ${url}`);
        toast('Einladungslink kopiert');
      }
    } catch { /* abgebrochen */ }
  }

  /** Beim App-Start: Reconnect anbieten oder Einladungslink öffnen. */
  async function resume() {
    const urlCode = new URLSearchParams(location.search).get('raum');
    const s = session.get();
    if (s?.code && (!urlCode || urlCode === s.code)) {
      const ok = await modal({
        title: 'Zurück ins Spiel?',
        html: `<p>Du warst zuletzt in Raum <b>${esc(s.code)}</b>.</p>`,
        buttons: [{ label: 'Nein', value: false }, { label: 'Weiterspielen', value: true, kind: 'primary' }],
      });
      if (ok) {
        try {
          const be = await getBackend();
          await joinRoom(be, s.code, store.get('name', ''));
          await enter(be, s.code);
          return true;
        } catch (e) {
          toast(e.message, 3500);
        }
      }
      session.clear();
      setUrlCode(null);
      if (!urlCode) return false;
    }
    if (urlCode && /^\d{4}$/.test(urlCode)) {
      openEntry(urlCode);
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Synchronisation                                                   */
  /* ---------------------------------------------------------------- */

  function queueSync() {
    if (M.syncing) { M.syncAgain = true; return; }
    M.syncing = true;
    queueMicrotask(async () => {
      try {
        do {
          M.syncAgain = false;
          await sync();
        } while (M.syncAgain);
      } catch (e) {
        console.error('[mp] sync', e);
      } finally {
        M.syncing = false;
      }
    });
  }

  async function sync() {
    if (!M.code) return;
    if (!M.meta) {
      if (M.loaded) {
        toast('Der Raum existiert nicht mehr');
        leave();
      }
      return;
    }
    if (!me()) return; // eigener Eintrag noch unterwegs

    // Host-Übergabe: ältester verbundener Spieler übernimmt
    if (isHost() && M.meta.hostId !== uid()) {
      M.be.update(R('meta'), { hostId: uid() }).catch(() => {});
    }
    $('#pause-overlay').hidden = !isPaused();
    if (M.meta.phase !== 'reveal') closeQReview();

    switch (M.meta.phase) {
      case 'lobby': renderLobby(); break;
      case 'frage': await syncQuestion(); break;
      case 'reveal': await syncReveal(); break;
      case 'endabrechnung': syncResult(); break;
      case 'ende': syncEnd(); break;
      default: break;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Lobby                                                             */
  /* ---------------------------------------------------------------- */

  function renderLobby() {
    if (document.body.dataset.screen !== 'lobby') {
      showScreen('lobby');
      ctx.setPhase('lobby');
      M.lobbySettingsKey = null;
    }
    const host = isHost();
    $('#lobby-code').textContent = M.code;
    renderPlayerList($('#lobby-players'));
    const n = active().length;
    $('#lobby-count').textContent = `${n} verbunden`;

    const cats = M.meta.categories?.length ? M.meta.categories : allCategories();
    $('#lobby-host-settings').hidden = !host;
    $('#lobby-guest-settings').hidden = host;
    const key = `${host}|${cats.join(',')}`;
    if (key !== M.lobbySettingsKey) {
      M.lobbySettingsKey = key;
      if (host) {
        renderCategoryChips($('#lobby-categories'), ctx.getIndex().categories, cats, (list) => {
          M.be.update(R('meta'), { categories: list.length ? list : null }).catch(() => {});
          settings.set({ categories: list });
        });
      } else {
        const names = ctx.getIndex().categories.filter((c) => cats.includes(c.id)).map((c) => c.name);
        $('#lobby-settings-text').innerHTML = `<b>Kategorien:</b> ${esc(names.join(', '))}`;
      }
    }

    const btn = $('#btn-mp-start');
    btn.hidden = !host;
    btn.disabled = n < CONFIG.minPlayers || !(M.meta.categories?.length ?? true);
    $('#lobby-wait').textContent = host
      ? (n < CONFIG.minPlayers ? `Mindestens ${CONFIG.minPlayers} Spieler nötig – teile den Raumcode.` : '')
      : 'Warte, bis der Host das Spiel startet …';
  }

  function renderPlayerList(ul) {
    const hostId = electHost(M.meta?.hostId, M.players);
    const list = Object.entries(M.players || {})
      .filter(([, p]) => p && !p.left)
      .sort((a, b) => (a[1].joinedAt ?? 0) - (b[1].joinedAt ?? 0));
    ul.innerHTML = list.map(([pid, p]) => `
      <li class="${p.connected ? '' : 'offline'} ${pid === uid() ? 'me' : ''}">
        <span class="p-dot" aria-hidden="true"></span>
        <span class="p-name">${esc(p.name)}</span>
        ${pid === hostId ? '<span class="p-tag">Host</span>' : ''}
        ${pid === uid() ? '<span class="p-tag p-tag--me">Du</span>' : ''}
        ${p.connected ? '' : '<span class="p-tag p-tag--off">offline</span>'}
      </li>`).join('');
  }

  function renderStrip() {
    const strip = $('#players-strip');
    const showAnswered = M.meta.phase === 'frage';
    const list = Object.entries(M.players || {})
      .filter(([, p]) => p && !p.left)
      .sort((a, b) => (a[1].joinedAt ?? 0) - (b[1].joinedAt ?? 0));
    strip.innerHTML = list.map(([pid, p]) => {
      const done = showAnswered && M.answered?.[pid];
      return `<span class="strip-p ${done ? 'done' : ''} ${p.connected ? '' : 'offline'} ${pid === uid() ? 'me' : ''}">
        ${done ? '<i aria-hidden="true">✓</i>' : ''}${esc(p.name)}</span>`;
    }).join('');
  }

  /* ---------------------------------------------------------------- */
  /* Host-Aktionen                                                     */
  /* ---------------------------------------------------------------- */

  async function drawAndStart({ round, qNum, newRound }) {
    const meta = M.meta;
    const catalog = ctx.getCatalog();
    const enabled = meta.categories?.length ? meta.categories : allCategories();
    const roomPlayed = new Set(Object.keys(M.played || {}));
    const roundQ = newRound ? {} : { ...(meta.roundQ || {}) };
    const exclude = new Set(Object.keys(roundQ));
    const lastCategory = newRound ? null : meta.lastCat;
    // Erst Raum + dieses Gerät meiden, dann nur den Raum, sonst Stapel neu mischen
    let pick = drawQuestion({ catalog, enabled, played: new Set([...roomPlayed, ...played.get()]), exclude, lastCategory });
    let reset = false;
    if (pick?.reset) {
      pick = drawQuestion({ catalog, enabled, played: roomPlayed, exclude, lastCategory });
      reset = !!pick?.reset;
    }
    if (!pick) { toast('Keine Fragen in den gewählten Kategorien'); return; }
    roundQ[pick.id] = true;
    const TS = M.be.TS;
    const upd = {
      'meta/phase': 'frage',
      'meta/round': round,
      'meta/qNum': qNum,
      'meta/lastCat': pick.kategorie,
      'meta/roundQ': roundQ,
      'meta/pausedAt': null,
      'meta/lastActive': TS,
      question: {
        seq: (M.question?.seq || 0) + 1,
        id: pick.id,
        kategorie: pick.kategorie,
        shownAt: TS,
      },
      answers: null,
      answered: null,
    };
    if (reset) {
      upd.played = { [pick.id]: true };
      played.resetCategories(catalog, enabled);
      toast('Alle Fragen gespielt – Stapel neu gemischt');
    } else {
      upd[`played/${pick.id}`] = true;
    }
    if (newRound) upd.fills = null;
    await M.be.update(R(), upd);
    M.be.set(`roomsActivity/${M.code}`, TS).catch(() => {});
  }

  function triggerReveal(seq) {
    if (M.meta?.phase !== 'frage' || M.question?.seq !== seq || M.revealTriggered === seq) return;
    M.revealTriggered = seq;
    M.be.update(R('meta'), { phase: 'reveal' }).catch(() => { M.revealTriggered = null; });
  }

  function writeFills(fills) {
    const qKey = `q${M.meta.qNum}`;
    const upd = {};
    for (const [pid, f] of Object.entries(fills)) {
      if (M.fills?.[pid]?.[qKey] !== f.fill) upd[`fills/${pid}/${qKey}`] = f.fill;
    }
    if (Object.keys(upd).length) M.be.update(R(), upd).catch(() => {});
  }

  async function toResult() {
    const round = M.meta.round;
    const sips = sipsByPlayer(M.fills);
    await M.be.update(R(), { 'meta/phase': 'endabrechnung', [`history/r${round}`]: sips, 'meta/lastActive': M.be.TS });
  }

  /* ---------------------------------------------------------------- */
  /* Frage                                                             */
  /* ---------------------------------------------------------------- */

  /** Lädt die aktuelle Frage und baut den Spielbildschirm auf (einmal pro Frage). */
  async function ensureQuestionShown() {
    const qs = M.question;
    if (!qs?.id) return false;
    if (M.shownSeq === qs.seq) return true;
    if (M.loadingSeq === qs.seq) return false;
    M.loadingSeq = qs.seq;
    const data = await getQuestion(qs.id, qs.kategorie);
    if (M.question?.seq !== qs.seq) return false; // überholt
    M.q = data;
    M.shownSeq = qs.seq;
    M.submitted = !!M.answered?.[uid()];
    M.timerKey = null;
    played.add(qs.id);

    const prior = priorFill();
    ctx.gameGlass.overflow(prior > CONFIG.maxSipsPerRound);
    ctx.gameGlass.setLevel(Math.min(prior, CONFIG.maxSipsPerRound), { animate: false });
    if (document.body.dataset.screen !== 'game') showScreen('game');
    renderQuestionCard(data, { cat: ctx.catName(qs.kategorie), round: M.meta.round, qNum: M.meta.qNum, canSkip: isHost() });
    ctx.answerInput.setQuestion(data, getSearchIndex(data));
    if (M.submitted) ctx.answerInput.lock('Warte auf die anderen …');
    return true;
  }

  /** Eigene Füllung der Runde vor der aktuellen Frage. */
  function priorFill() {
    const mine = M.fills?.[uid()] || {};
    let sum = 0;
    for (let i = 1; i < (M.meta?.qNum || 1); i++) sum += Number(mine[`q${i}`]) || 0;
    return round1(sum);
  }

  async function syncQuestion() {
    if (!(await ensureQuestionShown())) return;
    ctx.setPhase('frage');
    const qs = M.question;
    $('#btn-skip').hidden = !isHost();
    renderStrip();

    if (isHost() && !isPaused() && allAnswered(M.players, M.answered)) {
      triggerReveal(qs.seq);
      return;
    }

    // Kein Zeitlimit, bis nur noch einer fehlt – dann startet die "Letzte Chance"
    if (!qs.lastCallAt) {
      showTimer(false);
      M.timerKey = null;
      clearTimeout(M.fallbackTimer);
      const missing = active().filter((p) => !M.answered?.[p.id]);
      if (isHost() && !isPaused() && active().length >= CONFIG.minPlayers && missing.length === 1) {
        M.be.update(R('question'), { lastCallAt: M.be.TS }).catch(() => {});
      }
      return;
    }

    const secs = CONFIG.lastAnswerSeconds;
    const deadline = qs.lastCallAt + secs * 1000;
    showTimer(true);
    ctx.countdown.seconds = secs;
    if (isPaused()) {
      M.timerKey = null;
      clearTimeout(M.fallbackTimer);
      ctx.countdown.freeze(deadline - (M.meta.pausedAt || M.be.now()));
      if (isHost() && !M.meta.pausedAt) M.be.update(R('meta'), { pausedAt: M.be.TS }).catch(() => {});
      return;
    }
    if (M.meta.pausedAt) {
      // Pause vorbei: Letzte-Chance-Zeit um die Pausendauer verschieben
      if (isHost()) {
        const shift = Math.max(0, M.be.now() - M.meta.pausedAt);
        M.be.update(R(), { 'question/lastCallAt': qs.lastCallAt + shift, 'meta/pausedAt': null }).catch(() => {});
      }
      return;
    }
    const key = `${qs.seq}:${qs.lastCallAt}`;
    if (M.timerKey !== key) {
      M.timerKey = key;
      ctx.countdown.start(qs.lastCallAt);
      clearTimeout(M.fallbackTimer);
      M.fallbackTimer = setTimeout(() => triggerReveal(qs.seq), Math.max(0, deadline - M.be.now()) + FALLBACK_MS);
      if (!M.submitted) toast(`Alle anderen sind fertig – noch ${secs} Sekunden!`, 3000);
    }
  }

  function showTimer(on) {
    $('#game-timer').hidden = !on;
  }

  async function onSubmit(sub) {
    if (M.meta?.phase !== 'frage' || M.submitted) return;
    M.submitted = true;
    ctx.answerInput.lock('Warte auf die anderen …');
    try {
      await M.be.update(R(), { [`answers/${uid()}`]: sub, [`answered/${uid()}`]: true });
    } catch {
      toast('Zu spät – die Antwort kam nicht mehr an');
    }
  }

  function onTimeout() {
    if (M.meta?.phase !== 'frage') return;
    const seq = M.question?.seq;
    sfx.buzz();
    ctx.answerInput.flushNoHit();
    const sel = ctx.answerInput.currentSelection();
    if (!M.submitted && sel) onSubmit(sel);
    else if (!M.submitted) {
      M.submitted = true;
      ctx.answerInput.lock('Zeit abgelaufen – gleich kommt die Auflösung');
    }
    if (isHost()) setTimeout(() => triggerReveal(seq), REVEAL_GRACE_MS);
  }

  /* ---------------------------------------------------------------- */
  /* Reveal                                                            */
  /* ---------------------------------------------------------------- */

  async function syncReveal() {
    const qs = M.question;
    if (!qs?.id) return;
    if (M.revealedSeq !== qs.seq) {
      if (!(await ensureQuestionShown())) return;
      if (M.revealedSeq === qs.seq) return;
      M.revealedSeq = qs.seq;
      clearTimeout(M.fallbackTimer);
      ctx.countdown.stop();
      showTimer(false);
      ctx.answerInput.lock();
      ctx.setPhase('reveal');
      const answers = (await M.be.get(R('answers')).catch(() => null)) || {};
      runReveal(answers);
    }
    renderStrip();
    updateRevealControls();
  }

  function updateRevealControls() {
    const ready = $('#reveal-panel').dataset.done === '1';
    const host = isHost();
    const next = $('#btn-next');
    next.textContent = M.meta.qNum >= CONFIG.questionsPerRound ? 'Zur Abrechnung' : 'Nächste Frage';
    next.hidden = !(ready && host);
    next.disabled = isPaused();
    $('#reveal-wait').hidden = !(ready && !host);
  }

  async function runReveal(answers) {
    const q = M.q;
    const seq = M.question.seq;
    const subs = revealSubmissions(M.players, answers);
    const fills = computeQuestionFills(subs, q, { multiplayer: true });
    if (isHost()) writeFills(fills);

    const panel = $('#reveal-panel');
    panel.dataset.done = '0';
    $('#btn-q-review').hidden = true;
    $('#btn-skip').hidden = true;
    $('#answer-area').hidden = true;
    const mySub = subs[uid()];
    const groups = answerFrequencies(subs, q);
    const myKey = mySub ? (mySub.type === 'answer' ? mySub.answerId : mySub.type === 'nothing' ? '__nothing' : '__timeout') : null;
    renderGroups(groups, myKey);
    panel.hidden = false;
    updateRevealControls();

    await wait(300);
    const mine = fills[uid()];
    if (mine) {
      const glass = ctx.gameGlass;
      const prior = priorFill();
      const cap = CONFIG.maxSipsPerRound;
      showRevealMsg(revealKind(mySub, mine.base, q.typ));
      const answer = mySub.type === 'answer' ? q.answers.find((a) => a.id === mySub.answerId) : null;
      if (answer?.tier === 1) glass.flashRed();
      await fillGlass(glass, Math.min(prior, cap), Math.min(round1(prior + mine.base), cap));

      // Gleiche Antworten: Chips der anderen fliegen ins Glas, je ein Spritzer
      const myChip = $('#reveal-chips .answer-group.mine .answer-chip');
      const others = (groups.find((g) => g.key === myKey)?.count || 1) - 1;
      if (mySub.type === 'answer' && others > 0 && myChip) {
        let lvl = Math.min(round1(prior + mine.base), cap);
        for (let i = 0; i < Math.min(others, 4); i++) {
          if (M.question?.seq !== seq) return;
          await new Promise((res) => flyInto(myChip, glass.surfacePoint(), res));
          const p = glass.surfacePoint();
          splash(p.x, p.y, 12);
          sfx.splash();
          vibrate(30);
          if (i < mine.bonus && lvl < cap) {
            lvl = Math.min(lvl + 1, cap);
            glass.setLevel(lvl);
            glass.shake(lvl >= 7);
            sfx.blub(lvl);
          }
          await wait(reducedMotion() ? 100 : 380);
        }
      }
      if (mine.fill === 0) {
        glass.glow('rare');
        const p = glass.surfacePoint();
        sparkle(p.x, p.y - 30, p.width * 0.8);
        sfx.clink();
        vibrate([20, 40, 20]);
      }
      if (round1(prior + mine.fill) > cap) glass.overflow(true);
    }
    if (M.question?.seq !== seq) return;
    panel.dataset.done = '1';
    renderQReview(q, subs, fills);
    $('#btn-q-review').hidden = false;
    updateRevealControls();
    await wait(reducedMotion() ? 200 : 900);
    if (M.question?.seq === seq && M.meta?.phase === 'reveal') openQReview();
  }

  /** Rückblick zur Frage: wer was geantwortet hat und wie das Spiel es einschätzt. */
  function renderQReview(q, subs, fills) {
    const rows = Object.keys(subs)
      .sort((a, b) => (fills[a]?.fill ?? 0) - (fills[b]?.fill ?? 0) || compareDe(nameOf(a), nameOf(b)))
      .map((pid) => {
        const as = assessment(q, subs[pid]);
        return `<li class="${pid === uid() ? 'me' : ''}">
          <span class="rv-name">${esc(pid === uid() ? 'Du' : nameOf(pid))}</span>
          <span class="rv-answer">${esc(as.text)}</span>
          <span class="rv-tag ${as.kind}">${esc(as.label)}</span>
        </li>`;
      });
    $('#q-review-body').innerHTML = `<p class="rv-text">${esc(q.text)}</p><ol class="rv-list">${rows.join('')}</ol>`;
  }

  function openQReview() {
    if (M.meta?.phase !== 'reveal') return;
    const box = $('#q-review');
    box.hidden = false;
    $('#q-review-skip').onclick = closeQReview;
    box.onclick = (e) => { if (e.target === box) closeQReview(); };
    $('#q-review-skip').focus({ preventScroll: true });
  }

  function closeQReview() {
    $('#q-review').hidden = true;
  }

  function renderGroups(groups, myKey) {
    $('#reveal-chips').innerHTML = groups.map((g, i) => {
      const names = g.players.map((pid) => (pid === uid() ? 'Du' : nameOf(pid)));
      return `<div class="answer-group ${g.key === myKey ? 'mine' : ''}" style="--i:${i}">
        <span class="answer-chip ${g.key.startsWith('__') ? 'muted' : ''} ${g.key === myKey ? 'mine' : ''}">
          <span>${esc(g.label)}</span>${g.count > 1 ? `<b class="chip-count">${g.count}×</b>` : ''}
        </span>
        <span class="answer-names">${esc(names.join(', '))}</span>
      </div>`;
    }).join('');
  }

  function onNext() {
    if (!isHost() || M.meta?.phase !== 'reveal' || isPaused()) return;
    if ($('#reveal-panel').dataset.done !== '1') return;
    if (M.meta.qNum >= CONFIG.questionsPerRound) toResult();
    else drawAndStart({ round: M.meta.round, qNum: M.meta.qNum + 1, newRound: false });
  }

  /* ---------------------------------------------------------------- */
  /* Endabrechnung                                                     */
  /* ---------------------------------------------------------------- */

  function syncResult() {
    if (M.resultRound !== M.meta.round) {
      M.resultRound = M.meta.round;
      runResult();
    }
    updateResultControls();
    renderRanking();
  }

  function updateResultControls() {
    const done = $('#mpr-actions').classList.contains('show');
    const host = isHost();
    $('#mpr-new').hidden = !host;
    $('#mpr-end').hidden = !host;
    $('#mpr-new').disabled = isPaused();
    $('#mpr-wait').hidden = host || !done;
  }

  function renderRanking() {
    const totals = totalsFromHistory(M.history);
    const ranked = rankBySips(totals);
    $('#mpr-ranking').innerHTML = ranked.map((r) => `
      <li class="${r.id === uid() ? 'me' : ''} ${r.rank === 1 ? 'top' : ''}">
        <span class="rk">${r.rank}.</span><span class="rn">${esc(r.id === uid() ? `${nameOf(r.id)} (du)` : nameOf(r.id))}</span><b>${sipsLabel(r.sips)}</b>
      </li>`).join('');
  }

  async function runResult() {
    const round = M.meta.round;
    showScreen('mp-result');
    ctx.setPhase('endabrechnung');
    ctx.countdown.stop();
    const sips = M.history?.[`r${round}`] || sipsByPlayer(M.fills);
    const entries = Object.entries(sips).sort((a, b) => a[1] - b[1] || compareDe(nameOf(a[0]), nameOf(b[0])));
    $('#mpr-title').textContent = `Runde ${round} – Abrechnung`;
    $('#mpr-actions').classList.remove('show');

    const row = $('#mpr-glasses');
    row.innerHTML = '';
    row.style.setProperty('--n', String(Math.max(entries.length, 1)));
    const cells = entries.map(([pid, n]) => {
      const cell = document.createElement('div');
      cell.className = `glass-cell ${pid === uid() ? 'me' : ''}`;
      cell.innerHTML = `<div class="gc-glass"></div><div class="gc-name">${esc(pid === uid() ? 'Du' : nameOf(pid))}</div><div class="gc-count">0</div>`;
      row.appendChild(cell);
      const glass = createGlass(cell.querySelector('.gc-glass'), { compact: true });
      return { pid, n, d: drinkSips(n), mini: isMiniSip(n), cell, glass, count: cell.querySelector('.gc-count') };
    });
    const list = $('#mpr-list');
    list.innerHTML = entries.map(([pid, n]) => `
      <li class="${pid === uid() ? 'me' : ''}" data-pid="${esc(pid)}">
        ${pid === uid() ? 'Du trinkst' : `<b>${esc(nameOf(pid))}</b> trinkt`} <span class="n">${drinkLabel(n)}</span>
      </li>`).join('');
    list.classList.remove('show');
    renderRanking();
    updateResultControls();

    await wait(450);
    if (M.meta?.phase !== 'endabrechnung' || M.meta.round !== round) return;
    sfx.fanfare();
    for (const c of cells) {
      if (c.mini) { c.glass.setLevel(c.n); c.count.textContent = 'Mini'; }
    }
    const max = Math.max(0, ...cells.map((c) => c.d));
    for (let lvl = 1; lvl <= max; lvl++) {
      for (const c of cells) {
        if (lvl <= c.d) {
          c.glass.setLevel(lvl);
          c.glass.shake(lvl >= 7);
          c.count.textContent = String(lvl);
        }
      }
      sfx.blub(lvl);
      vibrate(lvl >= 7 ? 35 : 15);
      await wait(reducedMotion() ? 60 : 240);
    }
    list.classList.add('show');

    const winners = roundWinners(sips);
    const allSame = entries.every(([, n]) => n === entries[0][1]);
    for (const c of cells) {
      if (!allSame && c.d === max && max > 0) c.glass.overflow(true);
      if (winners.includes(c.pid)) {
        c.cell.classList.add('winner');
        list.querySelector(`li[data-pid="${CSS.escape(c.pid)}"]`)?.classList.add('winner');
      }
    }
    if (entries.length) {
      confetti();
      sfx.clink();
    }
    $('#mpr-actions').classList.add('show');
    updateResultControls();
  }

  /* ---------------------------------------------------------------- */
  /* Spielende                                                         */
  /* ---------------------------------------------------------------- */

  function syncEnd() {
    if (document.body.dataset.screen === 'summary') return;
    ctx.countdown.stop();
    ctx.setPhase('lobby');
    releaseWake();
    const totals = totalsFromHistory(M.history);
    const ranked = rankBySips(totals);
    const rounds = Object.keys(M.history || {}).length;
    $('#summary-body').innerHTML = ranked.length ? `
      <div class="summary-hero">
        <div class="big">${esc(ranked.filter((r) => r.rank === 1).map((r) => nameOf(r.id)).join(' & '))}</div>
        <div class="sub">hat am wenigsten getrunken · ${rounds} ${rounds === 1 ? 'Runde' : 'Runden'}</div>
      </div>
      <ol class="summary-rounds">
        ${ranked.map((r) => `<li class="${r.rank === 1 ? 'best' : ''}"><span>${r.rank}. ${esc(nameOf(r.id))}${r.id === uid() ? ' (du)' : ''}</span><b>${sipsLabel(r.sips)}</b></li>`).join('')}
      </ol>`
      : '<p class="muted">Keine Runde beendet.</p>';
    showScreen('summary');
    session.clear();
  }

  /* ---------------------------------------------------------------- */
  /* Aktionen aus der UI                                               */
  /* ---------------------------------------------------------------- */

  async function confirmLeave() {
    const ok = await modal({
      title: 'Raum verlassen?',
      html: '<p>Die anderen spielen ohne dich weiter.</p>',
      buttons: [{ label: 'Bleiben', value: false }, { label: 'Verlassen', value: true, kind: 'danger' }],
    });
    if (ok) leave();
  }

  /** true = Aktion wurde hier behandelt. */
  function onAction(act, el) {
    switch (act) {
      case 'mp-create': create(el); return true;
      case 'mp-join': join(el); return true;
      case 'mp-share': share(); return true;
      case 'mp-start':
        if (isHost() && active().length >= CONFIG.minPlayers) withBusy(el, () => drawAndStart({ round: 1, qNum: 1, newRound: true }));
        return true;
      case 'mp-leave':
      case 'exit':
        if (M.code) confirmLeave();
        else { ctx.setMode('single'); ctx.goHome(); }
        return true;
      case 'skip':
        if (isHost() && M.meta?.phase === 'frage') {
          sfx.pop();
          drawAndStart({ round: M.meta.round, qNum: M.meta.qNum, newRound: false });
        }
        return true;
      case 'next': onNext(); return true;
      case 'q-review': openQReview(); return true;
      case 'new-round':
        if (isHost() && M.meta?.phase === 'endabrechnung' && !isPaused()) {
          drawAndStart({ round: M.meta.round + 1, qNum: 1, newRound: true });
        }
        return true;
      case 'end-game':
        if (isHost()) M.be.update(R('meta'), { phase: 'ende', lastActive: M.be.TS }).catch(() => {});
        return true;
      case 'home':
        if (M.code) leave();
        else { ctx.setMode('single'); return false; }
        return true;
      default: return false;
    }
  }

  return { openEntry, onSubmit, onTimeout, onAction, resume };
}
