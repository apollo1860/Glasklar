// Glasklar – localStorage mit Präfix und Fehlertoleranz (z. B. privater Modus).
const PREFIX = 'glasklar.';

export const store = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* voll/gesperrt */ }
  },
  remove(key) {
    try { localStorage.removeItem(PREFIX + key); } catch { /* egal */ }
  },
  update(key, fallback, fn) {
    const next = fn(this.get(key, fallback));
    this.set(key, next);
    return next;
  },
};
