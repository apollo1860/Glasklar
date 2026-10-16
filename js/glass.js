// Glasklar – das Bierglas als SVG-Komponente.
// API: setLevel(n), shake(strong), flashRed(), overflow(on), surfacePoint(), el
import { CONFIG } from './config.js';

const NS = 'http://www.w3.org/2000/svg';
const LEVELS = CONFIG.maxSipsPerRound;
const BOTTOM = 270; // Innenboden
const TOP = 46; // Oberfläche bei voller Füllung
const STEP = (BOTTOM - TOP) / LEVELS;
let uid = 0;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function wavePath(amp, len, y = 0) {
  // breite Sinuswelle von x=-200 bis 400, nach unten geschlossen
  let d = `M-200 ${y}`;
  for (let x = -200; x < 400; x += len) {
    d += ` q${len / 4} ${-amp} ${len / 2} 0 t${len / 2} 0`;
  }
  return `${d} V320 H-200 Z`;
}

function foamPath() {
  // Schaumkrone: bauschige Oberkante, unten gerade
  let d = 'M-200 4';
  for (let x = -200, i = 0; x < 400; x += 11, i++) d += ` a5.5 ${2 + (i % 3) * 0.8} 0 0 1 11 0`;
  return `${d} V13 H-200 Z`;
}

