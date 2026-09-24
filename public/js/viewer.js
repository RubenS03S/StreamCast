import { HOST_NAME, REACTIONS, VIEWER_QUALITY } from './config.js';
import { $, h, setIcon, storage, clientId, fmtBitrate, heightLabel, clamp, later, every, wait } from './util.js';
import { api, getIceServers, Poller } from './api.js';
import {
  waitIceGathering, tuneAnswerForReceiver, audioSections, decodeCaps, receiverStats, supportsJitterTarget, codecLabel,
} from './rtc.js';
import { isIPad, isIOS, deviceLabel, canElementFullscreen, fullscreenElement } from './device.js';
import { toast, openDialog, segmented, floatReaction } from './ui.js';
import { createMeter } from './audio.js';
import { pushSupported, pushNeedsInstall, pushEnabled, enablePush, disablePush } from './push.js';

const DEFAULT_PREFS = { quality: 'auto', latency: 'auto', fit: 'contain', stats: false, fsMode: 'app', game: 1, voice: 1, call: true };

const V = {
  active: false,
  run: 0,
  code: null,
  name: '',
  viewerId: null,
  pc: null,
  dc: null,
  programMid: null,
  micSender: null,
  mic: null,
  micOn: false,
  status: 'idle',
  host: {},
  stats: null,
  stopStats: null,
  sentFreezes: 0,
  tick: 0,
  wakeLock: null,
  onConnected: null,
  onFailed: null,
  unread: 0,
  micBlocked: false,
  iceFails: 0,
  micMeter: null,
  thumbEvery: 0,
  stopThumbs: null,
  jbBoostUntil: 0,
  prefs: { ...DEFAULT_PREFS, ...storage.get('viewerPrefs', {}) },
};

const video = () => $('#remote');
const savePrefs = () => storage.set('viewerPrefs', V.prefs);
let showView = () => {};
let onExit = () => {};

// ================================================================ state UI
function setState(kind, title = '', sub = '', action = null) {
  V.status = kind;
  const box = $('#w-state');
  const visible = kind !== 'live';
  box.hidden = !visible;
  box.dataset.kind = kind;
  $('#w-state-title').textContent = title;
  $('#w-state-sub').textContent = sub;
  $('#player').dataset.state = kind;
  if (kind !== 'live') {
    $('#react-picker').hidden = true;
    $('#w-quality').dataset.tone = 'wait';
    $('#w-host-mic').hidden = true;
  }
  const btn = $('#w-state-btn');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = action.onClick;
  }
  $('#player').classList.toggle('has-state', visible);
  if (visible) $('#w-paused').hidden = true;
  renderNotify();
  $('#player').classList.toggle('no-video', !video().srcObject);
  if (visible) showControls(true);
}

// ================================================================== join
export async function watch(code, name) {
  const v = video();
  // With a tap (code typed by hand) this unlocks sound right away; when the
  // link opens the live directly, playback starts muted until the first tap.
  v.muted = false;
  v.play().catch(() => {});

  V.active = true;
  V.code = code;
  V.name = name || '';
  V.host = {};
  storage.set('lastCode', code);
  showView('view-watch');
  applyFit();
  applyStatsVisibility();
  setState('connecting', 'Connexion…', `Live de ${HOST_NAME}`);
  history.replaceState(null, '', `/${code}`);
  requestWakeLock();
  setupMediaSession();
  connectLoop();
}

async function connectLoop() {
  const run = ++V.run;
  let attempt = 0;
  const caps = await buildCaps();
  while (V.active && V.run === run) {
    let res;
    try {
      res = await api('join', { code: V.code, name: V.name, clientId: clientId(), caps });
    } catch (err) {
      res = { ok: false, reason: err?.status === 400 ? 'unknown' : 'network' };
    }
    if (!V.active || V.run !== run) return;

    if (res.ok) {
      V.viewerId = res.viewerId;
      const result = await awaitOffer(run);
      if (!V.active || V.run !== run) return;
      if (result === true) return;
      if (result === 'rejected') {
        setState('ended', 'Accès refusé', `${HOST_NAME} n’a pas accepté la demande`, { label: 'Retour', onClick: leave });
        return;
      }
      if (V.iceFails >= 2) {
        const { relay } = await getIceServers();
        setState('connecting', 'Connexion difficile', relay
          ? 'Nouvel essai par le relais…'
          : 'Ce réseau bloque la connexion directe avec le PC. Essaie un autre Wi-Fi ou la 4G/5G.');
      } else setState('connecting', 'Connexion…', 'Nouvel essai');
    } else if (res.reason === 'unknown') {
      setState('ended', 'Code inconnu', `Aucun live avec le code ${V.code}`, { label: 'Retour', onClick: leave });
      return;
    } else if (res.reason === 'offline') {
      if (V.status !== 'waiting') {
        setState('waiting', `${HOST_NAME} n’est pas en live`, 'Le live s’affichera automatiquement dès qu’il commence');
      }
      await waitUntilLive(run);
      attempt = 0;
      continue;
    } else {
      setState('connecting', 'Connexion au serveur…', 'Vérifie ta connexion internet');
    }
    attempt++;
    await wait(Math.min(6000, 800 * attempt));
  }
}

