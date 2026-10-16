// Glasklar – Netzwerk-Schicht für den Multiplayer.
// Zwei Backends mit derselben Schnittstelle:
//   - Firebase Realtime Database (wenn js/firebase-config.js ausgefüllt ist)
//   - Lokaler Testmodus: localStorage + BroadcastChannel, mehrere Tabs spielen gegeneinander
//
// Schnittstelle: uid, mode, now(), TS, get, set, update, remove, on, onConnected,
//                onDisconnectUpdate, cancelDisconnect, staleRooms
import { CONFIG } from './config.js';
import { firebaseConfig, isFirebaseConfigured } from './firebase-config.js';
import { store } from './storage.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const HOUR = 3600 * 1000;

let backendPromise = null;

// ?lokal in der URL erzwingt den lokalen Testmodus (auch mit Firebase-Konfiguration)
const forceLocal = () => {
  try { return new URLSearchParams(location.search).has('lokal'); } catch { return false; }
};
const useFirebase = () => isFirebaseConfigured() && !forceLocal();

export function getBackend() {
  if (!backendPromise) {
    backendPromise = (useFirebase() ? firebaseBackend() : Promise.resolve(localBackend()));
    backendPromise.catch(() => { backendPromise = null; });
  }
  return backendPromise;
}

export const backendMode = () => (useFirebase() ? 'firebase' : 'local');

/* ------------------------------------------------------------------ */
/* Firebase                                                            */
/* ------------------------------------------------------------------ */

