import { $, h, icon } from './util.js';
import { fullscreenElement } from './device.js';
import qrcode from './vendor/qrcode.mjs';

// ---------------------------------------------------------------- toasts
let toastRoot = null;
export function toast(message, { type = 'info', icon: iconName, timeout = 2600 } = {}) {
  if (!toastRoot) toastRoot = h('div', { class: 'toasts', 'aria-live': 'polite' });
  const host = fullscreenElement() || document.body;
  if (toastRoot.parentNode !== host) host.append(toastRoot);
  const el = h('div', { class: `toast toast-${type}` }, iconName ? icon(iconName) : null, h('span', { text: message }));
  toastRoot.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

// --------------------------------------------------------------- dialogs
export function openDialog(dialog) {
  if (dialog.open) return;
  const host = fullscreenElement();
  if (host && dialog.parentNode !== host) host.append(dialog);
  else if (!host && dialog.parentNode !== document.body) document.body.append(dialog);
  dialog.showModal();
}

export function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

// Close dialogs when tapping the backdrop, and on [data-close] buttons.
export function wireDialogs() {
  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer) {
      closeDialog(closer.closest('dialog'));
      return;
    }
    if (e.target instanceof HTMLDialogElement && e.target.open) {
      const r = e.target.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) closeDialog(e.target);
    }
  });
}

export function confirmDialog({ title, message, confirm = 'OK', cancel = 'Annuler', danger = false }) {
  return new Promise((resolve) => {
    const dialog = h(
      'dialog',
      { class: 'sheet sheet-sm' },
      h(
        'div',
        { class: 'sheet-body' },
        h('h3', { class: 'sheet-title', text: title }),
        message ? h('p', { class: 'sheet-text', text: message }) : null,
        h(
          'div',
          { class: 'sheet-actions' },
          h('button', { class: 'btn btn-ghost', value: 'cancel', text: cancel }),
          h('button', { class: `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`, value: 'ok', text: confirm }),
        ),
      ),
    );
    dialog.addEventListener('click', (e) => {
      const btn = e.target.closest('button[value]');
      if (btn) dialog.close(btn.value);
    });
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok');
      dialog.remove();
    });
    openDialog(dialog);
  });
}

// ----------------------------------------------------------- popover menu
// items: [{ id, label, desc }]
export function openMenu(anchor, items, current, onSelect) {
  closeMenus();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    const btn = h(
      'button',
      { class: 'menu-item', role: 'menuitemradio', 'aria-checked': String(item.id === current) },
      h('span', { class: 'menu-label', text: item.label }),
      item.desc ? h('span', { class: 'menu-desc', text: item.desc }) : null,
      item.id === current ? icon('check', 'i menu-check') : null,
    );
    btn.addEventListener('click', () => {
      closeMenus();
      onSelect(item.id);
    });
    menu.append(btn);
  }
  (fullscreenElement() || document.body).append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = Math.min(340, window.innerWidth - 24);
  menu.style.width = `${mw}px`;
  const left = Math.min(window.innerWidth - mw - 12, Math.max(12, r.left + r.width / 2 - mw / 2));
  menu.style.left = `${left}px`;
  const mh = menu.offsetHeight;
  const below = r.bottom + 8 + mh < window.innerHeight;
  menu.style.top = `${below ? r.bottom + 8 : Math.max(12, r.top - 8 - mh)}px`;
  requestAnimationFrame(() => menu.classList.add('show'));
  setTimeout(() => document.addEventListener('pointerdown', outside, { capture: true }), 0);
  function outside(e) {
    if (!menu.contains(e.target)) closeMenus();
  }
  menu._cleanup = () => document.removeEventListener('pointerdown', outside, { capture: true });
}

export function closeMenus() {
  document.querySelectorAll('.menu').forEach((m) => {
    m._cleanup?.();
    m.remove();
  });
}

// ------------------------------------------------------------ segmented
// Builds a segmented control inside `root`; returns a setter.
export function segmented(root, options, value, onChange) {
  root.classList.add('seg');
  root.replaceChildren(
    ...options.map((o) =>
      h('button', { type: 'button', 'data-value': o.id, 'aria-pressed': String(o.id === value), text: o.label }),
    ),
  );
  root.onclick = (e) => {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    set(b.dataset.value);
    onChange(b.dataset.value);
  };
  function set(v) {
    root.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v)));
  }
  return set;
}

// ------------------------------------------------------------------- QR
export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#0b0b12"/></svg>`;
}

export function showQr(url) {
  const dialog = $('#dlg-qr');
  $('#qr-box', dialog).innerHTML = qrSvg(url);
  $('#qr-url', dialog).textContent = url.replace(/^https?:\/\//, '');
  openDialog(dialog);
}

// -------------------------------------------------------- notifications
export function notify(title, body) {
  try {
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const n = new Notification(title, { body, icon: '/icons/icon-192.png', silent: true, tag: 'streamcast' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {}
}

// ------------------------------------------------------------ reactions
export function floatReaction(layer, emoji) {
  if (!layer) return;
  const el = h('span', { class: 'react-float', text: emoji });
  el.style.left = `${10 + Math.random() * 70}%`;
  el.style.setProperty('--drift', `${Math.round(Math.random() * 60 - 30)}px`);
  layer.append(el);
  setTimeout(() => el.remove(), 2800);
}