async function waitUntilLive(run) {
  releaseWakeLock();
  const since = Date.now();
  while (V.active && V.run === run) {
    // Check often at first, then more calmly if the wait gets long.
    const long = Date.now() - since > 5 * 60_000;
    await wait(document.hidden || long ? 8000 : 3000);
    try {
      const st = await api('status', { code: V.code }, { retries: 0 });
      if (st.live) return;
    } catch {}
  }
}

function awaitOffer(run) {
  return new Promise((resolve) => {
    let done = false;
    const cancel = later(() => finish(false), 30000);
    const poller = new Poller({
      payload: { code: V.code, id: V.viewerId },
      idle: 800,
      fast: 350,
      onResult: async ({ messages, live }) => {
        for (const m of messages) {
          if (m.data?.type === 'offer') {
            try {
              await handleOffer(m.data.sdp);
            } catch (err) {
              console.error(err);
              finish(false);
            }
          } else if (m.data?.type === 'reject') finish('rejected');
        }
        if (live === false && !V.pc) finish(false);
      },
    });
    V.onConnected = () => finish(true);
    V.onFailed = () => finish(false);
    poller.boost(30000);
    poller.start();
    function finish(value) {
      if (done) return;
      done = true;
      cancel();
      poller.stop();
      V.onConnected = V.onFailed = null;
      if (value !== true) closePc();
      resolve(V.run === run ? value : false);
    }
  });
}

async function buildCaps() {
  const dec = await decodeCaps().catch(() => ({ mimes: [], hw: {} }));
  const dpr = window.devicePixelRatio || 1;
  return {
    device: deviceLabel(),
    mimes: dec.mimes,
    hw: dec.hw,
    screen: { w: Math.round(screen.width * dpr), h: Math.round(screen.height * dpr) },
  };
}

// ================================================================== WebRTC
async function handleOffer(sdp) {
  const { servers } = await getIceServers();
  closePc();
  const pc = (V.pc = new RTCPeerConnection({ iceServers: servers, bundlePolicy: 'max-bundle' }));
  pc.ontrack = onTrack;
  pc.ondatachannel = (e) => setupChannel(e.channel);
  pc.onconnectionstatechange = () => onPcState(pc);

  await pc.setRemoteDescription({ type: 'offer', sdp });
  await prepareAnswer(pc, sdp);
  await waitIceGathering(pc);
  if (V.pc !== pc) return;
  await api('send', { code: V.code, from: V.viewerId, to: 'host', data: { type: 'answer', sdp: pc.localDescription.sdp } });
}

async function prepareAnswer(pc, offerSdp) {
  const sections = audioSections(offerSdp);
  V.programMid = sections.find((s) => s.direction === 'sendonly')?.mid ?? V.programMid;
  const micMid = sections.find((s) => s.direction === 'recvonly')?.mid;
  const micT = pc.getTransceivers().find((t) => t.mid === micMid);
  if (micT) {
    micT.direction = 'sendonly';
    V.micSender = micT.sender;
    if (V.mic) await micT.sender.replaceTrack(V.mic).catch(() => {});
  }
  applyLatency();
  const answer = await pc.createAnswer();
  try {
    await pc.setLocalDescription({ type: 'answer', sdp: tuneAnswerForReceiver(answer.sdp, V.programMid) });
  } catch {
    await pc.setLocalDescription(answer);
  }
}

// Renegotiation requested by the host over the data channel (codec change).
async function onRenegotiate(sdp) {
  const pc = V.pc;
  if (!pc) return;
  await pc.setRemoteDescription({ type: 'offer', sdp });
  await prepareAnswer(pc, sdp);
  send({ t: 'answer', sdp: pc.localDescription.sdp });
}

function onTrack(e) {
  const v = video();
  const stream = e.streams[0];
  if (!stream) return;
  if (v.srcObject !== stream) {
    v.srcObject = stream;
    $('#player').classList.remove('no-video');
  }
  play();
}

function onPcState(pc) {
  if (pc !== V.pc) return;
  const st = pc.connectionState;
  if (st === 'connected') {
    V.cancelDisc?.();
    V.iceFails = 0;
    setState('live');
    requestWakeLock();
    V.onConnected?.();
    startStats();
    applyHostState();
    if (V.prefs.call && !V.micOn && !V.micBlocked) startMic({ auto: true });
  } else if (st === 'disconnected') {
    V.cancelDisc?.();
    V.cancelDisc = later(() => {
      if (V.pc === pc && pc.connectionState !== 'connected') lost();
    }, 4000);
  } else if (st === 'failed') {
    V.iceFails++;
    lost();
  }
}

