export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

export function icon(name, cls = 'i') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function setIcon(button, name) {
  const use = button.querySelector('use');
  if (use) use.setAttribute('href', `#i-${name}`);
}

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`sc.${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`sc.${key}`, JSON.stringify(value));
    } catch {}
  },
};

export function randomId(len = 16) {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => abc[b % abc.length]).join('');
}

export function clientId() {
  let id = storage.get('clientId');
  if (!/^[a-z0-9]{8,32}$/.test(id || '')) {
    id = randomId(16);
    storage.set('clientId', id);
  }
  return id;
}

export const fmtBitrate = (bps) =>
  !bps ? '—' : bps >= 1e6 ? `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} Mb/s` : `${Math.round(bps / 1e3)} kb/s`;

export function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const resLabel = (w, h) => (!w || !h ? '—' : `${w}×${h}`);

export function heightLabel(height) {
  if (!height) return '—';
  if (height >= 2100) return '4K';
  return `${height}p`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0;top:0;left:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {}
    ta.remove();
    return ok;
  }
}

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// ---------------------------------------------------------------------------
// Timers that keep running at full rate when the tab is in the background
// (Chrome throttles main-thread timers in hidden tabs, which would slow down
// signaling and stats while Ruben is in game). Falls back to setTimeout.
let worker;
let seq = 0;
const pending = new Map();

function timerWorker() {
  if (worker !== undefined) return worker;
  try {
    const src =
      'const t=new Map();onmessage=({data:d})=>{if(d.c){clearTimeout(t.get(d.id));t.delete(d.id)}else t.set(d.id,setTimeout(()=>{t.delete(d.id);postMessage(d.id)},d.ms))}';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = ({ data: id }) => {
      const fn = pending.get(id);
      pending.delete(id);
      fn?.();
    };
    // A worker blocked by the page's security policy reports an error:
    // fall back to plain timers and run what was waiting.
    worker.onerror = () => {
      worker = null;
      const waiting = [...pending.values()];
      pending.clear();
      waiting.forEach((fn) => setTimeout(fn, 0));
    };
  } catch {
    worker = null;
  }
  return worker;
}

export function later(fn, ms) {
  const w = timerWorker();
  if (!w) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  }
  const id = ++seq;
  pending.set(id, fn);
  w.postMessage({ id, ms });
  return () => {
    if (pending.delete(id)) worker?.postMessage({ id, c: 1 });
  };
}

export const wait = (ms) => new Promise((resolve) => later(resolve, ms));

export function every(fn, ms) {
  let stopped = false;
  let cancel;
  const tick = async () => {
    if (stopped) return;
    try {
      await fn();
    } catch (err) {
      console.error(err);
    }
    if (!stopped) cancel = later(tick, ms);
  };
  cancel = later(tick, ms);
  return () => {
    stopped = true;
    cancel?.();
  };
}
