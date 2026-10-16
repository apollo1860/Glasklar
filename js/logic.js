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
/* Levenshtein                                                         */
/* ------------------------------------------------------------------ */

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Tippfehler-Treffer: ganzes Wort oder Wortanfang mit Abstand <= maxDist. */
function fuzzyMatch(q, key, maxDist) {
  if (Math.abs(key.length - q.length) <= maxDist && levenshtein(q, key) <= maxDist) return true;
  for (let len = q.length - maxDist; len <= q.length + maxDist; len++) {
    if (len < 1 || len >= key.length) continue;
    if (levenshtein(q, key.slice(0, len)) <= maxDist) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Suche                                                               */
/* ------------------------------------------------------------------ */

/** Baut den Suchindex einer Frage (einmal pro Frage). */
export function buildSearchIndex(question) {
  return question.answers.map((answer) => ({
    answer,
    keys: [
      { label: answer.text, isAlias: false, forms: keyForms(answer.text) },
      ...(answer.aliases || []).map((al) => ({ label: al, isAlias: true, forms: keyForms(al) })),
    ],
  }));
}

const RANK_EXACT = 0;
const RANK_PREFIX = 1;
const RANK_SUBSTRING = 2;
const RANK_FUZZY = 3;

const collator = typeof Intl !== 'undefined' ? new Intl.Collator('de', { sensitivity: 'base' }) : null;
export const compareDe = (a, b) => (collator ? collator.compare(a, b) : a < b ? -1 : a > b ? 1 : 0);

/**
 * Sucht in Antworttext und Aliasen.
 * Ergebnis: max. N Treffer, alphabetisch nach Haupttext:
 *   { id, text, alias: string|null, fuzzy: boolean }
 * Ausgewählt wird nach Güte (exakt > Präfix > Teilstring > Tippfehler), angezeigt alphabetisch.
 * tier wird weder zum Sortieren benutzt noch zurückgegeben.
 */
export function searchAnswers(index, query, opts = {}) {
  const max = opts.maxResults ?? CONFIG.search.maxResults;
  const fuzzyMin = opts.fuzzyMinLength ?? CONFIG.search.fuzzyMinLength;
  const fuzzyDist = opts.fuzzyMaxDistance ?? CONFIG.search.fuzzyMaxDistance;
  const qForms = keyForms(query).filter(Boolean);
  if (!qForms.length) return [];

  const hits = [];
  for (const entry of index) {
    let best = null; // { rank, key }
    for (const key of entry.keys) {
      let rank = Infinity;
      for (const q of qForms) {
        for (const f of key.forms) {
          let r = Infinity;
          if (f === q) r = RANK_EXACT;
          else if (f.startsWith(q)) r = RANK_PREFIX;
          else if (f.includes(q)) r = RANK_SUBSTRING;
          else if (q.length >= fuzzyMin && fuzzyMatch(q, f, fuzzyDist)) r = RANK_FUZZY;
          if (r < rank) rank = r;
        }
      }
      // Bei gleicher Güte gewinnt der Haupttext gegenüber einem Alias
      if (rank !== Infinity && (!best || rank < best.rank)) best = { rank, key };
    }
    if (best) hits.push({ entry, ...best });
  }

  hits.sort((a, b) => a.rank - b.rank || compareDe(a.entry.answer.text, b.entry.answer.text));
  return hits
    .slice(0, max)
    .map((h) => ({
      id: h.entry.answer.id,
      text: h.entry.answer.text,
      alias: h.key.isAlias ? h.key.label : null,
      fuzzy: h.rank === RANK_FUZZY,
    }))
    .sort((a, b) => compareDe(a.text, b.text));
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
  if (multiplayer) {
    for (const s of Object.values(submissions)) {
      if (s && s.type === 'answer') counts.set(s.answerId, (counts.get(s.answerId) || 0) + 1);
    }
  }
  const out = {};
  for (const [pid, s] of Object.entries(submissions)) {
    const base = baseFill(s, question, cfg);
    const bonus = multiplayer && s && s.type === 'answer' ? sameAnswerBonus(counts.get(s.answerId), cfg) : 0;
    out[pid] = { base, bonus, fill: base + bonus };
  }
  return out;
}

/** Schlücke einer Runde = Summe der Füllungen, gekappt. */
export function roundSips(fills, cfg = CONFIG) {
  const sum = fills.reduce((acc, f) => acc + (Number(f) || 0), 0);
  return Math.min(sum, cfg.maxSipsPerRound);
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
