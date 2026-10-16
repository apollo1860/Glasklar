// Glasklar – DOM-Helfer, Bildschirme, Modals und die Antwort-Eingabe.
import { searchAnswers, searchKey } from './logic.js';
import { store } from './storage.js';
import { sfx } from './audio.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const sipsLabel = (n) => `${n} ${n === 1 ? 'Schluck' : 'Schlücke'}`;

/* ------------------------------------------------------------------ */
/* Bildschirme & Viewport                                              */
/* ------------------------------------------------------------------ */

export function showScreen(id) {
  for (const s of $$('.screen')) {
    const on = s.id === `screen-${id}`;
    s.classList.toggle('active', on);
    s.toggleAttribute('hidden', !on);
  }
  document.body.dataset.screen = id;
  window.scrollTo(0, 0);
}

/** Hält die App über der Bildschirmtastatur (visualViewport). */
export function initViewport() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const sync = () => {
    const h = vv ? vv.height : window.innerHeight;
    root.style.setProperty('--app-h', `${h}px`);
    root.style.setProperty('--vv-top', `${vv ? vv.offsetTop : 0}px`);
    document.body.classList.toggle('kb-open', !!vv && h < window.innerHeight * 0.78);
    window.dispatchEvent(new CustomEvent('glasklar:viewport'));
  };
  sync();
  vv?.addEventListener('resize', sync);
  vv?.addEventListener('scroll', sync);
  window.addEventListener('resize', sync);
}

/* ------------------------------------------------------------------ */
/* Toast & Modal                                                       */
/* ------------------------------------------------------------------ */

export function toast(msg, ms = 2200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, ms);
}

/**
 * Modal mit Buttons. buttons: [{ label, value, kind }]
 * Liefert den value des gedrückten Buttons.
 */
export function modal({ title, html, buttons = [{ label: 'OK', value: true, kind: 'primary' }], dismissable = true }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">${esc(title)}</h2>
        <div class="modal-body">${html}</div>
        <div class="modal-actions">
          ${buttons.map((b, i) => `<button class="btn btn-${b.kind || 'secondary'}" data-i="${i}">${esc(b.label)}</button>`).join('')}
        </div>
      </div>`;
    const close = (v) => {
      back.classList.add('closing');
      setTimeout(() => back.remove(), 250);
      resolve(v);
    };
    back.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-i]');
      if (btn) close(buttons[Number(btn.dataset.i)].value);
      else if (dismissable && e.target === back) close(undefined);
    });
    document.body.appendChild(back);
    back.querySelector('.btn-primary, button')?.focus({ preventScroll: true });
  });
}

/* ------------------------------------------------------------------ */
/* Fehlende-Antworten-Log                                              */
/* ------------------------------------------------------------------ */

export const missingLog = {
  add(question, text, type) {
    const clean = String(text || '').trim();
    if (type === 'nohit' && !clean) return;
    store.update('missing', [], (list) => {
      const key = searchKey(clean);
      const dup = list.some((e) => e.questionId === question.id && e.type === type && searchKey(e.text) === key);
      if (!dup) list.push({ questionId: question.id, question: question.text, text: clean, type, ts: new Date().toISOString() });
      return list.slice(-2000);
    });
  },
  all: () => store.get('missing', []),
  clear: () => store.set('missing', []),
  export() {
    const data = { app: 'glasklar', exported: new Date().toISOString(), entries: this.all() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `glasklar-fehlende-antworten-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  },
};

/* ------------------------------------------------------------------ */
/* Antwort-Eingabe mit Dropdown                                        */
/* ------------------------------------------------------------------ */

