// Glasklar – reine Spiellogik (ohne DOM). Läuft im Browser und in Node (Tests, Tools).
import { CONFIG } from './config.js';

/* ------------------------------------------------------------------ */
/* Normalisierung                                                      */
/* ------------------------------------------------------------------ */

const UMLAUT_AE = { ä: 'ae', ö: 'oe', ü: 'ue' };
const LEADING_ARTICLE = /^(der|die|das|den|dem|des|ein|eine|einen|einem|einer|eines)\s+/;

/**
 * Normalisiert einen Text für die Suche.
 * umlaut: 'ae' → ä wird ae, 'a' → ä wird a. ß wird immer ss.
 * Ergebnis: lowercase, ohne Akzente/Satzzeichen, ohne führenden Artikel, einfache Leerzeichen.
 */
export function normalize(str, umlaut = 'ae') {
  let s = String(str ?? '').toLowerCase().replace(/ß/g, 'ss');
  if (umlaut === 'ae') s = s.replace(/[äöü]/g, (c) => UMLAUT_AE[c]);
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[-_/+&.,]/g, ' ');
  s = s.replace(/[^a-z0-9\s]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(LEADING_ARTICLE, '');
  return s;
}

/** Vergleichsschlüssel ohne Leerzeichen. */
export function searchKey(str, umlaut = 'ae') {
  return normalize(str, umlaut).replace(/ /g, '');
}

/** Beide Schreibweisen (ä→ae und ä→a), dedupliziert. */
export function keyForms(str) {
  const a = searchKey(str, 'ae');
  const b = searchKey(str, 'a');
  return a === b ? [a] : [a, b];
}

/* ------------------------------------------------------------------ */
/* Tippfehler-Abstand                                                  */
/* ------------------------------------------------------------------ */

/**
 * Levenshtein-Abstand mit vertauschten Nachbarbuchstaben als 1 Fehler
 * (Optimal String Alignment): "Deutshcland" ↔ "Deutschland" = 1.
 */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/* ------------------------------------------------------------------ */
/* Suche                                                               */
/* ------------------------------------------------------------------ */

/** Baut den Suchindex einer Frage (einmal pro Frage). */
export function buildSearchIndex(question) {
  const index = question.answers.map((answer) => ({
    answer,
    keys: [
      { label: answer.text, isAlias: false, forms: keyForms(answer.text) },
      ...(answer.aliases || []).map((al) => ({ label: al, isAlias: true, forms: keyForms(al) })),
    ],
  }));
  index.tolerant = !question.typ; // offene Fragen: Plural, Wortteile, mehr Tippfehler
  return index;
}

const STEM_SUFFIXES = ['nen', 'en', 'er', 'es', 'e', 'n', 's'];
/** Grobe Grundform: Plural-/Flexionsendung ab (Äpfel/Apfel, Handtücher/Handtuch, Kerzen/Kerze). */
export function stem(key) {
  for (const suf of STEM_SUFFIXES) {
    if (key.endsWith(suf) && key.length - suf.length >= 3) return key.slice(0, -suf.length);
  }
  return key;
}

/** Wörter des Getippten (normalisiert, beide Umlautformen). */
function queryWords(query) {
  const out = new Set();
  for (const u of ['ae', 'a']) for (const w of normalize(query, u).split(' ')) if (w) out.add(w);
  return [...out];
}

const collator = typeof Intl !== 'undefined' ? new Intl.Collator('de', { sensitivity: 'base' }) : null;
export const compareDe = (a, b) => (collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0);

/**
 * Sucht nur GANZE Wörter – kein Durchblättern per Anfangsbuchstabe.
 * 1. Exakt: normalisierte Eingabe = Antworttext oder Alias (ä/ae/a, ß/ss, Akzente, Artikel egal).
 * 2. Nur wenn es keinen exakten Treffer gibt: ganzes Wort mit Tippfehler
 *    (Abstand <= fuzzyMaxDistance, erst ab fuzzyMinLength Buchstaben) – als Vorschlag markiert.
 * Ergebnis alphabetisch nach Haupttext: { id, text, alias: string|null, fuzzy: boolean }
 * tier wird weder zum Sortieren benutzt noch zurückgegeben.
 */