function lost() {
  if (V.onFailed) return V.onFailed();
  if (!V.active || ['ended', 'kicked'].includes(V.status)) return;
  closePc();
  setState('reconnecting', 'Reconnexion…', 'La connexion a été interrompue');
  connectLoop();
}

function closePc() {
  V.cancelDisc?.();
  V.stopStats?.();
  V.stopStats = null;
  applyThumbs(0);
  if (V.pc) {
    V.pc.onconnectionstatechange = null;
    try {
      V.pc.close();
    } catch {}
  }
  V.pc = null;
  V.dc = null;
  V.micSender = null;
}

// =========================================================== data channel
function setupChannel(ch) {
  V.dc = ch;
  ch.onopen = () => {
    send({ t: 'hello', name: V.name });
    sendPrefs();
    if (V.micOn) send({ t: 'mic', on: true });
  };
  ch.onmessage = (e) => {
    try {
      onHostMessage(JSON.parse(e.data));
    } catch {}
  };
}

function send(msg) {
  if (V.dc?.readyState === 'open') {
    try {
      V.dc.send(JSON.stringify(msg));
    } catch {}
  }
}

function onHostMessage(m) {
  switch (m.t) {
    case 'hello':
    case 'state':
      V.host = { ...V.host, ...m };
      applyHostState();
      break;
    case 'chat':
      addChat({ name: m.name, text: String(m.text || ''), host: !!m.host });
      break;
    case 'react':
      floatReaction($('#react-layer'), m.emoji);
      break;
    case 'talk':
      $('#player').classList.toggle('host-talking', !!m.on);
      break;
    case 'offer':
      onRenegotiate(m.sdp).catch((err) => console.warn('renegotiate', err));
      break;
    case 'kick':
      V.status = 'kicked';
      closePc();
      setState('ended', 'Tu as été retiré du live', '', { label: 'Retour', onClick: leave });
      break;
    case 'bye':
      closePc();
      setState('waiting', 'Le live est terminé', 'Tu seras reconnecté automatiquement au prochain live');
      V.run++;
      (async () => {
        const run = V.run;
        await wait(3000);
        if (V.active && V.run === run) connectLoop();
      })();
      break;
  }
}

function applyHostState() {
  $('#w-paused').hidden = !(V.status === 'live' && V.host.paused);
  $('#w-host-mic').hidden = !V.host.mic;
  applyThumbs(V.status === 'live' ? Number(V.host.thumbs) || 0 : 0);
}

// Small snapshots of what this screen shows, sent to Ruben's "retour" so he
// can check what the spectateur really sees. Only while he asks for them.
function applyThumbs(ms) {
  ms = ms > 0 ? Math.max(1500, ms) : 0;
  if (V.thumbEvery === ms) return;
  V.thumbEvery = ms;
  V.stopThumbs?.();
  V.stopThumbs = ms ? every(sendThumb, ms) : null;
}

function sendThumb() {
  const v = video();
  if (V.dc?.readyState !== 'open' || !v.videoWidth || document.hidden) return;
  const w = 384;
  const h = Math.round((w * v.videoHeight) / v.videoWidth);
  const c = (V.thumbCanvas ||= document.createElement('canvas'));
  c.width = w;
  c.height = h;
  try {
    c.getContext('2d').drawImage(v, 0, 0, w, h);
    const url = c.toDataURL('image/jpeg', 0.6);
    if (url.length < 60000) send({ t: 'thumb', url });
  } catch {}
}

// ================================================================ playback
async function play() {
  const v = video();
  try {
    await v.play();
    if (!v.muted) $('#w-unmute').hidden = true;
  } catch {
    // Autoplay with sound blocked: play muted and ask for a tap.
    v.muted = true;
    try {
      await v.play();
    } catch {}
    $('#w-unmute').hidden = false;
  }
}

function unmute() {
  const v = video();
  v.muted = false;
  v.play().catch(() => {});
  $('#w-unmute').hidden = true;
}

function resumePlayback() {
  const v = video();
  if (V.active && v.srcObject && v.paused) play();
}

function applyFit() {
  $('#player').classList.toggle('fill', V.prefs.fit === 'cover');
  setIcon($('#w-fit'), V.prefs.fit === 'cover' ? 'shrink' : 'expand');
  resetZoom();
}

