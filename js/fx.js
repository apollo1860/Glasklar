// Glasklar – Effekte: Konfetti, Funkeln, Spritzer, Vibration.
import { store } from './storage.js';

export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function vibrate(pattern) {
  if (store.get('settings', {}).vibrate === false) return;
  try { navigator.vibrate?.(pattern); } catch { /* nicht unterstützt */ }
}

function layer() {
  let el = document.getElementById('fx-layer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fx-layer';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
  }
  return el;
}

/** Grün/goldenes Funkeln rund um einen Punkt (seltene Antwort). */
export function sparkle(x, y, radius = 120) {
  const host = layer();
  const n = reducedMotion() ? 6 : 22;
  const colors = ['#2f8f5f', '#e3b341', '#3fa36f', '#f2c94c', '#c9a227'];
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span');
    s.className = 'sparkle';
    s.textContent = i % 3 ? '✦' : '✧';
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    s.style.color = colors[i % colors.length];
    s.style.fontSize = `${10 + Math.random() * 18}px`;
    host.appendChild(s);
    const a = Math.random() * Math.PI * 2;
    const d = radius * (0.4 + Math.random() * 0.8);
    const dx = Math.cos(a) * d;
    const dy = Math.sin(a) * d - 20;
    const anim = reducedMotion()
      ? s.animate([{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }], { duration: 900 })
      : s.animate([
        { transform: 'translate(-50%,-50%) scale(0) rotate(0deg)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx * 0.7}px), calc(-50% + ${dy * 0.7}px)) scale(1.3) rotate(120deg)`, opacity: 1, offset: 0.6 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0) rotate(220deg)`, opacity: 0 },
      ], { duration: 900 + Math.random() * 700, easing: 'cubic-bezier(.2,.8,.3,1)', delay: Math.random() * 250 });
    anim.onfinish = () => s.remove();
  }
}

/** Spritzer an der Flüssigkeitsoberfläche. */
export function splash(x, y, count = 10) {
  if (reducedMotion()) return;
  const host = layer();
  for (let i = 0; i < count; i++) {
    const d = document.createElement('span');
    d.className = 'droplet';
    d.style.left = `${x + (Math.random() - 0.5) * 60}px`;
    d.style.top = `${y}px`;
    const size = 5 + Math.random() * 8;
    d.style.width = d.style.height = `${size}px`;
    host.appendChild(d);
    const dx = (Math.random() - 0.5) * 140;
    const up = 50 + Math.random() * 80;
    const anim = d.animate([
      { transform: 'translate(-50%,-50%)', opacity: 1 },
      { transform: `translate(calc(-50% + ${dx * 0.6}px), calc(-50% - ${up}px))`, opacity: 1, offset: 0.45 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + 40px))`, opacity: 0 },
    ], { duration: 750 + Math.random() * 300, easing: 'cubic-bezier(.3,.6,.5,1)' });
    anim.onfinish = () => d.remove();
  }
}

/** Ein Element (z. B. Antwort-Chip) fliegt ins Glas und spritzt. */
export function flyInto(fromEl, target, onLand) {
  const r = fromEl.getBoundingClientRect();
  const clone = fromEl.cloneNode(true);
  clone.classList.add('flying');
  Object.assign(clone.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px` });
  layer().appendChild(clone);
  const dx = target.x - (r.left + r.width / 2);
  const dy = target.y - (r.top + r.height / 2);
  const anim = clone.animate([
    { transform: 'translate(0,0) scale(1) rotate(0)', opacity: 1 },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 80}px) scale(.8) rotate(-12deg)`, opacity: 1, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) scale(.2) rotate(20deg)`, opacity: 0 },
  ], { duration: reducedMotion() ? 200 : 700, easing: 'cubic-bezier(.4,0,.6,1)' });
  anim.onfinish = () => { clone.remove(); onLand?.(); };
}

/** Konfetti auf einem Vollbild-Canvas. */
export function confetti({ duration = 3200, x = 0.5, y = 0.35 } = {}) {
  if (reducedMotion()) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const resize = () => {
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  const colors = ['#e3a01b', '#f2c14e', '#2f6b4f', '#c8372d', '#1d1b18', '#efe4cf'];
  const parts = Array.from({ length: 120 }, () => {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
    const v = 7 + Math.random() * 9;
    return {
      x: innerWidth * x, y: innerHeight * y,
      vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      w: 6 + Math.random() * 6, h: 8 + Math.random() * 10,
      r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
      c: colors[(Math.random() * colors.length) | 0],
      round: Math.random() < 0.25,
    };
  });
  const start = performance.now();
  function frame(t) {
    const el = t - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const fade = el > duration - 600 ? Math.max(0, (duration - el) / 600) : 1;
    for (const p of parts) {
      p.vy += 0.22;
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.w / 2, -p.h / 2 * Math.abs(Math.cos(p.r * 2)), p.w, p.h * Math.abs(Math.cos(p.r * 2)) + 1);
      ctx.restore();
    }
    if (el < duration) requestAnimationFrame(frame);
    else canvas.remove();
  }
  requestAnimationFrame(frame);
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