export function createGlass(container, { compact = false } = {}) {
  const id = `g${++uid}`;
  const wrap = document.createElement('div');
  wrap.className = `glass${compact ? ' glass--compact' : ''}`;
  wrap.innerHTML = `
  <svg viewBox="0 0 200 300" role="img" aria-label="Glas">
    <defs>
      <clipPath id="${id}-clip">
        <path d="M27 22 L45 262 Q46 270 56 270 L144 270 Q154 270 155 262 L173 22 Z"/>
      </clipPath>
      <linearGradient id="${id}-beer" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#f6d27a"/>
        <stop offset=".35" stop-color="#e8aa35"/>
        <stop offset="1" stop-color="#c47812"/>
      </linearGradient>
      <linearGradient id="${id}-beer-back" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e2ae4a" stop-opacity=".9"/>
        <stop offset="1" stop-color="#a9640f" stop-opacity=".9"/>
      </linearGradient>
      <linearGradient id="${id}-glass" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#ffffff" stop-opacity=".75"/>
        <stop offset=".25" stop-color="#f3efe6" stop-opacity=".35"/>
        <stop offset=".8" stop-color="#f3efe6" stop-opacity=".25"/>
        <stop offset="1" stop-color="#ffffff" stop-opacity=".7"/>
      </linearGradient>
    </defs>

    <!-- Glaskörper -->
    <path class="glass-body" d="M20 18 L40 268 Q42 286 60 286 L140 286 Q158 286 160 268 L180 18 Z" fill="url(#${id}-glass)"/>

    <g clip-path="url(#${id}-clip)">
      <g class="liquid" style="transform: translateY(300px)">
        <g class="wave wave--back"><path d="${wavePath(4, 70, 2)}" fill="url(#${id}-beer-back)"/></g>
        <g class="wave wave--front"><path d="${wavePath(3, 90, 5)}" fill="url(#${id}-beer)"/></g>
        <g class="bubbles"></g>
        <g class="foam"><g class="foam-inner"><path d="${foamPath()}" fill="#fbf6ea"/></g></g>
      </g>
    </g>

    <!-- Füllstrich-Markierungen (ohne Zahlen) -->
    <g class="ticks">
      ${Array.from({ length: LEVELS - 1 }, (_, i) => {
        const y = BOTTOM - (i + 1) * STEP;
        const x = 27 + ((y - 22) / 240) * 18 + 6;
        return `<line x1="${x}" y1="${y}" x2="${x + (i % 2 ? 6 : 10)}" y2="${y}"/>`;
      }).join('')}
    </g>

    <!-- Überlauf -->
    <g class="overflow-foam">
      <path class="spill spill--l" d="M18 22 q-6 0 -6 10 v20 q0 8 5 8 q5 0 5 -8 v-24 Z" fill="#fbf6ea"/>
      <path class="spill spill--r" d="M182 22 q6 0 6 10 v34 q0 8 -5 8 q-5 0 -5 -8 v-38 Z" fill="#fbf6ea"/>
      <path class="spill-cap" d="M14 24 q10 -22 30 -14 q14 -16 34 -6 q16 -14 36 -2 q18 -12 34 2 q20 -6 22 20 Z" fill="#fbf6ea"/>
    </g>

    <!-- Glanz und Kontur -->
    <path class="shine" d="M34 30 L50 250" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity=".55"/>
    <path class="shine" d="M48 30 L60 200" stroke="#fff" stroke-width="2.5" stroke-linecap="round" opacity=".5"/>
    <path class="glass-outline" d="M20 18 L40 268 Q42 286 60 286 L140 286 Q158 286 160 268 L180 18" fill="none"/>
    <path class="glass-base" d="M44 268 Q46 276 60 276 L140 276 Q154 276 156 268" fill="none"/>
    <line class="glass-rim" x1="19" y1="18" x2="181" y2="18"/>
  </svg>`;
  container.appendChild(wrap);

  const svg = wrap.querySelector('svg');
  const liquid = wrap.querySelector('.liquid');
  const bubbles = wrap.querySelector('.bubbles');
  const foam = wrap.querySelector('.foam-inner');
  let level = 0;

  function renderBubbles(n) {
    bubbles.textContent = '';
    if (n <= 0 || reducedMotion()) return;
    const depth = n * STEP;
    const count = Math.round(n * 2.6);
    for (let i = 0; i < count; i++) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', String(55 + Math.random() * 90));
      c.setAttribute('cy', '4');
      c.setAttribute('r', String(0.8 + Math.random() * 2.2));
      c.style.setProperty('--d', `${depth}px`);
      c.style.animationDuration = `${1.6 + Math.random() * 2.4}s`;
      c.style.animationDelay = `${-Math.random() * 4}s`;
      bubbles.appendChild(c);
    }
  }

  function setLevel(n, { animate = true } = {}) {
    level = Math.max(0, Math.min(LEVELS, n));
    const y = level === 0 ? 300 : BOTTOM - level * STEP;
    liquid.classList.toggle('no-anim', !animate);
    liquid.style.transform = `translateY(${y}px)`;
    // Schaumkrone wächst mit
    foam.style.transform = `scaleY(${level === 0 ? 0 : 0.7 + level * 0.12})`;
    wrap.dataset.level = String(level);
    renderBubbles(level);
    if (!animate) void liquid.getBoundingClientRect();
  }

  function retrigger(cls) {
    wrap.classList.remove(cls);
    void wrap.offsetWidth;
    wrap.classList.add(cls);
  }

  function shake(strong = false) {
    if (reducedMotion()) return;
    wrap.classList.remove('shake', 'shake-strong');
    void wrap.offsetWidth;
    wrap.classList.add(strong ? 'shake-strong' : 'shake');
  }

  function flashRed() { retrigger('flash-red'); }
  function glow(kind) { retrigger(`glow-${kind}`); }
  function overflow(on = true) { wrap.classList.toggle('overflowing', on); }

  /** Bildschirm-Koordinaten der Flüssigkeitsoberfläche (für Partikel). */
  function surfacePoint() {
    const r = svg.getBoundingClientRect();
    const y = level === 0 ? BOTTOM : BOTTOM - level * STEP;
    return { x: r.left + r.width / 2, y: r.top + (y / 300) * r.height, width: r.width };
  }

  setLevel(0, { animate: false });
  return { el: wrap, setLevel, shake, flashRed, glow, overflow, surfacePoint, get level() { return level; } };
}
