import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, searchKey, levenshtein, buildSearchIndex, searchAnswers, stem,
  baseFill, sameAnswerBonus, computeQuestionFills, roundSips,
  answerFrequencies, rankBySips, roundWinners, drawQuestion,
} from '../js/logic.js';
import { CONFIG } from '../js/config.js';

const Q = {
  id: 'geo-002', text: 'Nenne ein Land', kategorie: 'geografie', typ: 'geschlossen', // strenge Suche
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

test('Levenshtein inkl. vertauschter Buchstaben', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(levenshtein('', 'ab'), 2);
  assert.equal(levenshtein('deutshcland', 'deutschland'), 1);
});

test('Suche: keine Vorschläge für Anfangsbuchstaben oder Wortteile', () => {
  assert.deepEqual(searchAnswers(IDX, 'd'), []);
  assert.deepEqual(searchAnswers(IDX, 'De'), []);
  assert.deepEqual(searchAnswers(IDX, 'Deutsch'), []); // Wortanfang reicht nicht
  assert.deepEqual(searchAnswers(IDX, 'Deutschl'), []);
  assert.deepEqual(searchAnswers(IDX, 'reich'), []); // Teilstring reicht nicht
  assert.deepEqual(searchAnswers(IDX, 'kongo'), []);
});

test('Suche: ganzes Wort wird gefunden', () => {
  const r = searchAnswers(IDX, 'Deutschland');
  assert.deepEqual(ids(r), ['a1']);
  assert.equal(r[0].fuzzy, false);
  assert.equal(r[0].alias, null);
  assert.deepEqual(ids(searchAnswers(IDX, 'dominikanische republik')), ['a6']);
  assert.deepEqual(ids(searchAnswers(IDX, 'Dominikanische-Republik')), ['a6']);
});

test('Suche: Umlaute in beiden Schreibweisen', () => {
  assert.deepEqual(ids(searchAnswers(IDX, 'Österreich')), ['a3']);
  assert.deepEqual(ids(searchAnswers(IDX, 'Oesterreich')), ['a3']);
  assert.deepEqual(ids(searchAnswers(IDX, 'osterreich')), ['a3']);
  assert.deepEqual(ids(searchAnswers(IDX, 'daenemark')), ['a2']);
  assert.deepEqual(ids(searchAnswers(IDX, 'Danemark')), ['a2']);
  assert.equal(searchAnswers(IDX, 'Danemark')[0].fuzzy, false);
});

test('Suche: Alias-Treffer zeigt Haupttext + Alias, gleiche ID', () => {
  const r = searchAnswers(IDX, 'BRD');
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'a1');
  assert.equal(r[0].text, 'Deutschland');
  assert.equal(r[0].alias, 'BRD');
  const r2 = searchAnswers(IDX, 'grossbritannien');
  assert.deepEqual(ids(r2), ['a4']);
  assert.equal(r2[0].alias, 'Großbritannien');
  assert.deepEqual(ids(searchAnswers(IDX, "cote d'ivoire")), ['a5']);
});

test('Suche: Tippfehler nur bei ganzem Wort ab 5 Buchstaben, als Vorschlag markiert', () => {
  const r = searchAnswers(IDX, 'Deutchland');
  assert.deepEqual(ids(r), ['a1']);
  assert.equal(r[0].fuzzy, true);
  assert.deepEqual(ids(searchAnswers(IDX, 'Deutshcland')), ['a1']); // vertauscht
  assert.deepEqual(ids(searchAnswers(IDX, 'Deutschlandd')), ['a1']);
  assert.deepEqual(searchAnswers(IDX, 'Dxutxchland'), []); // Abstand 2
  assert.deepEqual(searchAnswers(IDX, 'Deutc'), []); // kein Wortanfang-Fuzzy
  assert.deepEqual(searchAnswers(IDX, 'UX'), []); // zu kurz für Tippfehler
  assert.deepEqual(ids(searchAnswers(IDX, 'Dschbuti')), ['a10']);
});

const OPEN = buildSearchIndex({
  id: 'all-004', text: 'Nenne etwas, das man in einem Badezimmer findet', kategorie: 'alltag',
  answers: [
    { id: 'b1', text: 'Zahnbürste', aliases: [], tier: 1 },
    { id: 'b2', text: 'Handtuch', aliases: [], tier: 1 },
    { id: 'b3', text: 'Spiegel', aliases: [], tier: 1 },
    { id: 'b4', text: 'Kerze', aliases: [], tier: 3 },
    { id: 'b5', text: 'Badewanne', aliases: [], tier: 2 },
    { id: 'b6', text: 'Duschgel', aliases: [], tier: 2 },
  ],
});

