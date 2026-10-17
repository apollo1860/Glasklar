#!/usr/bin/env node
// Prüft data/index.json und alle Kategorie-Dateien. Exit-Code 1 bei Fehlern.
//   node tools/validate.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchKey, buildSearchIndex, searchAnswers } from '../js/logic.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

// Mindestwerte je Fragetyp
const RULES = {
  normal: { answers: 60, tier12: 8, tier45: 3 },
  geschlossen: { answers: 5, tier12: 1, tier45: 0 }, // kleine, vollständige Menge
  rangliste: { answers: 5, tier12: 1, tier45: 1 }, // tier = Rang, Platz 1 hat tier 4/5
};

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

let index;
try {
  index = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
} catch (e) {
  console.error(`data/index.json nicht lesbar: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(index.categories)) err('index.json: "categories" fehlt');

const questionIds = new Set();
const answerIds = new Set();
const rows = [];

for (const cat of index.categories || []) {
  const file = path.join(DATA, `${cat.id}.json`);
  let questions;
  try {
    questions = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    err(`${cat.id}.json nicht lesbar: ${e.message}`);
    continue;
  }
  if (!Array.isArray(questions)) { err(`${cat.id}.json: kein Array`); continue; }
  if (cat.count !== questions.length) err(`index.json: ${cat.id}.count=${cat.count}, Datei hat ${questions.length}`);
  const listed = new Set(cat.questions || []);
  const inFile = new Set(questions.map((q) => q.id));
  for (const id of listed) if (!inFile.has(id)) err(`index.json: ${id} fehlt in ${cat.id}.json`);
  for (const id of inFile) if (!listed.has(id)) err(`index.json: ${id} aus ${cat.id}.json nicht gelistet`);

  for (const q of questions) {
    const where = `${cat.id}.json/${q.id ?? '?'}`;
    if (!isStr(q.id)) err(`${where}: id fehlt`);
    if (!isStr(q.text)) err(`${where}: text fehlt`);
    if (q.kategorie !== cat.id) err(`${where}: kategorie "${q.kategorie}" ≠ "${cat.id}"`);
    if (questionIds.has(q.id)) err(`${where}: Frage-ID doppelt`);
    questionIds.add(q.id);
    if (!Array.isArray(q.answers)) { err(`${where}: answers fehlt`); continue; }

    const tiers = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const keysPrimary = new Map(); // key -> Beschreibung
    const keysAlt = new Map();

    for (const a of q.answers) {
      const aw = `${where}/${a.id ?? '?'}`;
      if (!isStr(a.id)) err(`${aw}: id fehlt`);
      else if (!a.id.startsWith(`${q.id}-a`)) err(`${aw}: Antwort-ID muss mit "${q.id}-a" beginnen`);
      if (answerIds.has(a.id)) err(`${aw}: Antwort-ID doppelt`);
      answerIds.add(a.id);
      if (!isStr(a.text)) err(`${aw}: text fehlt`);
      if (!Array.isArray(a.aliases)) err(`${aw}: aliases muss ein Array sein`);
      if (![1, 2, 3, 4, 5].includes(a.tier)) err(`${aw}: tier ${a.tier} ungültig (nur 1–5)`);
      else tiers[a.tier]++;

      for (const label of [a.text, ...(a.aliases || [])]) {
        if (!isStr(label)) { err(`${aw}: leerer Alias`); continue; }
        const k = searchKey(label, 'ae');
        if (!k) { err(`${aw}: "${label}" ist nach Normalisierung leer`); continue; }
        const desc = `"${label}" (${a.text})`;
        if (keysPrimary.has(k)) err(`${where}: doppelt nach Normalisierung: ${desc} ↔ ${keysPrimary.get(k)}`);
        else keysPrimary.set(k, desc);
        const k2 = searchKey(label, 'a');
        if (k2 !== k) {
          if (keysAlt.has(k2) && keysAlt.get(k2) !== desc) warn(`${where}: ähnlich ohne Umlaut: ${desc} ↔ ${keysAlt.get(k2)}`);
          keysAlt.set(k2, desc);
        }
        keysAlt.set(k, keysAlt.get(k) ?? desc);
      }
    }

    // Selbsttest: Jede Antwort und jeder Alias muss beim Eintippen genau sich selbst als exakten Treffer liefern
    const sIndex = buildSearchIndex(q);
    for (const a of q.answers) {
      for (const label of [a.text, ...(a.aliases || [])]) {
        if (!isStr(label)) continue;
        const hits = searchAnswers(sIndex, label);
        if (!hits.some((h) => h.id === a.id && !h.fuzzy)) {
          err(`${where}: "${label}" findet beim Eintippen nicht "${a.text}" (Treffer: ${hits.map((h) => h.text).join(', ') || 'keine'})`);
        } else if (hits.length > 1) {
          warn(`${where}: "${label}" zeigt mehrere Treffer: ${hits.map((h) => h.text).join(', ')}`);
        }
      }
    }

    const n = q.answers.length;
    const t12 = tiers[1] + tiers[2];
    const t45 = tiers[4] + tiers[5];
    const typ = q.typ || 'normal';
    const rule = RULES[typ];
    if (!rule) { err(`${where}: unbekannter typ "${typ}"`); continue; }
    if (n < rule.answers) err(`${where}: nur ${n} Antworten (min. ${rule.answers} für ${typ})`);
    if (t12 < rule.tier12) err(`${where}: nur ${t12} Antworten in tier 1–2 (min. ${rule.tier12})`);
    if (t45 < rule.tier45) err(`${where}: nur ${t45} Antworten in tier 4–5 (min. ${rule.tier45})`);
    if (typ === 'rangliste' && !isStr(q.loesung)) err(`${where}: rangliste braucht @loesung`);
    if (typ === 'normal' && tiers[1] === 0) warn(`${where}: keine tier-1-Antwort`);
    if (typ === 'geschlossen' && n >= 60) warn(`${where}: ${n} Antworten – braucht es typ geschlossen?`);
    rows.push({ id: q.id, kat: cat.id, n, ...tiers, text: q.text, typ });
  }
}

// Tabelle
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);
console.log(`${pad('Frage', 9)} ${pad('Kategorie', 10)} ${pad('Typ', 5)} ${padL('Anz', 4)} ${padL('t1', 4)} ${padL('t2', 4)} ${padL('t3', 4)} ${padL('t4', 4)} ${padL('t5', 4)}  Text`);
console.log('-'.repeat(100));
for (const r of rows) {
  console.log(`${pad(r.id, 9)} ${pad(r.kat, 10)} ${pad(r.typ === 'normal' ? '' : r.typ.slice(0, 5), 5)} ${padL(r.n, 4)} ${padL(r[1], 4)} ${padL(r[2], 4)} ${padL(r[3], 4)} ${padL(r[4], 4)} ${padL(r[5], 4)}  ${r.text}`);
}
console.log('-'.repeat(100));
const sum = rows.reduce((s, r) => s + r.n, 0);
console.log(`${rows.length} Fragen, ${sum} Antworten\n`);

for (const w of warnings) console.log(`⚠  ${w}`);
for (const e of errors) console.log(`✖  ${e}`);
if (errors.length) {
  console.log(`\n${errors.length} Fehler, ${warnings.length} Warnungen`);
  process.exit(1);
}
console.log(`✔ OK (${warnings.length} Warnungen)`);
