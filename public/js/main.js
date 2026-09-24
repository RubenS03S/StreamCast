import { HOST_NAME } from './config.js';
import { $, $$, storage } from './util.js';
import { isIOS, isMobile, isDesktop, isWindows, isStandalone } from './device.js';
import { wireDialogs, openDialog, toast, closeMenus } from './ui.js';
import { initHost, isLive } from './host.js';
import { initViewer, watch, isWatching } from './viewer.js';

const VIEWS = ['view-home', 'view-invite', 'view-host', 'view-watch'];

function show(id) {
  closeMenus();
  for (const v of VIEWS) $(`#${v}`).hidden = v !== id;
  document.body.dataset.view = id;
  window.scrollTo(0, 0);
}

const codeFromUrl = () => {
  const path = location.pathname.match(/^\/(\d{3,4})\/?$/)?.[1];
  const query = new URLSearchParams(location.search).get('c');
  return path || (/^\d{3,4}$/.test(query || '') ? query : null);
};

function goHome() {
  history.replaceState(null, '', '/');
  renderRecent();
  show('view-home');
}

// ================================================================= home
function renderRecent() {
  const code = storage.get('lastCode');
  const btn = $('#btn-recent');
  btn.hidden = !code;
  if (code) $('#recent-code').textContent = code;
}

function wireHome() {
  const form = $('#join-form');
  const codeInput = $('#join-code');
  const nameInput = $('#join-name');
  nameInput.value = storage.get('name', '');

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 4);
    codeInput.classList.remove('error');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = codeInput.value.trim();
    if (!/^\d{3,4}$/.test(code)) {
      codeInput.classList.remove('error');
      void codeInput.offsetWidth;
      codeInput.classList.add('error');
      codeInput.focus();
      return;
    }
    const name = nameInput.value.trim().slice(0, 32);
    storage.set('name', name);
    codeInput.blur();
    watch(code, name);
  });
  $('#btn-recent').addEventListener('click', () => {
    const code = storage.get('lastCode');
    if (code) watch(code, nameInput.value.trim() || storage.get('name', ''));
  });
  renderRecent();

  // Viewing devices see "Regarder" first.
  if (isMobile) $('#home-grid').classList.add('viewer-first');
}

// =============================================================== invite
function showInvite(code) {
  $('#invite-code').textContent = code;
  $('#invite-host').textContent = HOST_NAME;
  $('#invite-avatar').textContent = HOST_NAME[0];
  $('#invite-name').value = storage.get('name', '');
  show('view-invite');
}

function wireInvite() {
  $('#invite-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#invite-code').textContent;
    const name = $('#invite-name').value.trim().slice(0, 32);
    storage.set('name', name);
    $('#invite-name').blur();
    watch(code, name);
  });
  $('#btn-invite-other').addEventListener('click', goHome);
}

// ============================================================== install
let deferredPrompt = null;

function renderInstall() {
  const installed = isStandalone();
  for (const btn of $$('.btn-install')) {
    btn.hidden = installed;
    btn.querySelector('.label').textContent = isDesktop && isWindows ? 'Télécharger sur PC' : 'Télécharger';
  }
}

async function install() {
  if (deferredPrompt) {
    const prompt = deferredPrompt;
    deferredPrompt = null;
    prompt.prompt();
    const choice = await prompt.userChoice.catch(() => null);
    if (choice?.outcome === 'accepted') toast('Installation de StreamCast…', { icon: 'download' });
    return;
  }
  const dialog = $('#dlg-install');
  $('#install-ios').hidden = !isIOS;
  $('#install-desktop').hidden = isIOS;
  openDialog(dialog);
}

function wireInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    toast('StreamCast est installée', { icon: 'check' });
    renderInstall();
  });
  matchMedia('(display-mode: standalone)').addEventListener?.('change', renderInstall);
  $$('.btn-install').forEach((b) => b.addEventListener('click', install));
  renderInstall();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

// ================================================================= boot
function boot() {
  if (isStandalone()) document.documentElement.classList.add('standalone');
  if (isIOS) document.documentElement.classList.add('ios');
  wireDialogs();
  wireInstall();
  wireHome();
  wireInvite();
  initHost({ show });
  initViewer({ show, exit: goHome });

  const code = codeFromUrl();
  if (code) showInvite(code);
  else show('view-home');

  window.addEventListener('popstate', () => {
    if (isLive() || isWatching()) return;
    const c = codeFromUrl();
    if (c) showInvite(c);
    else show('view-home');
  });

  // iOS: keep layout height in sync with the visible viewport (keyboard).
  const vv = window.visualViewport;
  if (vv) {
    const sync = () => document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
    vv.addEventListener('resize', sync);
    sync();
  }
}

boot();