function applyLatency() {
  if (!V.pc || !supportsJitterTarget()) return;
  const boost = V.prefs.latency === 'auto' && Date.now() < V.jbBoostUntil;
  const target = V.prefs.latency === 'smooth' || boost ? 250 : null;
  for (const r of V.pc.getReceivers()) {
    try {
      r.jitterBufferTarget = target;
    } catch {}
  }
}

// ============================================================ fullscreen
function toggleFullscreen() {
  if (fullscreenElement()) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    return;
  }
  const v = video();
  const native = !canElementFullscreen() || (isIPad && V.prefs.fsMode === 'native');
  if (native && v.webkitEnterFullscreen) {
    try {
      v.webkitEnterFullscreen();
      return;
    } catch {}
  }
  const el = $('#view-watch');
  try {
    const r = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.();
    r?.catch?.(() => v.webkitEnterFullscreen?.());
  } catch {
    v.webkitEnterFullscreen?.();
  }
}

function onFullscreenChange() {
  const fs = !!fullscreenElement();
  setIcon($('#w-fs'), fs ? 'minimize' : 'maximize');
  $('#w-fs').setAttribute('aria-label', fs ? 'Quitter le plein écran' : 'Plein écran');
  setTimeout(resumePlayback, 150);
}

// ================================================================== PiP
async function togglePip() {
  const v = video();
  try {
    if (document.pictureInPictureElement) return await document.exitPictureInPicture();
    if (v.webkitPresentationMode === 'picture-in-picture') return v.webkitSetPresentationMode('inline');
    if (document.pictureInPictureEnabled && v.requestPictureInPicture) return await v.requestPictureInPicture();
    if (v.webkitSupportsPresentationMode?.('picture-in-picture')) return v.webkitSetPresentationMode('picture-in-picture');
    toast('Mini-lecteur non disponible sur ce navigateur', { type: 'warn' });
  } catch {
    toast('Mini-lecteur indisponible pour le moment', { type: 'warn' });
  }
}

const pipSupported = () =>
  !!((document.pictureInPictureEnabled && video().requestPictureInPicture) || video().webkitSupportsPresentationMode?.('picture-in-picture'));

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `Live de ${HOST_NAME}`,
      artist: 'StreamCast',
      artwork: [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  } catch {}
  try {
    navigator.mediaSession.setActionHandler('enterpictureinpicture', () => video().requestPictureInPicture?.());
  } catch {}
}

// ================================================================== mic
// Call: the spectateur's mic goes to Ruben. On by default ("Appel" setting),
// off with one tap (iOS plays the live with better sound when the mic is off).
function toggleMic() {
  return V.micOn ? stopMic() : startMic();
}

async function startMic({ auto = false } = {}) {
  const btn = $('#w-mic');
  if (V.micOn || btn.disabled) return;
  btn.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    V.mic = stream.getAudioTracks()[0];
    await V.micSender?.replaceTrack(V.mic);
    V.micOn = true;
    V.micBlocked = false;
    send({ t: 'mic', on: true });
    try {
      V.ac ||= new (window.AudioContext || window.webkitAudioContext)();
      V.ac.resume().catch(() => {});
      V.micMeter = createMeter(V.ac, V.mic);
    } catch {}
    // A page using the mic may play sound without a tap on iOS.
    if (video().muted && !$('#w-unmute').hidden) {
      const v = video();
      v.muted = false;
      v.play().then(() => ($('#w-unmute').hidden = true)).catch(() => {
        v.muted = true;
        v.play().catch(() => {});
      });
    }
  } catch {
    V.micBlocked = true;
    toast(auto ? 'Micro non autorisé : touche le micro pour parler' : 'Micro refusé : autorise-le dans les réglages de Safari', { type: 'warn', icon: 'mic-off' });
  }
  btn.disabled = false;
  renderMic();
  setTimeout(resumePlayback, 200);
}

async function stopMic() {
  if (!V.micOn) return;
  V.micOn = false;
  await V.micSender?.replaceTrack(null).catch(() => {});
  V.mic?.stop();
  V.mic = null;
  V.micMeter?.stop?.();
  V.micMeter = null;
  send({ t: 'mic', on: false });
  renderMic();
  setTimeout(resumePlayback, 200);
}

function renderMic() {
  const btn = $('#w-mic');
  btn.classList.toggle('on', V.micOn);
  btn.setAttribute('aria-pressed', String(V.micOn));
  btn.setAttribute('aria-label', V.micOn ? 'Couper mon micro' : 'Activer mon micro');
  setIcon(btn, V.micOn ? 'mic' : 'mic-off');
}

function micLevelLoop() {
  requestAnimationFrame(micLevelLoop);
  if (!V.active || document.hidden) return;
  const lvl = V.micOn && V.micMeter ? V.micMeter() : 0;
  $('#w-mic').style.setProperty('--lvl', lvl.toFixed(3));
}

