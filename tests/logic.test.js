import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, searchKey, levenshtein, buildSearchIndex, searchAnswers,
  baseFill, sameAnswerBonus, computeQuestionFills, roundSips,
  answerFrequencies, rankBySips, roundWinners, drawQuestion,
} from '../js/logic.js';
import { CONFIG } from '../js/config.js';

const Q = {
  id: 'geo-001', text: 'Nenne ein Land der Erde', kategorie: 'geografie',
  answers: [
    { id: 'a1', text: 'Deutschland', aliases: ['BRD', 'Bundesrepublik Deutschland'], tier: 1 },
    { id: 'a2', text: 'Dänemark', aliases: [], tier: 3 },
    { id: 'a3', text: 'Österreich', aliases: [], tier: 2 },
    { id: 'a4', text: 'Vereinigtes Königreich', aliases: ['Großbritannien', 'UK'], tier: 3 },
    { id: 'a5', text: 'Elfenbeinküste', aliases: ["Côte d'Ivoire"], tier: 5 },
    { id: 'a6', text: 'Dominikanische Republik', aliases: [], tier: 4 },
    { id: 'a7', text: 'Dominica', aliases: [], tier: 5 },
    { id: 'a8', text: 'Demokratische Republik Kongo', aliases: [], tier: 5 },
    { id: 'a9', text: 'Djibouti', aliases: [], tier: 5 },
    { id: 'a10', text: 'Dschibuti', aliases: [], tier: 5 },
  ],
};
const IDX = buildSearchIndex(Q);
const ids = (r) => r.map((x) => x.id);

test('Normalisierung: Umlaute, ß, Akzente, Satzzeichen, Artikel', () => {
  assert.equal(normalize('Österreich'), 'oesterreich');
  assert.equal(normalize('Österreich', 'a'), 'osterreich');
  assert.equal(normalize('Großbritannien'), 'grossbritannien');
  assert.equal(normalize("Côte d'Ivoire"), 'cote divoire');
  assert.equal(normalize('Die Ärzte'), 'aerzte');
  assert.equal(normalize('ein  Apfel!'), 'apfel');
  assert.equal(normalize('Eine Banane'), 'banane');
  assert.equal(normalize('Das'), 'das'); // nur Artikel + Leerzeichen wird entfernt
  assert.equal(normalize('Dieter'), 'dieter');
  assert.equal(searchKey('St. Lucia'), 'stlucia');
});

test('Levenshtein', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(levenshtein('', 'ab'), 2);
});

test('Suche: Präfix, ab 1 Zeichen, max 6, alphabetisch', () => {
  const r = searchAnswers(IDX, 'd');
  assert.ok(r.length <= 6);
  const texts = r.map((x) => x.text);
  assert.deepEqual(texts, [...texts].sort((a, b) => a.localeCompare(b, 'de')));
  // Präfix-Treffer haben Vorrang vor Teilstring (z. B. "Vereinigtes Königreich" enthält kein d-Präfix)
  for (const t of texts) assert.ok(normalize(t).startsWith('d') || normalize(t, 'a').startsWith('d'));
});

test('Suche: Umlaute in beiden Schreibweisen', () => {
  assert.deepEqual(ids(searchAnswers(IDX, 'oester')), ['a3']);
  assert.deepEqual(ids(searchAnswers(IDX, 'oster')), ['a3']);
  assert.deepEqual(ids(searchAnswers(IDX, 'Öster')), ['a3']);
  assert.ok(ids(searchAnswers(IDX, 'daene')).includes('a2'));
  assert.ok(ids(searchAnswers(IDX, 'dane')).includes('a2'));
});

test('Suche: Alias-Treffer zeigt Haupttext + Alias, gleiche ID', () => {
  const r = searchAnswers(IDX, 'BRD');
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'a1');
  assert.equal(r[0].text, 'Deutschland');
  assert.equal(r[0].alias, 'BRD');
  const r2 = searchAnswers(IDX, 'gross');
  assert.equal(r2[0].id, 'a4');
  assert.equal(r2[0].alias, 'Großbritannien');
  // Treffer im Haupttext → kein Alias-Hinweis, keine Doppelnennung
  const r3 = searchAnswers(IDX, 'deutsch');
  assert.deepEqual(ids(r3), ['a1']);
  assert.equal(r3[0].alias, null);
});

test('Suche: Teilstring nach Präfix', () => {
  const r = searchAnswers(IDX, 'kongo');
  assert.deepEqual(ids(r), ['a8']);
  const r2 = searchAnswers(IDX, 'reich'); // Österreich, Vereinigtes Königreich
  assert.deepEqual(ids(r2).sort(), ['a3', 'a4']);
});

test('Suche: Tippfehler-Toleranz nur ab 5 Buchstaben, als Vorschlag markiert', () => {
  const r = searchAnswers(IDX, 'Deutchland');
  assert.deepEqual(ids(r), ['a1']);
  assert.equal(r[0].fuzzy, true);
  assert.deepEqual(ids(searchAnswers(IDX, 'Dxutxchland')), []); // Abstand 2
  assert.deepEqual(ids(searchAnswers(IDX, 'Dxu')), []); // zu kurz für Fuzzy
  const r2 = searchAnswers(IDX, 'Dschbuti');
  assert.ok(ids(r2).includes('a10'));
});