test('Suche offene Fragen: Plural/Grundform, mehr Tippfehler, Wortteile', () => {
  assert.equal(OPEN.tolerant, true);
  assert.equal(IDX.tolerant, false);
  assert.equal(stem('kerzen'), 'kerz');
  const pl = searchAnswers(OPEN, 'Handtücher');
  assert.deepEqual(ids(pl), ['b2']);
  assert.equal(pl[0].fuzzy, false); // Plural gilt als Treffer
  assert.deepEqual(ids(searchAnswers(OPEN, 'Kerzen')), ['b4']);
  assert.deepEqual(ids(searchAnswers(OPEN, 'Kerz')), ['b4']); // 4 Buchstaben, 1 Fehler
  assert.deepEqual(ids(searchAnswers(OPEN, 'Zahnbrüste')), ['b1']); // vertauscht
  assert.deepEqual(ids(searchAnswers(OPEN, 'Zanbürstte')), ['b1']); // 2 Fehler ab 8 Buchstaben
  const part = searchAnswers(OPEN, 'Badezimmerspiegel');
  assert.deepEqual(ids(part), ['b3']);
  assert.equal(part[0].fuzzy, true);
  assert.deepEqual(ids(searchAnswers(OPEN, 'elektrische Zahnbürste')), ['b1']);
  assert.deepEqual(ids(searchAnswers(OPEN, 'Bürste')), ['b1']); // 6 von 10 Buchstaben
  assert.deepEqual(ids(searchAnswers(OPEN, 'Badewannenrand')), ['b5']); // 9 von 14 Buchstaben
  // Anfangsbuchstaben und kurze Teile zeigen weiterhin nichts
  assert.deepEqual(searchAnswers(OPEN, 'Z'), []);
  assert.deepEqual(searchAnswers(OPEN, 'Zahn'), []);
  assert.deepEqual(searchAnswers(OPEN, 'Bade'), []);
  assert.deepEqual(searchAnswers(OPEN, 'gel'), []);
});

test('Suche: exakter Treffer verdrängt Tippfehler-Vorschläge', () => {
  // "Dschibuti" ist exakt; "Djibouti" wäre nicht ähnlich genug, aber Prinzip: nur exakte zeigen
  const r = searchAnswers(IDX, 'Dschibuti');
  assert.deepEqual(ids(r), ['a10']);
  assert.equal(r[0].fuzzy, false);
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

test('Multiplayer: Host-Wahl – ältester verbundener Spieler übernimmt', async () => {
  const { electHost, activePlayers } = await import('../js/logic.js');
  const players = {
    host: { name: 'H', joinedAt: 1, connected: false },
    b: { name: 'B', joinedAt: 3, connected: true },
    a: { name: 'A', joinedAt: 2, connected: true },
    gone: { name: 'G', joinedAt: 0, connected: true, left: true },
  };
  assert.deepEqual(activePlayers(players).map((p) => p.id), ['a', 'b']);
  assert.equal(electHost('host', players), 'a');
  assert.equal(electHost('b', players), 'b'); // verbundener Host bleibt
  players.host.connected = true;
  assert.equal(electHost('host', players), 'host');
  assert.equal(electHost('x', {}), 'x');
});

test('Multiplayer: alle geantwortet, Reveal-Abgaben, Schlücke und Gesamtsumme', async () => {
  const { allAnswered, revealSubmissions, sipsByPlayer, totalsFromHistory } = await import('../js/logic.js');
  const players = {
    a: { joinedAt: 1, connected: true },
    b: { joinedAt: 2, connected: true },
    c: { joinedAt: 3, connected: false },
  };
  assert.equal(allAnswered(players, { a: true }), false);
  assert.equal(allAnswered(players, { a: true, b: true }), true); // c ist weg
  const subs = revealSubmissions(players, { a: { type: 'answer', answerId: 'a1' }, c: { type: 'nothing' } });
  assert.deepEqual(subs, { a: { type: 'answer', answerId: 'a1' }, c: { type: 'nothing' }, b: { type: 'timeout' } });
  assert.deepEqual(sipsByPlayer({ a: { q1: 3, q2: 5, q3: 4 }, b: { q1: 0, q2: 1 } }), { a: 10, b: 1 });
  assert.deepEqual(totalsFromHistory({ r1: { a: 4, b: 2 }, r2: { a: 1, b: 7 } }), { a: 5, b: 9 });
});

test('Ranglisten: kein Gleiche-Antwort-Aufschlag', () => {
  const R = { ...Q, typ: 'rangliste' };
  const f = computeQuestionFills({ a: { type: 'answer', answerId: 'a7' }, b: { type: 'answer', answerId: 'a7' } }, R, { multiplayer: true });
  assert.deepEqual(f.a, { base: 0, bonus: 0, fill: 0 });
});