// ================================================================= stats
function startStats() {
  V.stopStats?.();
  V.stats = null;
  V.tick = 0;
  V.stopStats = every(async () => {
    if (!V.pc) return;
    const st = await receiverStats(V.pc, V.stats);
    V.stats = st;
    V.sentFreezes += st.newFreezes || 0;
    // Auto latency: on an unstable connection, keep a small buffer for a
    // minute so the image stays smooth instead of stuttering.
    if (V.prefs.latency === 'auto' && ((st.newFreezes || 0) > 0 || (st.loss || 0) > 0.03 || (st.jitterMs || 0) > 80)) {
      const wasBoosted = Date.now() < V.jbBoostUntil;
      V.jbBoostUntil = Date.now() + 60_000;
      if (!wasBoosted) applyLatency();
    } else if (V.jbBoostUntil && Date.now() > V.jbBoostUntil) {
      V.jbBoostUntil = 0;
      applyLatency();
    }
    renderQuality(st);
    if (++V.tick % 2 === 0) {
      send({
        t: 'stats',
        fps: st.fps,
        w: st.width,
        h: st.height,
        dropRate: st.dropRate || 0,
        newFreezes: V.sentFreezes,
        decodeMs: st.decodeMs,
        jitterMs: st.jitterMs,
        loss: st.loss,
        latencyMs: st.latencyMs,
      });
      V.sentFreezes = 0;
    }
  }, 1000);
}

function renderQuality(st) {
  const q = $('#w-quality');
  if (!st.height) {
    q.dataset.tone = 'wait';
    $('#w-quality-label').textContent = '';
    return;
  }
  const tone = (st.loss || 0) > 0.05 || (st.dropRate || 0) > 0.1 || st.fps < 20 ? 'bad' : (st.loss || 0) > 0.01 || st.fps < 45 ? 'mid' : 'good';
  q.dataset.tone = tone;
  $('#w-quality-label').textContent = `${heightLabel(st.height)}${st.fps ? ` · ${Math.round(st.fps)}` : ''}`;
  if (V.prefs.stats) {
    const path = { local: 'Réseau local', direct: 'Direct', relay: 'Relais' }[st.path] || '—';
    $('#w-stats').replaceChildren(
      row('Résolution', st.width ? `${st.width}×${st.height}` : '—'),
      row('Images/s', st.fps ? String(Math.round(st.fps)) : '—'),
      row('Débit', fmtBitrate(st.bitrate)),
      row('Codec', `${codecLabel(st.codec)}${st.hw === true ? ' · matériel' : ''}`),
      row('Latence', st.latencyMs ? `~${st.latencyMs} ms` : '—'),
      row('Ping', st.rtt != null ? `${Math.round(st.rtt * 1000)} ms` : '—'),
      row('Pertes', `${((st.loss || 0) * 100).toFixed(1)} %`),
      row('Connexion', path),
    );
  }
}

const row = (k, v) => h('div', {}, h('span', { text: k }), h('b', { text: v }));

function applyStatsVisibility() {
  $('#w-stats').hidden = !V.prefs.stats;
  $('#w-stats-btn').classList.toggle('on', V.prefs.stats);
}

// ================================================================== chat
function addChat({ name, text, host = false, self = false }) {
  if (!text) return;
  const log = $('#w-chat-log');
  log.querySelector('.chat-empty')?.remove();
  log.append(h('div', { class: `msg${self ? ' self' : ''}${host ? ' host' : ''}` }, h('b', { text: self ? 'Toi' : name }), h('span', { text })));
  while (log.children.length > 200) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
  if (!self && $('#w-chat-drawer').hidden) {
    V.unread++;
    $('#w-chat .badge').hidden = false;
    const t = h('div', { class: 'chat-toast' }, h('b', { text: name }), h('span', { text }));
    $('#chat-toasts').append(t);
    setTimeout(() => t.classList.add('out'), 5000);
    setTimeout(() => t.remove(), 5600);
    while ($('#chat-toasts').children.length > 3) $('#chat-toasts').firstChild.remove();
  }
}

function toggleChat(force) {
  const drawer = $('#w-chat-drawer');
  const open = force ?? drawer.hidden;
  drawer.hidden = !open;
  $('#view-watch').classList.toggle('chat-open', open);
  $('#w-chat').classList.toggle('on', open);
  if (open) {
    V.unread = 0;
    $('#w-chat .badge').hidden = true;
    $('#chat-toasts').replaceChildren();
    const log = $('#w-chat-log');
    log.scrollTop = log.scrollHeight;
  }
  showControls(true);
}