async function firebaseBackend() {
  const [{ initializeApp }, db, au] = await Promise.all([
    import(`${SDK}firebase-app.js`),
    import(`${SDK}firebase-database.js`),
    import(`${SDK}firebase-auth.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  const database = db.getDatabase(app);
  const auth = au.getAuth(app);
  const cred = await au.signInAnonymously(auth);
  const r = (p) => db.ref(database, p);

  let offset = 0;
  db.onValue(r('.info/serverTimeOffset'), (s) => { offset = s.val() || 0; });

  return {
    mode: 'firebase',
    uid: cred.user.uid,
    now: () => Date.now() + offset,
    TS: db.serverTimestamp(),
    get: async (p) => (await db.get(r(p))).val(),
    set: (p, v) => db.set(r(p), v),
    update: (p, v) => db.update(r(p), v),
    remove: (p) => db.remove(r(p)),
    on: (p, cb) => db.onValue(r(p), (s) => cb(s.val()), (err) => console.warn(`[net] ${p}:`, err.message)),
    onConnected: (cb) => db.onValue(r('.info/connected'), (s) => cb(!!s.val())),
    onDisconnectUpdate: (p, v) => db.onDisconnect(r(p)).update(v),
    cancelDisconnect: (p) => db.onDisconnect(r(p)).cancel(),
    async staleRooms(cutoff) {
      const snap = await db.get(db.query(r('roomsActivity'), db.orderByValue(), db.endAt(cutoff)));
      return Object.keys(snap.val() || {});
    },
  };
}

/* ------------------------------------------------------------------ */
/* Lokaler Testmodus                                                   */
/* ------------------------------------------------------------------ */

const LOCAL_KEY = 'glasklar.localdb';
const TS_SENTINEL = { '.sv': 'timestamp' };

const split = (p) => String(p).split('/').filter(Boolean);
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

function resolveTS(v) {
  if (v && typeof v === 'object') {
    if (v['.sv'] === 'timestamp') return Date.now();
    const out = Array.isArray(v) ? [] : {};
    for (const [k, x] of Object.entries(v)) out[k] = resolveTS(x);
    return out;
  }
  return v;
}

function getAt(tree, path) {
  let cur = tree;
  for (const k of split(path)) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[k];
  }
  return cur === undefined ? null : cur;
}

function setAt(tree, path, value) {
  const keys = split(path);
  if (!keys.length) return value ?? {};
  let cur = tree;
  const trail = [];
  for (const k of keys.slice(0, -1)) {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    trail.push([cur, k]);
    cur = cur[k];
  }
  const last = keys[keys.length - 1];
  if (value === null || value === undefined) delete cur[last];
  else cur[last] = value;
  // leere Objekte wie in Firebase entfernen
  for (let i = trail.length - 1; i >= 0; i--) {
    const [parent, k] = trail[i];
    if (parent[k] && typeof parent[k] === 'object' && !Object.keys(parent[k]).length) delete parent[k];
  }
  return tree;
}

function localBackend() {
  let uid = null;
  try { uid = sessionStorage.getItem('glasklar.localUid'); } catch { /* egal */ }
  if (!uid) {
    uid = `local-${Math.random().toString(36).slice(2, 10)}`;
    try { sessionStorage.setItem('glasklar.localUid', uid); } catch { /* egal */ }
  }
  const chan = 'BroadcastChannel' in window ? new BroadcastChannel('glasklar-localdb') : null;
  const listeners = new Set();
  const disconnectOps = new Map();

  const read = () => {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); } catch { return {}; }
  };
  const notify = () => {
    const tree = read();
    for (const l of listeners) {
      const val = getAt(tree, l.path);
      const s = JSON.stringify(val);
      if (s !== l.last) {
        l.last = s;
        l.cb(clone(val));
      }
    }
  };
  const mutate = (fn) => {
    const tree = read();
    const next = fn(tree) ?? tree;
    localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
    chan?.postMessage('change');
    queueMicrotask(notify);
  };
  if (chan) chan.onmessage = () => notify();
  window.addEventListener('storage', (e) => { if (e.key === LOCAL_KEY) notify(); });
  window.addEventListener('pagehide', () => {
    for (const [p, v] of disconnectOps) mutate((t) => { for (const [k, x] of Object.entries(v)) setAt(t, `${p}/${k}`, resolveTS(x)); });
  });

  return {
    mode: 'local',
    uid,
    now: () => Date.now(),
    TS: TS_SENTINEL,
    get: async (p) => clone(getAt(read(), p)),
    set: async (p, v) => mutate((t) => setAt(t, p, resolveTS(clone(v)))),
    update: async (p, v) => mutate((t) => {
      for (const [k, x] of Object.entries(v)) setAt(t, `${p}/${k}`, resolveTS(clone(x)));
    }),
    remove: async (p) => mutate((t) => setAt(t, p, null)),
    on(p, cb) {
      const l = { path: p, cb, last: undefined };
      listeners.add(l);
      queueMicrotask(notify);
      return () => listeners.delete(l);
    },
    onConnected(cb) { queueMicrotask(() => cb(true)); return () => {}; },
    onDisconnectUpdate: async (p, v) => { disconnectOps.set(p, v); },
    cancelDisconnect: async (p) => { disconnectOps.delete(p); },
    async staleRooms(cutoff) {
      return Object.entries(read().roomsActivity || {}).filter(([, t]) => t < cutoff).map(([c]) => c);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Räume                                                               */
/* ------------------------------------------------------------------ */

export const roomPath = (code) => `rooms/${code}`;

/** Sitzung für Reconnect (Raum + Spieler-ID). Im lokalen Modus pro Tab. */
export const session = {
  key: 'mpSession',
  get() {
    if (backendMode() === 'local') {
      try { return JSON.parse(sessionStorage.getItem('glasklar.mpSession') || 'null'); } catch { return null; }
    }
    return store.get(this.key, null);
  },
  set(v) {
    if (backendMode() === 'local') {
      try { sessionStorage.setItem('glasklar.mpSession', JSON.stringify(v)); } catch { /* egal */ }
    } else store.set(this.key, v);
  },
  clear() {
    if (backendMode() === 'local') {
      try { sessionStorage.removeItem('glasklar.mpSession'); } catch { /* egal */ }
    } else store.remove(this.key);
  },
};

const inactiveCutoff = (be) => be.now() - CONFIG.roomInactiveHours * HOUR - 60 * 1000;

/** Räume, die > 6 Std. inaktiv sind, löschen (beim Erstellen eines neuen Raums). */
async function cleanupStaleRooms(be) {
  try {
    const stale = await be.staleRooms(inactiveCutoff(be));
    for (const code of stale) {
      await be.remove(roomPath(code)).catch(() => {});
      await be.remove(`roomsActivity/${code}`).catch(() => {});
    }
  } catch (e) {
    console.warn('[net] Aufräumen fehlgeschlagen:', e.message);
  }
}

export async function touchRoom(be, code) {
  await be.update(roomPath(code), { 'meta/lastActive': be.TS }).catch(() => {});
  await be.set(`roomsActivity/${code}`, be.TS).catch(() => {});
}

export async function createRoom(be, { name, timer, categories }) {
  await cleanupStaleRooms(be);
  const cutoff = inactiveCutoff(be);
  for (let i = 0; i < 30; i++) {
    const code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const meta = await be.get(`${roomPath(code)}/meta`).catch(() => null);
    if (meta) {
      if ((meta.lastActive ?? 0) >= cutoff) continue; // belegt
      await be.remove(roomPath(code)).catch(() => {});
    }
    await be.set(roomPath(code), {
      meta: {
        code, hostId: be.uid, phase: 'lobby', round: 0, qNum: 0,
        createdAt: be.TS, lastActive: be.TS, timer, categories,
      },
      players: { [be.uid]: { name, joinedAt: be.TS, connected: true } },
    });
    await be.set(`roomsActivity/${code}`, be.TS).catch(() => {});
    return code;
  }
  throw new Error('Kein freier Raumcode gefunden – bitte nochmal versuchen.');
}

/** Raum beitreten (auch Rejoin mit derselben Spieler-ID). */
export async function joinRoom(be, code, name) {
  const meta = await be.get(`${roomPath(code)}/meta`);
  if (!meta) throw new Error(`Raum ${code} gibt es nicht.`);
  if (meta.phase === 'ende') throw new Error('Dieses Spiel ist schon beendet.');
  if ((meta.lastActive ?? 0) < inactiveCutoff(be)) throw new Error('Dieser Raum ist abgelaufen.');
  const me = await be.get(`${roomPath(code)}/players/${be.uid}`).catch(() => null);
  await be.set(`${roomPath(code)}/players/${be.uid}`, {
    name: name || me?.name || 'Gast',
    joinedAt: me?.joinedAt ?? be.TS,
    connected: true,
  });
  await touchRoom(be, code);
  return meta;
}

/** Presence: verbunden setzen, beim Trennen automatisch auf offline. */
export function startPresence(be, code) {
  const p = `${roomPath(code)}/players/${be.uid}`;
  return be.onConnected((connected) => {
    if (!connected) return;
    be.onDisconnectUpdate(p, { connected: false, lastSeen: be.TS });
    be.update(p, { connected: true, left: null }).catch(() => {});
  });
}

export async function leaveRoom(be, code) {
  const p = `${roomPath(code)}/players/${be.uid}`;
  await be.cancelDisconnect(p).catch(() => {});
  await be.update(p, { connected: false, left: true, lastSeen: be.TS }).catch(() => {});
}