export function searchAnswers(index, query, opts = {}) {
  const max = opts.maxResults ?? CONFIG.search.maxResults;
  const fuzzyMin = opts.fuzzyMinLength ?? CONFIG.search.fuzzyMinLength;
  const fuzzyDist = opts.fuzzyMaxDistance ?? CONFIG.search.fuzzyMaxDistance;
  const qForms = keyForms(query).filter(Boolean);
  if (!qForms.length) return [];

  const toResult = (entry, key, fuzzy) => ({
    id: entry.answer.id,
    text: entry.answer.text,
    alias: key.isAlias ? key.label : null,
    fuzzy,
  });
  const sortAlpha = (list) => list.sort((a, b) => compareDe(a.text, b.text)).slice(0, max);

  // 1. Exakte Treffer (Haupttext vor Alias)
  const exact = [];
  for (const entry of index) {
    const key = entry.keys.find((k) => k.forms.some((f) => qForms.includes(f)));
    if (key) exact.push(toResult(entry, key, false));
  }
  if (exact.length) return sortAlpha(exact);

  const tol = (opts.tolerant ?? index.tolerant) ? CONFIG.search.tolerant : null;

  // 1b. Offene Fragen: gleiche Grundform (Plural, Endungen) gilt als Treffer
  if (tol) {
    const qStems = qForms.map(stem);
    const same = [];
    for (const entry of index) {
      const key = entry.keys.find((k) => k.forms.some((f) => qStems.includes(stem(f))));
      if (key) same.push(toResult(entry, key, false));
    }
    if (same.length) return sortAlpha(same);
  }

  // 2. Ganzes Wort mit Tippfehler
  const minLen = tol ? tol.fuzzyMinLength : fuzzyMin;
  const maxDistFor = (len) => (tol && len >= tol.fuzzy2MinLength ? Math.max(2, fuzzyDist) : fuzzyDist);
  const fuzzy = [];
  for (const entry of index) {
    let best = null;
    for (const key of entry.keys) {
      for (const f of key.forms) {
        for (const q of qForms) {
          const maxDist = maxDistFor(q.length);
          if (q.length < minLen || Math.abs(f.length - q.length) > maxDist) continue;
          const dist = levenshtein(q, f);
          if (dist <= maxDist && (!best || dist < best.dist || (dist === best.dist && best.key.isAlias && !key.isAlias))) {
            best = { dist, key };
          }
        }
      }
    }
    if (best) fuzzy.push({ ...toResult(entry, best.key, true), dist: best.dist });
  }
  if (fuzzy.length || !tol) {
    fuzzy.sort((a, b) => a.dist - b.dist || compareDe(a.text, b.text));
    return sortAlpha(fuzzy.slice(0, max).map(({ dist, ...r }) => r));
  }

  // 3. Offene Fragen: Wortteile – nur ganze getippte Wörter, nie Anfangsbuchstaben
  const words = queryWords(query).filter((w) => w.length >= tol.partMinLength);
  const parts = [];
  for (const entry of index) {
    let best = null;
    for (const key of entry.keys) {
      for (const f of key.forms) {
        if (f.length < tol.partMinLength) continue;
        for (const q of qForms) {
          let score = 0;
          if (q !== f && q.endsWith(f)) score = f.length / q.length; // Badezimmerspiegel → Spiegel
          else if (q !== f && f.endsWith(q) && q.length / f.length >= tol.partMinShare) score = q.length / f.length; // Bürste → Zahnbürste
          else if (q !== f && q.startsWith(f) && f.length / q.length >= tol.partMinShare) score = f.length / q.length; // Toilettenpapierrolle → Toilettenpapier
          if (score && (!best || score > best.score)) best = { score, key };
        }
        if (words.length > 1 && words.some((w) => w === f || stem(w) === stem(f))) {
          if (!best || best.score < 1) best = { score: 1, key }; // elektrische Zahnbürste → Zahnbürste
        }
      }
    }
    if (best) parts.push({ ...toResult(entry, best.key, true), score: best.score });
  }
  parts.sort((a, b) => b.score - a.score || compareDe(a.text, b.text));
  return sortAlpha(parts.slice(0, max).map(({ score, ...r }) => r));
}

/* ------------------------------------------------------------------ */
/* Bewertung                                                           */
/* ------------------------------------------------------------------ */

