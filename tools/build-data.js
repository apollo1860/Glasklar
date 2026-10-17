#!/usr/bin/env node
// Baut data/{kategorie}.json und data/index.json aus den Quelldateien in data-src/.
//
// Quellformat (eine Datei pro Frage, data-src/{kategorie}/{frage-id}.txt):
//   @id geo-001
//   @text Nenne ein Land der Erde
//   # Kommentar
//   1 Deutschland = BRD; Bundesrepublik Deutschland
//   3 Dänemark
// Zeile: tier, Leerzeichen, Antworttext, optional " = " und Aliase getrennt mit ";".
//
// Optionale Kopfzeilen:
//   @typ geschlossen   kleine, vollständig aufzählbare Menge (z. B. Länder in Ostasien)
//   @typ rangliste     tier ergibt sich aus dem Rang statt aus der Bekanntheit
//   @loesung …         wird nach dem Reveal angezeigt (Pflicht bei rangliste)
//   @quelle …          Datenquelle (nur Dokumentation)
//
// Antwort-IDs bleiben stabil: Bestehende IDs aus data/*.json werden über den
// normalisierten Antworttext wiederverwendet, neue Antworten bekommen die nächste freie Nummer.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchKey } from '../js/logic.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data-src');
const OUT = path.join(ROOT, 'data');

const categories = JSON.parse(fs.readFileSync(path.join(SRC, 'categories.json'), 'utf8'));

function parseSource(file, kategorie) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const q = { id: null, text: null, kategorie, answers: [] };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('@')) {
      const m = line.match(/^@(\w+)\s+(.+)$/);
      if (!m) throw new Error(`${file}:${i + 1}: ungültige Kopfzeile`);
      q[m[1]] = m[2].trim();
      return;
    }
    const m = line.match(/^([1-5])\s+(.+)$/);
    if (!m) throw new Error(`${file}:${i + 1}: erwartet "tier Text = Alias; Alias"`);
    const [main, aliasPart] = m[2].split(/\s+=\s+/);
    const aliases = aliasPart ? aliasPart.split(';').map((s) => s.trim()).filter(Boolean) : [];
    q.answers.push({ text: main.trim(), aliases, tier: Number(m[1]) });
  });
  if (!q.id || !q.text) throw new Error(`${file}: @id und @text fehlen`);
  return q;
}

function existingIds(kategorie) {
  const file = path.join(OUT, `${kategorie}.json`);
  const map = new Map(); // frage-id -> Map(key -> antwort-id)
  if (!fs.existsSync(file)) return map;
  for (const q of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    map.set(q.id, new Map(q.answers.map((a) => [searchKey(a.text), a.id])));
  }
  return map;
}

const index = { version: 1, generated: new Date().toISOString().slice(0, 10), categories: [] };
let total = 0;

for (const cat of categories) {
  const dir = path.join(SRC, cat.id);
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
  if (!files.length) continue;
  const old = existingIds(cat.id);
  const questions = files.map((f) => {
    const q = parseSource(path.join(dir, f), cat.id);
    const prev = old.get(q.id) || new Map();
    let next = Math.max(0, ...[...prev.values()].map((id) => Number(id.split('-a')[1]) || 0)) + 1;
    q.answers = q.answers.map((a) => {
      const id = prev.get(searchKey(a.text)) || `${q.id}-a${String(next++).padStart(4, '0')}`;
      return { id, text: a.text, aliases: a.aliases, tier: a.tier };
    });
    const out = { id: q.id, text: q.text, kategorie: q.kategorie };
    if (q.typ && q.typ !== 'normal') out.typ = q.typ;
    if (q.loesung) out.loesung = q.loesung;
    if (q.quelle) out.quelle = q.quelle;
    out.answers = q.answers;
    return out;
  });
  const json = JSON.stringify(questions, null, 1) + '\n';
  fs.writeFileSync(path.join(OUT, `${cat.id}.json`), json);
  // Inhalts-Hash als Version: Browser laden nach jeder Datenänderung frisch statt aus dem Cache
  const v = crypto.createHash('sha1').update(json).digest('hex').slice(0, 10);
  index.categories.push({
    id: cat.id, name: cat.name, icon: cat.icon, count: questions.length, v,
    questions: questions.map((q) => q.id),
  });
  total += questions.length;
  console.log(`${cat.id}: ${questions.length} Fragen`);
}

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`index.json: ${total} Fragen in ${index.categories.length} Kategorien`);
