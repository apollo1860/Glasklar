// Glasklar – Fragen laden. index.json sofort, Kategorien lazy beim ersten Bedarf.
import { buildSearchIndex, catalogFromIndex } from './logic.js';

let indexPromise = null;
const categoryPromises = new Map();
const searchIndexes = new Map();

export function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetch('data/index.json', { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`index.json: HTTP ${r.status}`);
      return r.json();
    });
    indexPromise.catch(() => { indexPromise = null; });
  }
  return indexPromise;
}

export async function getCatalog() {
  return catalogFromIndex(await loadIndex());
}

export function loadCategory(id) {
  if (!categoryPromises.has(id)) {
    const p = loadIndex().then((index) => {
      const v = index.categories.find((c) => c.id === id)?.v ?? index.generated ?? '';
      return fetch(`data/${encodeURIComponent(id)}.json?v=${encodeURIComponent(v)}`);
    }).then((r) => {
      if (!r.ok) throw new Error(`${id}.json: HTTP ${r.status}`);
      return r.json();
    }).then((list) => new Map(list.map((q) => [q.id, q])));
    p.catch(() => categoryPromises.delete(id));
    categoryPromises.set(id, p);
  }
  return categoryPromises.get(id);
}

export async function getQuestion(id, kategorie) {
  const map = await loadCategory(kategorie);
  const q = map.get(id);
  if (!q) throw new Error(`Frage ${id} nicht gefunden`);
  return q;
}

export function getSearchIndex(question) {
  if (!searchIndexes.has(question.id)) searchIndexes.set(question.id, buildSearchIndex(question));
  return searchIndexes.get(question.id);
}

export async function categoryMeta(id) {
  const index = await loadIndex();
  return index.categories.find((c) => c.id === id);
}