/**
 * Eine Abgabe: { type: 'answer', answerId } | { type: 'nothing' } | { type: 'timeout' }
 */
export function baseFill(submission, question, cfg = CONFIG) {
  if (!submission || submission.type === 'timeout') return cfg.fillTimeout;
  if (submission.type === 'nothing') return cfg.fillNothing;
  const answer = question.answers.find((a) => a.id === submission.answerId);
  if (!answer) return cfg.fillNothing; // unbekannte ID wird nie günstiger als "Nichts passt"
  return cfg.fillByTier[answer.tier] ?? 0;
}

/** Aufschlag für gleiche Antworten: +1 pro weiterem Spieler, gedeckelt. */
export function sameAnswerBonus(sameCount, cfg = CONFIG) {
  const others = Math.max(0, sameCount - 1);
  return Math.min(others * cfg.sameAnswerBonusPerPlayer, cfg.sameAnswerBonusMax);
}

/**
 * Füllung aller Spieler für eine Frage.
 * submissions: { [playerId]: submission }
 * returns: { [playerId]: { base, bonus, fill } }
 */
export function computeQuestionFills(submissions, question, { multiplayer = false, cfg = CONFIG } = {}) {
  const counts = new Map();
  // Bei Ranglisten zählt Wissen, nicht Originalität: kein Aufschlag für gleiche Antworten
  const withBonus = multiplayer && question.typ !== 'rangliste';
  if (withBonus) {
    for (const s of Object.values(submissions)) {
      if (s && s.type === 'answer') counts.set(s.answerId, (counts.get(s.answerId) || 0) + 1);
    }
  }
  const out = {};
  for (const [pid, s] of Object.entries(submissions)) {
    const base = baseFill(s, question, cfg);
    const bonus = withBonus && s && s.type === 'answer' ? sameAnswerBonus(counts.get(s.answerId), cfg) : 0;
    out[pid] = { base, bonus, fill: round1(base + bonus) };
  }
  return out;
}

/** Schlücke einer Runde = Summe der Füllungen, gekappt. */
/** Auf eine Nachkommastelle (gegen Gleitkomma-Reste wie 0,30000000004). */
export const round1 = (x) => Math.round((Number(x) || 0) * 10) / 10;

/** Exakte Füllung einer Runde (Dezimal, gekappt). */
export function roundExact(fills, cfg = CONFIG) {
  const sum = fills.reduce((acc, f) => acc + (Number(f) || 0), 0);
  return Math.min(round1(sum), cfg.maxSipsPerRound);
}

/** Zu trinkende Schlücke: ab ,5 aufrunden, darunter abrunden. */
export function drinkSips(exact) {
  return Math.floor(round1(exact) + 0.5);
}

/** Etwas im Glas, aber unter 0,5 → „Mini-Schluck" ohne Zahl. */
export function isMiniSip(exact) {
  return round1(exact) > 0 && drinkSips(exact) === 0;
}

/** Schlücke einer Runde (gerundet). */
export function roundSips(fills, cfg = CONFIG) {
  return drinkSips(roundExact(fills, cfg));
}

/** Antworten gruppiert mit Häufigkeit für den Reveal (ohne tier). */
export function answerFrequencies(submissions, question) {
  const groups = new Map();
  for (const [pid, s] of Object.entries(submissions)) {
    let key, label;
    if (!s || s.type === 'timeout') { key = '__timeout'; label = 'Keine Antwort'; }
    else if (s.type === 'nothing') { key = '__nothing'; label = 'Nichts passt'; }
    else {
      key = s.answerId;
      label = question.answers.find((a) => a.id === s.answerId)?.text ?? '?';
    }
    if (!groups.has(key)) groups.set(key, { key, label, count: 0, players: [] });
    const g = groups.get(key);
    g.count++;
    g.players.push(pid);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || compareDe(a.label, b.label));
}

/** Ranking: wer am wenigsten trinkt, führt. totals: { [pid]: sips } */
export function rankBySips(totals) {
  const sorted = Object.entries(totals).sort((a, b) => a[1] - b[1]);
  let rank = 0;
  let last = null;
  return sorted.map(([id, sips], i) => {
    if (sips !== last) { rank = i + 1; last = sips; }
    return { id, sips, rank };
  });
}