// ============================================================ controls
let idleTimer = null;
function showControls(sticky = false) {
  const player = $('#player');
  player.classList.remove('idle');
  clearTimeout(idleTimer);
  if (sticky) return;
  idleTimer = setTimeout(() => {
    const busy = V.status !== 'live' || !$('#react-picker').hidden || document.querySelector('.menu');
    if (!busy) player.classList.add('idle');
  }, 3500);
}

function toggleControls() {
  const player = $('#player');
  if (player.classList.contains('idle')) showControls();
  else if (V.status === 'live') {
    clearTimeout(idleTimer);
    player.classList.add('idle');
    $('#react-picker').hidden = true;
  }
}

// ================================================================= zoom
const Z = { s: 1, x: 0, y: 0, pointers: new Map(), pinch: null, pan: null, lastTap: 0, tapTimer: null, moved: false };

function applyZoom() {
  const v = video();
  v.style.transform = Z.s === 1 ? '' : `translate(${Z.x}px, ${Z.y}px) scale(${Z.s})`;
  $('#player').classList.toggle('zoomed', Z.s > 1);
}

function clampZoom() {
  const r = $('#stage').getBoundingClientRect();
  Z.s = clamp(Z.s, 1, 5);
  Z.x = clamp(Z.x, r.width - r.width * Z.s, 0);
  Z.y = clamp(Z.y, r.height - r.height * Z.s, 0);
}

function resetZoom() {
  Z.s = 1;
  Z.x = Z.y = 0;
  applyZoom();
}

function zoomAt(px, py, s) {
  const cx = (px - Z.x) / Z.s;
  const cy = (py - Z.y) / Z.s;
  Z.s = s;
  Z.x = px - cx * s;
  Z.y = py - cy * s;
  clampZoom();
  applyZoom();
}

function wireStage() {
  const stage = $('#stage');
  const local = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const startGesture = () => {
    const pts = [...Z.pointers.values()];
    if (pts.length === 2) {
      const [a, b] = pts;
      Z.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: Z.s, cx: ((a.x + b.x) / 2 - Z.x) / Z.s, cy: ((a.y + b.y) / 2 - Z.y) / Z.s };
      Z.pan = null;
    } else if (pts.length === 1) {
      Z.pinch = null;
      Z.pan = { px: pts[0].x, py: pts[0].y, x: Z.x, y: Z.y };
    } else {
      Z.pinch = Z.pan = null;
    }
  };
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture?.(e.pointerId);
    Z.pointers.set(e.pointerId, local(e));
    if (Z.pointers.size === 1) Z.moved = false;
    startGesture();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!Z.pointers.has(e.pointerId)) return;
    const p = local(e);
    Z.pointers.set(e.pointerId, p);
    if (Z.pinch && Z.pointers.size === 2) {
      const [a, b] = [...Z.pointers.values()];
      const s = clamp((Z.pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) || 1)) / Z.pinch.d, 1, 5);
      Z.s = s;
      Z.x = (a.x + b.x) / 2 - Z.pinch.cx * s;
      Z.y = (a.y + b.y) / 2 - Z.pinch.cy * s;
      Z.moved = true;
      clampZoom();
      applyZoom();
    } else if (Z.pan) {
      const dx = p.x - Z.pan.px;
      const dy = p.y - Z.pan.py;
      if (Math.hypot(dx, dy) > 8) Z.moved = true;
      if (Z.s > 1 && Z.moved) {
        Z.x = Z.pan.x + dx;
        Z.y = Z.pan.y + dy;
        clampZoom();
        applyZoom();
      }
    }
  });
  const end = (e) => {
    if (!Z.pointers.has(e.pointerId)) return;
    const p = local(e);
    Z.pointers.delete(e.pointerId);
    startGesture();
    if (Z.s < 1.05 && Z.s !== 1) resetZoom();
    if (e.type === 'pointerup' && !Z.moved && Z.pointers.size === 0) onTap(p);
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('dblclick', (e) => e.preventDefault());
  ['gesturestart', 'gesturechange'].forEach((t) => stage.addEventListener(t, (e) => e.preventDefault()));
}

function onTap(p) {
  const now = Date.now();
  if (now - Z.lastTap < 300) {
    clearTimeout(Z.tapTimer);
    Z.lastTap = 0;
    if (Z.s > 1) resetZoom();
    else zoomAt(p.x, p.y, 2.5);
    return;
  }
  Z.lastTap = now;
  Z.tapTimer = setTimeout(() => {
    if (!$('#react-picker').hidden) $('#react-picker').hidden = true;
    else toggleControls();
  }, 260);
}

// ============================================================= settings
function openSettings() {
  $('#vs-name').value = V.name;
  openDialog($('#dlg-viewer'));
}

function sendPrefs() {
  send({ t: 'pref', quality: V.prefs.quality, game: V.prefs.game, voice: V.prefs.voice });
}