test('Suche: leere Eingabe und Artikel', () => {
  assert.deepEqual(searchAnswers(IDX, ''), []);
  assert.deepEqual(searchAnswers(IDX, '   '), []);
  assert.deepEqual(ids(searchAnswers(IDX, 'das Österreich')), ['a3']);
});

test('Bewertung: tier-Werte, Nichts passt, Timeout', () => {
  assert.equal(baseFill({ type: 'answer', answerId: 'a1' }, Q), 3);
  assert.equal(baseFill({ type: 'answer', answerId: 'a3' }, Q), 2);
  assert.equal(baseFill({ type: 'answer', answerId: 'a2' }, Q), 1);
  assert.equal(baseFill({ type: 'answer', answerId: 'a6' }, Q), 0);
  assert.equal(baseFill({ type: 'answer', answerId: 'a7' }, Q), 0);
  assert.equal(baseFill({ type: 'nothing' }, Q), 3);
  assert.equal(baseFill({ type: 'timeout' }, Q), 3);
  assert.equal(baseFill(null, Q), 3);
});

test('Bewertung: Cap bei 10 Schlücken', () => {
  assert.equal(roundSips([3, 3, 3]), 9);
  assert.equal(roundSips([5, 5, 5]), 10);
  assert.equal(roundSips([0, 0, 1]), 1);
  assert.equal(roundSips([3, 5, 4]), CONFIG.maxSipsPerRound);
});

test('Bewertung: Gleiche-Antwort-Aufschlag max +2, nur Multiplayer', () => {
  assert.equal(sameAnswerBonus(1), 0);
  assert.equal(sameAnswerBonus(2), 1);
  assert.equal(sameAnswerBonus(3), 2);
  assert.equal(sameAnswerBonus(7), 2);
  const subs = {
    p1: { type: 'answer', answerId: 'a7' },
    p2: { type: 'answer', answerId: 'a7' },
    p3: { type: 'answer', answerId: 'a7' },
    p4: { type: 'answer', answerId: 'a7' },
    p5: { type: 'nothing' },
    p6: { type: 'nothing' },
  };
  const mp = computeQuestionFills(subs, Q, { multiplayer: true });
  assert.deepEqual(mp.p1, { base: 0, bonus: 2, fill: 2 });
  assert.deepEqual(mp.p5, { base: 3, bonus: 0, fill: 3 }); // "Nichts passt" zählt nicht als gleiche Antwort
  const sp = computeQuestionFills({ me: { type: 'answer', answerId: 'a1' } }, Q, { multiplayer: false });
  assert.deepEqual(sp.me, { base: 3, bonus: 0, fill: 3 });
});

test('Reveal-Häufigkeiten ohne tier', () => {
  const f = answerFrequencies({
    p1: { type: 'answer', answerId: 'a1' },
    p2: { type: 'answer', answerId: 'a1' },
    p3: { type: 'nothing' },
  }, Q);
  assert.equal(f[0].label, 'Deutschland');
  assert.equal(f[0].count, 2);
  assert.equal(f[1].label, 'Nichts passt');
  assert.ok(!('tier' in f[0]));
});

test('Ranking und Rundensieger', () => {
  const r = rankBySips({ anton: 7, berta: 2, carl: 2 });
  assert.deepEqual(r.map((x) => [x.id, x.rank]), [['berta', 1], ['carl', 1], ['anton', 3]]);
  assert.deepEqual(roundWinners({ anton: 7, berta: 2, carl: 2 }).sort(), ['berta', 'carl']);
});

test('Ziehen ohne Wiederholung, Reset bei leerem Pool, Kategorie-Wechsel', () => {
  const catalog = [
    { id: 'g1', kategorie: 'geo' }, { id: 'g2', kategorie: 'geo' },
    { id: 'e1', kategorie: 'essen' }, { id: 't1', kategorie: 'tiere' },
  ];
  const played = new Set();
  const seen = [];
  let last = null;
  for (let i = 0; i < 4; i++) {
    const d = drawQuestion({ catalog, enabled: ['geo', 'essen', 'tiere'], played, lastCategory: last });
    assert.equal(d.reset, false);
    assert.ok(!played.has(d.id));
    played.add(d.id);
    seen.push(d.id);
    last = d.kategorie;
  }
  assert.equal(new Set(seen).size, 4);
  const d = drawQuestion({ catalog, enabled: ['geo', 'essen', 'tiere'], played });
  assert.equal(d.reset, true);

  // Nie zwei gleiche Kategorien hintereinander, wenn vermeidbar
  for (let i = 0; i < 50; i++) {
    const x = drawQuestion({ catalog, enabled: ['geo', 'essen'], played: new Set(), lastCategory: 'geo' });
    assert.equal(x.kategorie, 'essen');
  }
  // Abgewählte Kategorien werden nie gezogen
  for (let i = 0; i < 50; i++) {
    const x = drawQuestion({ catalog, enabled: ['tiere'], played: new Set() });
    assert.equal(x.id, 't1');
  }
  // exclude (aktuelle Runde) wird auch nach Reset gemieden
  const x = drawQuestion({ catalog, enabled: ['geo'], played: new Set(['g1', 'g2']), exclude: new Set(['g1']) });
  assert.equal(x.reset, true);
  assert.equal(x.id, 'g2');
  assert.equal(drawQuestion({ catalog, enabled: [], played }), null);
});