/** Alle Spieler mit dem leersten Glas (Gleichstand → alle). */
export function roundWinners(sipsByPlayer) {
  const vals = Object.values(sipsByPlayer);
  if (!vals.length) return [];
  const min = Math.min(...vals);
  return Object.keys(sipsByPlayer).filter((id) => sipsByPlayer[id] === min);
}

/* ------------------------------------------------------------------ */
/* Fragen ziehen                                                       */
/* ------------------------------------------------------------------ */

/**
 * Zieht eine Frage ohne Zurücklegen.
 * catalog: [{ id, kategorie }]
 * enabled: Kategorie-IDs
 * played: Set gespielter IDs
 * exclude: IDs, die keinesfalls (z. B. aktuelle Runde) gezogen werden sollen, sofern möglich
 * lastCategory: Kategorie der vorherigen Frage (wird gemieden, wenn möglich)
 * returns: { id, kategorie, reset } | null  — reset=true: Pool war leer, Aufrufer setzt played zurück
 */
export function drawQuestion({ catalog, enabled, played = new Set(), exclude = new Set(), lastCategory = null, rng = Math.random }) {
  const pool = catalog.filter((q) => enabled.includes(q.kategorie));
  if (!pool.length) return null;
  let reset = false;
  let avail = pool.filter((q) => !played.has(q.id) && !exclude.has(q.id));
  if (!avail.length) {
    reset = true;
    avail = pool.filter((q) => !exclude.has(q.id));
    if (!avail.length) avail = pool;
  }
  const preferred = avail.filter((q) => q.kategorie !== lastCategory);
  const from = preferred.length ? preferred : avail;
  const pick = from[Math.floor(rng() * from.length) % from.length];
  return { id: pick.id, kategorie: pick.kategorie, reset };
}

/** Katalog aus data/index.json. */
export function catalogFromIndex(index) {
  return index.categories.flatMap((c) => c.questions.map((id) => ({ id, kategorie: c.id })));
}

/* ------------------------------------------------------------------ */
/* Multiplayer-Helfer                                                  */
/* ------------------------------------------------------------------ */

/** Verbundene, nicht ausgetretene Spieler, sortiert nach Beitritt (älteste zuerst). */
export function activePlayers(players) {
  return Object.entries(players || {})
    .filter(([, p]) => p && p.connected && !p.left)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0) || (a.id < b.id ? -1 : 1));
}

/** Host bleibt, solange verbunden; sonst wird der älteste verbundene Spieler Host. */
export function electHost(hostId, players) {
  const active = activePlayers(players);
  if (active.some((p) => p.id === hostId)) return hostId;
  return active[0]?.id ?? hostId ?? null;
}

/** Haben alle aktiven Spieler geantwortet? */
export function allAnswered(players, answered) {
  const active = activePlayers(players);
  return active.length > 0 && active.every((p) => answered?.[p.id]);
}

/**
 * Abgaben für den Reveal: alle, die geantwortet haben, plus aktive Spieler ohne Antwort (= Timeout).
 * Weggefallene Spieler ohne Antwort werden übersprungen.
 */
export function revealSubmissions(players, answers) {
  const subs = {};
  for (const [pid, s] of Object.entries(answers || {})) if (s) subs[pid] = s;
  for (const p of activePlayers(players)) if (!subs[p.id]) subs[p.id] = { type: 'timeout' };
  return subs;
}

/** Schlücke pro Spieler aus den Füllungen der Runde: { pid: { q1: 3, q2: 0 } } → { pid: sips } */
/** Exakte Rundenfüllung pro Spieler (Dezimal, gekappt) – gerundet wird erst bei der Anzeige. */
export function sipsByPlayer(fills, cfg = CONFIG) {
  const out = {};
  for (const [pid, f] of Object.entries(fills || {})) out[pid] = roundExact(Object.values(f || {}), cfg);
  return out;
}

/** Getrunkene Schlücke aus der Rundenhistorie (jede Runde gerundet): { r1: { pid: 2.3 }, … } → { pid: total } */
export function totalsFromHistory(history) {
  const out = {};
  for (const round of Object.values(history || {})) {
    for (const [pid, n] of Object.entries(round || {})) out[pid] = (out[pid] || 0) + drinkSips(n);
  }
  return out;
}