function wireSettings() {
  segmented($('#vs-quality'), Object.entries(VIEWER_QUALITY).map(([id, q]) => ({ id, label: q.label })), V.prefs.quality, (v) => {
    V.prefs.quality = v;
    savePrefs();
    sendPrefs();
  });
  const latencyRow = $('#vs-latency-row');
  latencyRow.hidden = !supportsJitterTarget();
  segmented($('#vs-latency'), [{ id: 'auto', label: 'Auto' }, { id: 'min', label: 'Minimale' }, { id: 'smooth', label: 'Fluide' }], V.prefs.latency, (v) => {
    V.prefs.latency = v;
    savePrefs();
    applyLatency();
  });
  const setFit = segmented($('#vs-fit'), [{ id: 'contain', label: 'Ajuster' }, { id: 'cover', label: 'Remplir' }], V.prefs.fit, (v) => {
    V.prefs.fit = v;
    savePrefs();
    applyFit();
  });
  V.setFitUi = setFit;
  $('#vs-fs-row').hidden = !isIPad;
  segmented($('#vs-fs'), [{ id: 'app', label: 'StreamCast' }, { id: 'native', label: 'Lecteur iPad' }], V.prefs.fsMode, (v) => {
    V.prefs.fsMode = v;
    savePrefs();
  });
  $('#w-notify-btn').addEventListener('click', turnOnPush);
  $('#vs-push').addEventListener('change', async (e) => {
    if (e.target.checked) await turnOnPush();
    else {
      await disablePush(V.code);
      renderNotify();
    }
  });

  const call = $('#vs-call');
  call.checked = V.prefs.call;
  call.addEventListener('change', () => {
    V.prefs.call = call.checked;
    savePrefs();
  });
  const stats = $('#vs-stats');
  stats.checked = V.prefs.stats;
  stats.addEventListener('change', () => {
    V.prefs.stats = stats.checked;
    savePrefs();
    applyStatsVisibility();
  });
  for (const key of ['game', 'voice']) {
    const input = $(`#vs-${key}`);
    const out = input.closest('.range-row').querySelector('output');
    input.value = Math.round(V.prefs[key] * 100);
    out.textContent = `${input.value} %`;
    let pending = null;
    input.addEventListener('input', () => {
      V.prefs[key] = input.value / 100;
      out.textContent = `${input.value} %`;
      clearTimeout(pending);
      pending = setTimeout(sendPrefs, 80);
    });
    input.addEventListener('change', savePrefs);
  }
  $('#vs-name').addEventListener('change', (e) => {
    V.name = e.target.value.trim().slice(0, 32);
    storage.set('name', V.name);
    send({ t: 'hello', name: V.name });
  });
}

// ======================================================== notifications
function renderNotify() {
  const box = $('#w-notify');
  const btn = $('#w-notify-btn');
  const hint = $('#w-notify-hint');
  const show = V.status === 'waiting' && (pushSupported() || pushNeedsInstall());
  box.hidden = !show;
  if (show) {
    const on = pushEnabled(V.code);
    const denied = !pushNeedsInstall() && pushSupported() && Notification.permission === 'denied';
    btn.hidden = on || denied;
    hint.textContent = on
      ? `Notification activée : tu seras prévenu au prochain live de ${HOST_NAME}`
      : denied
        ? 'Notifications bloquées : autorise-les dans les réglages de l’appareil'
        : '';
  }
  const group = $('#vs-push-group');
  group.hidden = !pushSupported() && !pushNeedsInstall();
  const sw = $('#vs-push');
  sw.checked = pushEnabled(V.code);
  sw.disabled = pushNeedsInstall();
  const settingsHint = $('#vs-push-hint');
  settingsHint.hidden = !pushNeedsInstall();
  settingsHint.textContent = 'Sur iPad et iPhone, ajoute d’abord StreamCast à l’écran d’accueil (Partager › Sur l’écran d’accueil), puis ouvre-le depuis l’icône.';
}

function showInstallSteps() {
  $('#install-notify-step').hidden = false;
  $('#install-ios').hidden = false;
  $('#install-desktop').hidden = true;
  openDialog($('#dlg-install'));
}

// From a tap: the permission prompt needs it.
async function turnOnPush() {
  if (pushNeedsInstall()) {
    showInstallSteps();
    return false;
  }
  try {
    await enablePush(V.code);
    toast(`Tu seras prévenu quand ${HOST_NAME} lance un live`, { icon: 'bell' });
    return true;
  } catch (err) {
    const why = err?.message;
    toast(
      why === 'denied'
        ? 'Notifications refusées : autorise-les dans les réglages de l’appareil'
        : 'Impossible d’activer les notifications pour le moment',
      { type: 'warn' },
    );
    return false;
  } finally {
    renderNotify();
  }
}