export class AnswerInput {
  constructor({ root, onSubmit }) {
    this.root = root;
    this.input = $('.answer-input', root);
    this.list = $('.suggestions', root);
    this.submitBtn = $('[data-act="submit"]', root);
    this.nothingBtn = $('[data-act="nothing"]', root);
    this.clearBtn = $('.input-clear', root);
    this.status = $('.answer-status', root);
    this.onSubmit = onSubmit;
    this.question = null;
    this.index = null;
    this.selected = null;
    this.results = [];
    this.active = -1;
    this.locked = true;
    this.noHitTimer = null;

    this.input.addEventListener('input', () => this.onInput());
    this.input.addEventListener('focus', () => { if (this.input.value && !this.selected && this.results.length) this.render(); });
    this.input.addEventListener('blur', () => {
      setTimeout(() => this.close(), 120);
      this.flushNoHit();
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    // pointerdown statt click: Fokus bleibt im Feld, Tastatur klappt nicht weg
    this.list.addEventListener('pointerdown', (e) => {
      const li = e.target.closest('li[data-id]');
      if (!li) return;
      e.preventDefault();
      this.choose(li.dataset.id);
    });
    this.clearBtn.addEventListener('click', () => {
      this.input.value = '';
      this.deselect();
      this.close();
      this.input.focus();
    });
    this.submitBtn.addEventListener('click', () => {
      if (this.locked || !this.selected) return;
      this.submit({ type: 'answer', answerId: this.selected.id });
    });
    this.nothingBtn.addEventListener('click', () => {
      if (this.locked) return;
      missingLog.add(this.question, this.input.value, 'nichts');
      this.submit({ type: 'nothing' });
    });
    window.addEventListener('glasklar:viewport', () => { if (this.isOpen()) this.place(); });
  }

  setQuestion(question, index) {
    this.question = question;
    this.index = index;
    this.input.value = '';
    this.deselect();
    this.close();
    this.unlock();
  }

  lock(message = '') {
    this.locked = true;
    this.input.disabled = true;
    this.submitBtn.disabled = true;
    this.nothingBtn.disabled = true;
    this.clearBtn.hidden = true;
    this.close();
    this.root.classList.add('locked');
    this.status.textContent = message;
    this.status.hidden = !message;
  }

  unlock() {
    this.locked = false;
    this.input.disabled = false;
    this.nothingBtn.disabled = false;
    this.submitBtn.disabled = !this.selected;
    this.root.classList.remove('locked');
    this.status.hidden = true;
  }

  submit(sub) {
    clearTimeout(this.noHitTimer);
    this.input.blur();
    this.lock();
    this.onSubmit(sub);
  }

  /** Bei Timer-Ende: gewählter Eintrag zählt, sonst null. */
  currentSelection() {
    return this.selected ? { type: 'answer', answerId: this.selected.id } : null;
  }

  deselect() {
    this.selected = null;
    this.root.classList.remove('has-choice');
    this.submitBtn.disabled = true;
    this.clearBtn.hidden = !this.input.value;
  }

  onInput() {
    if (this.locked) return;
    if (this.selected && this.input.value !== this.selected.text) this.deselect();
    this.clearBtn.hidden = !this.input.value;
    const q = this.input.value;
    clearTimeout(this.noHitTimer);
    if (!q.trim()) { this.close(); return; }
    // Vorschläge nur für ganze Wörter (exakt oder Tippfehler) – nie per Anfangsbuchstabe
    this.results = searchAnswers(this.index, q);
    this.active = -1;
    if (this.results.length) {
      this.render();
    } else {
      // Während des Tippens nichts anzeigen; "Keine Treffer" erst nach einer Pause
      this.close();
      this.noHitTimer = setTimeout(() => this.showNoHit(), 1100);
    }
  }

  showNoHit() {
    clearTimeout(this.noHitTimer);
    if (this.locked || this.selected || !this.input.value.trim() || this.results.length) return;
    this.render();
  }

  /** Text ohne Treffer ins Fehlend-Log (bei Enter, Verlassen des Felds, Timer-Ende). */
  flushNoHit() {
    clearTimeout(this.noHitTimer);
    const q = this.input.value;
    if (!this.question || this.selected || !q.trim()) return;
    if (!searchAnswers(this.index, q).length) missingLog.add(this.question, q, 'nohit');
  }

  render() {
    if (!this.results.length) {
      this.list.innerHTML = '<li class="no-hit" aria-disabled="true">Keine Treffer – anderes Wort probieren<small>Tipp: ganzes Wort eintippen</small></li>';
    } else {
      this.list.innerHTML = this.results.map((r, i) => `
        <li role="option" data-id="${esc(r.id)}" id="sugg-${i}" class="${i === this.active ? 'active' : ''}" style="--i:${i}">
          ${r.fuzzy ? '<span class="s-fuzzy">Meintest du?</span>' : '<span class="s-hint">Tippen zum Auswählen</span>'}
          <span class="s-text">${esc(r.text)}</span>
          ${r.alias ? `<span class="s-alias">auch: ${esc(r.alias)}</span>` : ''}
        </li>`).join('');
    }
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.place();
  }

  /** Dropdown nach oben öffnen, wenn unten (Tastatur) kein Platz ist. */
  place() {
    const vv = window.visualViewport;
    const rect = this.input.getBoundingClientRect();
    const top = vv ? vv.offsetTop : 0;
    const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const below = bottom - rect.bottom - 8;
    const above = rect.top - top - 8;
    const want = Math.min(this.list.scrollHeight || 300, 320);
    // Bevorzugt nach oben: unter dem Feld liegen die Buttons bzw. die Tastatur
    const up = above >= Math.min(want, 160) || above > below;
    this.list.classList.toggle('up', up);
    this.list.style.maxHeight = `${Math.max(120, Math.min(320, up ? above : below))}px`;
  }

  isOpen() { return !this.list.hidden; }

  close() {
    this.list.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.active = -1;
  }

  onKey(e) {
    if (e.key === 'Enter' && !this.results.length && this.input.value.trim()) {
      e.preventDefault();
      this.showNoHit();
      this.flushNoHit();
      return;
    }
    if (!this.isOpen() || !this.results.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = this.results.length;
      this.active = e.key === 'ArrowDown' ? (this.active + 1) % n : (this.active - 1 + n) % n;
      this.render();
      this.input.setAttribute('aria-activedescendant', `sugg-${this.active}`);
    } else if (e.key === 'Enter' && this.active >= 0) {
      // Nur bewusst markierte Einträge werden per Enter gewählt – nie automatisch
      e.preventDefault();
      this.choose(this.results[this.active].id);
    } else if (e.key === 'Escape') {
      this.close();
    }
  }

  choose(id) {
    const r = this.results.find((x) => x.id === id);
    if (!r) return;
    this.selected = r;
    this.input.value = r.text;
    this.root.classList.add('has-choice');
    this.clearBtn.hidden = false;
    this.submitBtn.disabled = false;
    this.close();
    this.input.blur();
    sfx.select();
    this.submitBtn.classList.remove('nudge');
    void this.submitBtn.offsetWidth;
    this.submitBtn.classList.add('nudge');
  }
}

/* ------------------------------------------------------------------ */
/* Kleine Renderer                                                     */
/* ------------------------------------------------------------------ */

export function renderCategoryChips(container, categories, enabled, onChange) {
  container.innerHTML = categories.map((c) => `
    <button type="button" class="chip-toggle ${enabled.includes(c.id) ? 'on' : ''}" data-id="${esc(c.id)}" aria-pressed="${enabled.includes(c.id)}">
      <span class="chip-icon">${c.icon || '•'}</span>
      <span class="chip-name">${esc(c.name)}</span>
      <span class="chip-count">${c.count}</span>
    </button>`).join('');
  container.onclick = (e) => {
    const b = e.target.closest('.chip-toggle');
    if (!b) return;
    const on = !b.classList.contains('on');
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    sfx.pop();
    onChange($$('.chip-toggle.on', container).map((x) => x.dataset.id));
  };
}

/** Antwort-Chips mit Häufigkeit (ohne tier, ohne Schlücke). */
export function renderAnswerChips(container, groups, { highlightKey } = {}) {
  container.innerHTML = groups.map((g, i) => `
    <span class="answer-chip ${g.key.startsWith('__') ? 'muted' : ''} ${g.key === highlightKey ? 'mine' : ''}" style="--i:${i}" data-key="${esc(g.key)}">
      <span>${esc(g.label)}</span>${g.count > 1 ? `<b class="chip-count">${g.count}×</b>` : ''}
    </span>`).join('');
}