// ================================================================ leave
function leave() {
  V.active = false;
  V.run++;
  send({ t: 'leave' });
  closePc();
  V.mic?.stop();
  V.mic = null;
  V.micOn = false;
  V.micBlocked = false;
  V.micMeter?.stop?.();
  V.micMeter = null;
  $('#player').classList.remove('host-talking');
  renderMic();
  const v = video();
  v.srcObject = null;
  if (fullscreenElement()) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  releaseWakeLock();
  toggleChat(false);
  $('#w-chat-log').replaceChildren(h('p', { class: 'chat-empty', text: 'Aucun message pour l’instant' }));
  resetZoom();
  history.replaceState(null, '', '/');
  onExit();
}

async function requestWakeLock() {
  try {
    if (!V.active || document.hidden || !navigator.wakeLock || V.status === 'waiting') return;
    if (V.wakeLock && !V.wakeLock.released) return;
    V.wakeLock = await navigator.wakeLock.request('screen');
  } catch {}
}

function releaseWakeLock() {
  V.wakeLock?.release?.().catch?.(() => {});
  V.wakeLock = null;
}

// ================================================================= init
export function initViewer({ show, exit }) {
  showView = show;
  onExit = exit;
  const v = video();
  v.autoPictureInPicture = true;
  v.disablePictureInPicture = false;

  wireStage();
  wireSettings();
  requestAnimationFrame(micLevelLoop);

  $('#w-leave').addEventListener('click', leave);
  $('#w-mic').addEventListener('click', toggleMic);
  $('#w-chat').addEventListener('click', () => toggleChat());
  $('#w-chat-close').addEventListener('click', () => toggleChat(false));
  $('#w-fit').addEventListener('click', () => {
    V.prefs.fit = V.prefs.fit === 'cover' ? 'contain' : 'cover';
    savePrefs();
    applyFit();
    V.setFitUi?.(V.prefs.fit);
  });
  $('#w-settings').addEventListener('click', openSettings);
  $('#w-stats-btn').addEventListener('click', () => {
    V.prefs.stats = !V.prefs.stats;
    $('#vs-stats').checked = V.prefs.stats;
    savePrefs();
    applyStatsVisibility();
    if (V.stats) renderQuality(V.stats);
  });
  $('#w-fs').addEventListener('click', toggleFullscreen);
  const pip = $('#w-pip');
  pip.addEventListener('click', togglePip);
  pip.hidden = !pipSupported();
  $('#w-unmute').addEventListener('click', unmute);
  // Any tap on the player turns the sound on when it started muted.
  const tapUnmute = () => {
    if (!$('#w-unmute').hidden) unmute();
    if (V.ac?.state === 'suspended') V.ac.resume().catch(() => {});
  };
  $('#player').addEventListener('touchend', tapUnmute, { passive: true });
  $('#player').addEventListener('click', tapUnmute);

  const picker = $('#react-picker');
  picker.replaceChildren(...REACTIONS.map((emoji) => h('button', { type: 'button', text: emoji, 'aria-label': emoji })));
  picker.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    floatReaction($('#react-layer'), b.textContent);
    send({ t: 'react', emoji: b.textContent });
    showControls();
  });
  $('#w-react').addEventListener('click', () => {
    picker.hidden = !picker.hidden;
    showControls(!picker.hidden);
  });

  $('#w-chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#w-chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addChat({ name: V.name || 'Toi', text, self: true });
    send({ t: 'chat', text: text.slice(0, 500) });
  });

  $('#player').addEventListener('pointermove', (e) => e.pointerType === 'mouse' && showControls());
  $('#w-controls').addEventListener('pointerdown', () => showControls());

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  v.addEventListener('webkitendfullscreen', () => setTimeout(resumePlayback, 300));
  v.addEventListener('leavepictureinpicture', () => setTimeout(resumePlayback, 300));
  v.addEventListener('webkitpresentationmodechanged', () => setTimeout(resumePlayback, 300));
  v.addEventListener('enterpictureinpicture', () => pip.classList.add('on'));
  v.addEventListener('leavepictureinpicture', () => pip.classList.remove('on'));

  document.addEventListener('visibilitychange', () => {
    if (!V.active || document.hidden) return;
    requestWakeLock();
    resumePlayback();
    if (V.status === 'live' && (!V.pc || ['failed', 'closed', 'disconnected'].includes(V.pc.connectionState))) lost();
  });

  window.addEventListener('keydown', (e) => {
    if (!V.active || e.target.closest('input, textarea')) return;
    if (e.key === 'f') toggleFullscreen();
    if (e.key === 'm') toggleMic();
    if (e.key === 'p') togglePip();
  });

  if (isIOS) document.documentElement.classList.add('ios');
}

export const isWatching = () => V.active;
