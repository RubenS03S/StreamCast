import { HOST_NAME, LADDER, PRESETS, CODECS, VIEWER_QUALITY, bitrateFor, presetById } from './config.js';
import { $, h, icon, setIcon, storage, copyText, fmtBitrate, fmtDuration, heightLabel, clamp, later, every, wait } from './util.js';
import { api, getIceServers, Poller } from './api.js';
import { Mixer, chime } from './audio.js';
import {
  waitIceGathering, tuneAnswerForSender, applyCodecPreferences, encodeCaps, chooseCodec, codecLabel, senderStats,
} from './rtc.js';
import { canCaptureScreen, isChromium } from './device.js';
import { toast, openDialog, closeDialog, confirmDialog, openMenu, segmented, showQr, notify, floatReaction } from './ui.js';
import { hdrDisplay, canProcessVideo, createColorPipeline, measureSdrScale } from './hdr.js';

const DEFAULT_SETTINGS = {
  preset: 'auto',
  codec: 'auto',
  micOn: true,
  gameOn: true,
  digits: 3,
  approve: false,
  sounds: true,
  notify: false,
  micDevice: '',
  noise: true,
  micVolume: 1,
  gameVolume: 1,
  sinkId: '',
  viewerVolume: 1,
  preview: true,
  hdr: 'auto',
  hdrStrength: 0.5,
};

const S = {
  live: false,
  mode: canCaptureScreen ? 'screen' : 'camera',
  facing: 'user',
  code: null,
  token: null,
  video: null, // raw capture: settings, stats, end of sharing
  out: null, // what is sent and shown: the capture, or its colour-corrected copy
  pipe: null,
  hdr: { measured: null, measuring: false, slow: 0, reduced: false },
  game: null,
  mic: null,
  micMeter: null,
  mixer: null,
  enc: { mimes: [], hw: {} },
  peers: new Map(),
  approved: new Set(),
  poller: null,
  stopStats: null,
  startedAt: 0,
  sourceLost: false,
  gameMeter: null,
  talking: false,
  talkUntil: 0,
  capture: { last: null, fps: 0, frames: 0 },
  settings: { ...DEFAULT_SETTINGS, ...storage.get('hostSettings', {}) },
};

const saveSettings = () => storage.set('hostSettings', S.settings);
const link = () => `${location.origin}/${S.code}`;
const preset = () => presetById(S.settings.preset);
const codecChoiceMime = () => CODECS.find((c) => c.id === S.settings.codec)?.mime || null;

// ============================================================ Peer (1 viewer)
class Peer {
  constructor(id, info) {
    this.id = id;
    this.clientId = info.clientId || id;
    this.name = info.name || info.caps?.device || 'Spectateur';
    this.caps = info.caps || {};
    this.device = this.caps.device || '';
    this.pref = { quality: 'auto', game: 1, voice: 1 };
    this.state = 'connecting';
    this.level = 0;
    this.ad = null;
    this.micOn = false;
    this.params = Promise.resolve();
    this.stats = null;
    this.viewerStats = null;
    this.thumb = null;
    this.thumbAt = 0;
    this.speaking = false;
    this.speakUntil = 0;
  }

  send(msg) {
    if (this.dc?.readyState === 'open') {
      try {
        this.dc.send(JSON.stringify(msg));
      } catch {}
    }
  }

  async connect() {
    const { servers } = await getIceServers();
    const pc = (this.pc = new RTCPeerConnection({ iceServers: servers, bundlePolicy: 'max-bundle' }));
    this.dc = pc.createDataChannel('sc', { ordered: true });
    this.dc.onopen = () => this.onOpen();
    this.dc.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(e.data));
      } catch {}
    };

    this.output = S.mixer.createOutput(this.id);
    this.output.setGains(this.pref.game, this.pref.voice);
    const stream = new MediaStream([S.out, this.output.track]);
    const t = this.target();
    this.vt = pc.addTransceiver(S.out, {
      direction: 'sendonly',
      streams: [stream],
      sendEncodings: [{ maxBitrate: Math.round(t.maxBitrate), maxFramerate: t.fps, scaleResolutionDownBy: t.scale, priority: 'high', networkPriority: 'high' }],
    });
    this.at = pc.addTransceiver(this.output.track, { direction: 'sendonly', streams: [stream] });
    this.mt = pc.addTransceiver('audio', { direction: 'recvonly' });
    this.codec = chooseCodec(codecChoiceMime(), S.enc, this.caps);
    applyCodecPreferences(this.vt, this.codecOrder());

    pc.ontrack = (e) => {
      if (e.transceiver === this.mt) this.attachVoice(e.track);
    };
    pc.onconnectionstatechange = () => this.onState();

    await pc.setLocalDescription(await pc.createOffer());
    await waitIceGathering(pc);
    this.programMid = this.at.mid;
    await api('send', { code: S.code, token: S.token, from: 'host', to: this.id, data: { type: 'offer', sdp: pc.localDescription.sdp } });
    this.cancelTimeout = later(() => this.state === 'connecting' && this.close('timeout'), 35000);
  }

  codecOrder() {
    return [this.codec, 'video/H264', 'video/AV1', 'video/VP9', 'video/VP8'];
  }

  async onAnswer(sdp) {
    if (!this.pc || this.pc.signalingState !== 'have-local-offer') return;
    const startKbps = Math.round(Math.min(6000, this.target().maxBitrate / 1000 / 2));
    await this.pc.setRemoteDescription({ type: 'answer', sdp: tuneAnswerForSender(sdp, { programMid: this.programMid, startKbps }) });
    await this.applyParams();
  }

  attachVoice(track) {
    this.audioEl = h('audio', { autoplay: true });
    this.audioEl.srcObject = new MediaStream([track]);
    this.audioEl.volume = clamp(S.settings.viewerVolume, 0, 1);
    if (S.settings.sinkId && this.audioEl.setSinkId) this.audioEl.setSinkId(S.settings.sinkId).catch(() => {});
    document.body.append(this.audioEl);
    this.audioEl.play().catch(() => {});
    try {
      this.voiceMeter = S.mixer.meter(track);
    } catch {}
  }

  onOpen() {
    this.send({ t: 'hello', name: HOST_NAME, ...hostState() });
  }

  onState() {
    const st = this.pc?.connectionState;
    if (st === 'connected') {
      this.cancelDisc?.();
      if (this.state !== 'live') {
        this.state = 'live';
        this.cancelTimeout?.();
        toast(`${this.name} regarde le live`, { icon: 'users' });
        if (S.settings.sounds) chime('join');
        notify('StreamCast', `${this.name} regarde le live`);
      }
      renderViewers();
    } else if (st === 'disconnected') {
      this.cancelDisc = later(() => this.pc?.connectionState !== 'connected' && this.close('lost'), 10000);
    } else if (st === 'failed') {
      this.close('lost');
    }
  }

  onMessage(m) {
    switch (m.t) {
      case 'hello':
        if (m.name) this.name = String(m.name).slice(0, 32);
        renderViewers();
        break;
      case 'chat':
        if (typeof m.text !== 'string' || !m.text.trim()) return;
        receiveChat({ name: this.name, text: m.text.slice(0, 500) }, this);
        break;
      case 'react':
        if (typeof m.emoji !== 'string') return;
        floatReaction($('#host-react-layer'), m.emoji.slice(0, 4));
        broadcast({ t: 'react', emoji: m.emoji.slice(0, 4), name: this.name }, this);
        break;
      case 'mic':
        this.micOn = !!m.on;
        renderViewers();
        break;
      case 'stats':
        this.viewerStats = { ...m, at: Date.now() };
        break;
      case 'thumb':
        if (typeof m.url === 'string' && m.url.startsWith('data:image/jpeg;base64,') && m.url.length < 80000) {
          this.thumb = m.url;
          this.thumbAt = Date.now();
          renderViewerView();
        }
        break;
      case 'pref': {
        const quality = VIEWER_QUALITY[m.quality] ? m.quality : this.pref.quality;
        const changed = quality !== this.pref.quality;
        this.pref = { quality, game: clamp(Number(m.game) || 0, 0, 2), voice: clamp(Number(m.voice) || 0, 0, 2) };
        this.output?.setGains(this.pref.game, this.pref.voice);
        if (changed) {
          this.level = 0;
          this.ad = null;
          this.applyParams();
        }
        break;
      }
      case 'answer':
        this.onAnswer(m.sdp).catch((e) => console.warn('renegotiation', e));
        break;
      case 'leave':
        this.close('left');
        break;
    }
  }

  // Encoding target for this viewer: preset ∩ viewer preference ∩ adaptive level.
  target() {
    const p = preset();
    const srcH = outHeight();
    const vq = VIEWER_QUALITY[this.pref.quality] || VIEWER_QUALITY.auto;
    let cap = Math.min(p.maxHeight, srcH);
    let fps = p.fps;
    let maxBitrate = p.maxBitrate;
    if (vq.cap === 'screen' && p.adaptive) cap = Math.min(cap, this.screenCap());
    else if (typeof vq.cap === 'number') cap = Math.min(cap, vq.cap);
    if (vq.fps) fps = Math.min(fps, vq.fps);
    if (vq.maxBitrate) maxBitrate = Math.min(maxBitrate, vq.maxBitrate);
    const ladder = [cap, ...LADDER.filter((x) => x < cap - 40)];
    const idx = p.adaptive ? clamp(this.level, 0, ladder.length - 1) : 0;
    const height = ladder[idx];
    if (p.adaptive || vq.cap) maxBitrate = Math.min(maxBitrate, bitrateFor(height, fps, this.codec) * 1.5);
    return { height, fps, maxBitrate, scale: Math.max(1, srcH / height), ladder };
  }

  // Smallest ladder step that still fills the viewer's screen (16:9, landscape).
  screenCap() {
    const s = this.caps.screen;
    if (!s?.w || !s?.h) return 2160;
    const long = Math.max(s.w, s.h);
    const short = Math.min(s.w, s.h);
    const need = Math.min(short, (long * 9) / 16) * 0.95;
    return [...LADDER].reverse().find((x) => x >= need) || 2160;
  }

  applyParams() {
    this.params = this.params.then(() => this._applyParams()).catch((e) => console.warn('setParameters', e));
    return this.params;
  }

  async _applyParams() {
    const sender = this.vt?.sender;
    if (!sender || !this.pc || this.pc.connectionState === 'closed') return;
    const t = this.target();
    const p = preset();
    for (const withDegradation of [true, false]) {
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      const e = params.encodings[0];
      e.active = true;
      e.maxBitrate = Math.round(t.maxBitrate);
      e.maxFramerate = t.fps;
      e.scaleResolutionDownBy = t.scale;
      e.priority = 'high';
      e.networkPriority = 'high';
      if (withDegradation) params.degradationPreference = p.degradation;
      try {
        await sender.setParameters(params);
        return;
      } catch (err) {
        if (!withDegradation) throw err;
      }
    }
  }

  // Auto mode: keeps 60 FPS by stepping the resolution cap down when the
  // encoder, the network or the viewer's decoder can't keep up, and back up
  // once things have been healthy for a while.
  adapt(st) {
    const p = preset();
    if (!p.adaptive || !st) return;
    const now = Date.now();
    const t = this.target();
    const vs = this.viewerStats && now - (this.viewerStats.at || 0) < 5000 ? this.viewerStats : null;
    const a = (this.ad ||= { cpu: 0, bw: 0, loss: 0, viewer: 0, good: 0, last: now, hold: 0, downs: [] });
    const src = Math.min(st.srcFps || t.fps, t.fps);
    a.cpu = st.limitation === 'cpu' ? a.cpu + 1 : 0;
    a.bw = st.limitation === 'bandwidth' && st.fps < src * 0.85 ? a.bw + 1 : 0;
    a.loss = (st.loss ?? 0) > 0.06 ? a.loss + 1 : 0;
    const viewerBad = !!vs && st.fps > 20 && (vs.fps < st.fps * 0.8 || vs.dropRate > 0.08 || vs.newFreezes > 0);
    a.viewer = viewerBad ? a.viewer + 1 : 0;
    // The iPad's own connection (often Wi-Fi far from the box): lighter
    // frames get through a weak link with fewer stutters.
    const viewerNet = !!vs && ((vs.loss ?? 0) > 0.04 || (vs.jitterMs ?? 0) > 150);
    a.net = viewerNet ? (a.net || 0) + 1 : 0;

    if ((a.cpu >= 3 || a.bw >= 3 || a.loss >= 4 || a.viewer >= 3 || a.net >= 4) && this.level < t.ladder.length - 1 && now - a.last > 2500) {
      this.level++;
      a.downs = a.downs.filter((x) => now - x < 120000);
      a.downs.push(now);
      a.hold = now + Math.min(120000, 15000 * a.downs.length);
      Object.assign(a, { cpu: 0, bw: 0, loss: 0, viewer: 0, net: 0, good: 0, last: now });
      this.applyParams();
      return;
    }
    const healthy = st.limitation === 'none' && (st.loss ?? 0) < 0.02 && !viewerBad && !viewerNet;
    a.good = healthy ? a.good + 1 : 0;
    if (this.level > 0 && a.good >= 10 && now > a.hold) {
      const next = t.ladder[this.level - 1];
      if (!st.available || st.available >= bitrateFor(next, t.fps, this.codec) * 0.6) {
        this.level--;
        a.good = 0;
        a.last = now;
        this.applyParams();
      }
    }
  }

  async setCodec(mime) {
    this.codec = chooseCodec(mime, S.enc, this.caps);
    this.level = 0;
    this.ad = null;
    const sender = this.vt?.sender;
    if (!sender) return;
    const params = sender.getParameters();
    const codec = params.codecs?.find((c) => c.mimeType.toLowerCase() === this.codec.toLowerCase());
    if (codec && params.encodings?.length) {
      try {
        params.encodings[0].codec = { mimeType: codec.mimeType, clockRate: codec.clockRate, sdpFmtpLine: codec.sdpFmtpLine };
        await sender.setParameters(params);
        if (sender.getParameters().encodings?.[0]?.codec) {
          await this.applyParams();
          return;
        }
      } catch {}
    }
    await this.renegotiate();
  }

  async renegotiate() {
    if (!this.pc || this.pc.signalingState !== 'stable' || this.dc?.readyState !== 'open') return;
    applyCodecPreferences(this.vt, this.codecOrder());
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.send({ t: 'offer', sdp: this.pc.localDescription.sdp });
  }

  close(reason, { silent = false } = {}) {
    if (this.state === 'closed') return;
    const wasLive = this.state === 'live';
    this.state = 'closed';
    this.cancelTimeout?.();
    this.cancelDisc?.();
    try {
      this.pc?.close();
    } catch {}
    this.output?.destroy();
    this.voiceMeter?.stop?.();
    this.audioEl?.remove();
    S.peers.delete(this.id);
    renderViewers();
    if (!silent && wasLive) {
      toast(`${this.name} a quitté le live`, { icon: 'users' });
      if (S.settings.sounds) chime('leave');
    }
    if (!silent && reason === 'timeout') toast(`Connexion impossible avec ${this.name}`, { type: 'warn' });
  }
}

// Connection quality of a spectateur, as measured on both ends.
function netQuality(peer) {
  const st = peer.stats;
  const vs = peer.viewerStats && Date.now() - peer.viewerStats.at < 6000 ? peer.viewerStats : null;
  if (!st) return null;
  const loss = Math.max(st.loss ?? 0, vs?.loss ?? 0);
  const rtt = (st.rtt ?? 0) * 1000;
  const jitter = vs?.jitterMs ?? 0;
  if (loss > 0.05 || rtt > 250 || jitter > 150 || (vs?.newFreezes ?? 0) > 0 || (vs?.dropRate ?? 0) > 0.1) return 'faible';
  if (loss > 0.01 || rtt > 100 || jitter > 60) return 'moyen';
  return 'bon';
}

// ================================================================ helpers
const wantThumbs = () =>
  S.live && (!!mini.win || (document.visibilityState === 'visible' && S.settings.preview));

function hostState() {
  const p = preset();
  return {
    mic: !!(S.settings.micOn && S.mic),
    game: !!(S.settings.gameOn && S.game),
    paused: S.sourceLost,
    preset: p.id,
    presetLabel: p.label,
    mode: S.mode,
    thumbs: wantThumbs() ? 2500 : 0,
  };
}

function broadcast(msg, except = null) {
  for (const peer of S.peers.values()) if (peer !== except) peer.send(msg);
}

const broadcastState = () => broadcast({ t: 'state', ...hostState() });

// ================================================================ capture
function displayOptions() {
  const p = preset();
  return {
    video: { frameRate: { ideal: p.fps, max: p.fps }, displaySurface: 'monitor', cursor: 'always' },
    audio: S.settings.gameOn
      ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
          sampleRate: 48000,
          suppressLocalAudioPlayback: false,
          restrictOwnAudio: true,
        }
      : false,
    systemAudio: 'include',
    windowAudio: 'system',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  };
}

async function captureSource() {
  if (S.mode === 'screen') {
    $('#picker-hint').hidden = false;
    try {
      return await navigator.mediaDevices.getDisplayMedia(displayOptions());
    } finally {
      $('#picker-hint').hidden = true;
    }
  }
  const p = preset();
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: S.facing, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: Math.min(60, p.fps) } },
    audio: false,
  });
}

function useCapture(stream) {
  const old = [S.video, S.game];
  const oldPipe = S.pipe;
  S.pipe = null;
  S.out = null;
  S.video = stream.getVideoTracks()[0];
  S.game = stream.getAudioTracks()[0] || null;
  S.video.contentHint = S.mode === 'camera' ? 'motion' : preset().hint;
  S.video.addEventListener('ended', onSourceEnded);
  S.video.addEventListener('mute', renderChecks);
  S.video.addEventListener('unmute', renderChecks);
  S.game?.addEventListener('ended', () => {
    if (S.game?.readyState === 'ended') {
      S.game = null;
      S.mixer.setGameTrack(null);
      renderChecks();
    }
  });
  S.mixer.setGameTrack(S.game);
  S.gameMeter?.stop?.();
  S.gameMeter = S.game ? S.mixer.meter(S.game) : null;
  S.capture = { last: null, fps: 0, frames: 0, size: sizeOf(S.video) };
  S.mixer.setGameVolume(S.settings.gameOn ? S.settings.gameVolume : 0);
  applyColor();
  oldPipe?.stop();
  for (const t of old) {
    if (!t || t === S.video || t === S.game) continue;
    t.removeEventListener('ended', onSourceEnded);
    t.stop();
  }
  S.sourceLost = false;
  $('#source-lost').hidden = true;
  updateSourceInfo();
  renderChecks();
  broadcastState();
}

// ============================================================ couleurs HDR
// Correction factor for an HDR desktop (1 = none).
function hdrK() {
  if (S.mode !== 'screen' || S.settings.hdr === 'off') return 1;
  if (S.settings.hdr === 'manual') return 1 + 3 * clamp(S.settings.hdrStrength, 0, 1);
  const m = S.hdr.measured;
  return m?.ok && m.k >= 1.08 ? m.k : 1;
}

// While correcting, 4K is brought down to 1440p on the GPU (what the iPad
// shows anyway) unless a 4K or text preset is chosen.
const pipeMaxHeight = () => (S.hdr.reduced ? 1080 : ['4k', 'text'].includes(preset().id) ? 0 : 1440);

// A correction slower than ~14 ms per frame cannot hold 60 FPS: work at
// 1080p instead, and if that is still too slow, say so.
function checkPipeSpeed() {
  const pipe = S.pipe;
  if (!pipe || !pipe.fps) {
    S.hdr.slow = 0;
    return;
  }
  S.hdr.slow = pipe.ms > 14 ? S.hdr.slow + 1 : 0;
  if (S.hdr.slow >= 5 && !S.hdr.reduced) {
    S.hdr.reduced = true;
    S.hdr.slow = 0;
    pipe.setMaxHeight(pipeMaxHeight());
  }
}

const outHeight = () => S.pipe?.size?.height || S.video?.getSettings().height || 1080;

function setOut(track) {
  if (!track || S.out === track) return;
  S.out = track;
  S.out.contentHint = S.video?.contentHint || '';
  $('#preview').srcObject = new MediaStream([S.out]);
  if (mini.video) mini.video.srcObject = new MediaStream([S.out]);
  for (const peer of S.peers.values()) {
    peer.vt?.sender.replaceTrack(S.out).then(() => peer.applyParams()).catch(() => {});
  }
}

// Starts, updates or removes the GPU colour correction as needed.
function applyColor() {
  if (!S.video) return;
  const k = hdrK();
  const need = k > 1.001 && canProcessVideo() && S.video.readyState === 'live';
  if (need && !S.pipe) {
    try {
      S.pipe = createColorPipeline(S.video, { k, maxHeight: pipeMaxHeight() });
      S.pipe.onSize = () => {
        for (const peer of S.peers.values()) peer.applyParams();
      };
      setOut(S.pipe.track);
    } catch (err) {
      console.warn('colour pipeline', err);
      S.pipe = null;
      setOut(S.video);
    }
  } else if (need) {
    S.pipe.setK(k);
    S.pipe.setMaxHeight(pipeMaxHeight());
  } else if (S.pipe) {
    const old = S.pipe;
    S.pipe = null;
    setOut(S.video);
    setTimeout(() => old.stop(), 800);
  } else {
    setOut(S.video);
  }
  renderChecks();
}

async function calibrate({ quiet = false } = {}) {
  if (!S.live || !S.video || S.mode !== 'screen' || S.hdr.measuring) return;
  S.hdr.measuring = true;
  renderChecks();
  const m = await measureSdrScale(S.video);
  S.hdr.measuring = false;
  S.hdr.measured = m;
  applyColor();
  if (m.ok && m.k >= 1.08) toast('Écran HDR : couleurs corrigées pour le spectateur', { icon: 'check' });
  else if (!quiet) {
    toast(m.ok ? 'Couleurs correctes, aucune correction nécessaire' : 'Mesure impossible : garde StreamCast visible sur l’écran partagé', {
      type: m.ok ? 'info' : 'warn',
    });
  }
}

const sizeOf = (track) => {
  const s = track?.getSettings() || {};
  return `${s.width}x${s.height}`;
};

function onSourceEnded() {
  if (!S.live || S.video?.readyState !== 'ended') return;
  S.sourceLost = true;
  $('#source-lost').hidden = false;
  broadcastState();
  renderChecks();
  renderMini();
  if (S.settings.sounds) chime('alert');
  notify('StreamCast', 'Le partage d’écran s’est arrêté : reviens sur StreamCast pour le reprendre');
}

async function changeSource() {
  try {
    useCapture(await captureSource());
  } catch (err) {
    if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') toast('Impossible de capturer la source', { type: 'warn' });
  }
}

async function switchCamera() {
  S.facing = S.facing === 'user' ? 'environment' : 'user';
  S.video?.stop();
  await changeSource();
}

// ============================================================ checklist
// Live check of everything that usually breaks screen streaming: frames
// arriving, whole screen shared, PC sound captured, mic, GPU encoding, echo.
function setCheck(id, state, value, { hidden = false } = {}) {
  const row = $(`#${id}`);
  row.hidden = hidden;
  row.dataset.state = state;
  row.querySelector('.check-val').textContent = value;
}

// Frames per second actually produced by the capture.
function measureCapture() {
  const c = S.capture;
  const st = S.video?.stats;
  const now = performance.now();
  if (st && typeof st.totalFrames === 'number') {
    if (c.last) c.fps = (st.totalFrames - c.last.frames) / ((now - c.last.t) / 1000);
    c.last = { t: now, frames: st.totalFrames };
  } else {
    if (c.last) c.fps = (c.frames - c.last.frames) / ((now - c.last.t) / 1000);
    c.last = { t: now, frames: c.frames };
  }
  const size = sizeOf(S.video);
  if (size !== c.size) {
    // The game changed the screen resolution: re-fit every encoder to it.
    c.size = size;
    for (const peer of S.peers.values()) peer.applyParams();
  }
}

function renderChecks() {
  if (!S.live || !S.video) return;
  const s = S.video.getSettings();
  const screen = S.mode === 'screen';
  const fps = Math.round(S.capture.fps || 0);

  if (S.sourceLost) setCheck('chk-image', 'bad', 'Partage arrêté');
  else if (S.video.muted) setCheck('chk-image', 'warn', 'En pause (fenêtre réduite ?)');
  else setCheck('chk-image', 'ok', `${s.width || '?'}×${s.height || '?'}${fps ? ` · ${fps} FPS` : ''}`);

  const surface = s.displaySurface;
  const partial = screen && (surface === 'window' || surface === 'browser');
  setCheck('chk-surface', partial ? 'warn' : 'ok',
    partial ? `Seulement ${surface === 'window' ? 'une fenêtre' : 'un onglet'} : Google et tes autres apps ne seront pas visibles` : 'Tout ce que tu fais est visible',
    { hidden: !screen });
  $('#btn-surface-fix').hidden = !partial;

  if (!screen) setCheck('chk-audio', 'off', '', { hidden: true });
  else if (!S.settings.gameOn) setCheck('chk-audio', 'off', 'Coupé');
  else if (S.game) setCheck('chk-audio', 'ok', 'Partagé');
  else setCheck('chk-audio', 'warn', 'Non partagé : choisis Écran entier et coche Partager l’audio du système');
  $('#btn-audio-retry').hidden = !(screen && S.settings.gameOn && !S.game);

  const micOn = !!(S.settings.micOn && S.mic);
  setCheck('chk-mic', micOn ? 'ok' : 'off', micOn ? 'Activé' : 'Coupé');

  const live = [...S.peers.values()].find((p) => p.state === 'live' && p.stats?.codec);
  if (live) {
    const st = live.stats;
    setCheck('chk-encoder', st.hw === false ? 'warn' : 'ok',
      st.hw === false ? `Processeur · ${codecLabel(st.codec)} (carte graphique non utilisée)` : `Carte graphique · ${codecLabel(st.codec)}`);
  } else {
    const hw = Object.entries(S.enc.hw || {}).filter(([, v]) => v).map(([m]) => codecLabel(m));
    setCheck('chk-encoder', hw.length ? 'ok' : 'wait', hw.length ? `Carte graphique prête · ${hw.join(', ')}` : 'Vérifié dès qu’un spectateur se connecte');
  }

  const showHdr = screen && (hdrDisplay() || S.settings.hdr !== 'auto' || !!S.hdr.measured);
  const k = hdrK();
  let hdrState = 'wait';
  let hdrText = 'Écran HDR détecté';
  if (S.hdr.measuring) hdrText = 'Mesure des couleurs…';
  else if (S.settings.hdr === 'off') [hdrState, hdrText] = ['off', 'Correction désactivée'];
  else if (k > 1.001 && !canProcessVideo()) [hdrState, hdrText] = ['warn', 'Correction impossible dans ce navigateur : coupe le HDR avec Win + Alt + B'];
  else if (S.pipe?.error) [hdrState, hdrText] = ['warn', 'Correction indisponible sur cette carte graphique : coupe le HDR avec Win + Alt + B'];
  else if (S.pipe && S.hdr.reduced && S.hdr.slow >= 3) [hdrState, hdrText] = ['warn', `Correction trop lente pour 60 FPS (${S.pipe.fps} FPS) : coupe le HDR avec Win + Alt + B`];
  else if (k > 1.001) [hdrState, hdrText] = ['ok', `Correction active${S.settings.hdr === 'manual' ? ' (manuelle)' : ''}${S.pipe?.fps ? ` · ${S.pipe.fps} FPS` : ''}`];
  else if (S.hdr.measured?.ok) [hdrState, hdrText] = ['ok', 'Couleurs correctes, aucune correction nécessaire'];
  else if (S.hdr.measured) [hdrState, hdrText] = ['warn', 'Mesure impossible : garde StreamCast visible sur l’écran partagé, puis Recalibrer'];
  setCheck('chk-hdr', hdrState, hdrText, { hidden: !showHdr });
  $('#btn-hdr-calib').hidden = !showHdr || S.hdr.measuring || S.settings.hdr !== 'auto';

  setCheck('chk-relay', S.relay ? 'ok' : 'off', S.relay
    ? 'Activé : utilisé seulement si la connexion directe échoue'
    : 'Non activé : connexion directe uniquement', { hidden: S.relay == null });

  const restricted = S.game?.getSettings().restrictOwnAudio;
  setCheck('chk-echo', restricted ? 'ok' : 'warn',
    restricted ? 'La voix des spectateurs ne repart pas vers eux' : 'Non pris en charge : mets Chrome ou Edge à jour',
    { hidden: !S.game });
  $('#chk-browser').hidden = isChromium || !screen;
}

function sourceName() {
  if (S.mode === 'camera') return S.facing === 'user' ? 'Caméra avant' : 'Caméra arrière';
  const surface = S.video?.getSettings().displaySurface;
  return { monitor: 'Écran entier', window: 'Fenêtre', browser: 'Onglet' }[surface] || 'Écran';
}

function updateSourceInfo(measuredFps) {
  if (!S.video) return;
  const s = S.video.getSettings();
  const fps = Math.round(measuredFps || s.frameRate || preset().fps);
  $('#src-info').textContent = `${sourceName()} · ${s.width || '?'}×${s.height || '?'} · ${fps} FPS`;
}

// =================================================================== mic
async function openMic() {
  const base = { echoCancellation: true, noiseSuppression: S.settings.noise, autoGainControl: true, channelCount: 1 };
  const attempt = (deviceId) =>
    navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base });
  let stream;
  try {
    stream = await attempt(S.settings.micDevice);
  } catch (err) {
    if (!S.settings.micDevice || err?.name === 'NotAllowedError') throw err;
    stream = await attempt('');
  }
  S.mic?.stop();
  S.micMeter?.stop?.();
  S.mic = stream.getAudioTracks()[0];
  S.mixer.setMicTrack(S.mic);
  S.mixer.setVoiceVolume(S.settings.micVolume);
  S.micMeter = S.mixer.meter(S.mic);
}

async function setMic(on) {
  if (on && !S.mic) {
    try {
      await openMic();
    } catch {
      toast('Micro inaccessible — autorise le micro dans le navigateur', { type: 'warn', icon: 'mic-off' });
      on = false;
    }
  }
  S.settings.micOn = on;
  saveSettings();
  if (S.mic) S.mic.enabled = on;
  renderMicState();
  broadcastState();
}

function renderMicState() {
  const on = !!(S.settings.micOn && S.mic);
  const btn = $('#ctl-mic');
  btn.setAttribute('aria-pressed', String(on));
  btn.classList.toggle('off', !on);
  setIcon(btn, on ? 'mic' : 'mic-off');
  $('#ctl-mic .ctl-label').textContent = on ? 'Micro activé' : 'Micro coupé';
  renderChecks();
  renderMini();
}

function setGame(on) {
  S.settings.gameOn = on;
  saveSettings();
  S.mixer?.setGameVolume(on ? S.settings.gameVolume : 0);
  const btn = $('#ctl-sys');
  btn.setAttribute('aria-pressed', String(on));
  btn.classList.toggle('off', !on);
  setIcon(btn, on ? 'volume' : 'volume-x');
  $('#ctl-sys .ctl-label').textContent = on ? 'Son du PC' : 'Son du PC coupé';
  renderChecks();
  broadcastState();
}

// ================================================================ preset
async function setPreset(id) {
  S.settings.preset = id;
  saveSettings();
  const p = preset();
  S.pipe?.setMaxHeight(pipeMaxHeight());
  if (S.video && S.video.readyState === 'live') {
    if (S.mode === 'screen') {
      S.video.contentHint = p.hint;
      if (S.out) S.out.contentHint = p.hint;
    }
    try {
      await S.video.applyConstraints({ frameRate: { ideal: p.fps, max: p.fps } });
    } catch {}
  }
  for (const peer of S.peers.values()) {
    peer.level = 0;
    peer.ad = null;
    peer.applyParams();
  }
  renderPresetLabels();
  broadcastState();
}

function renderPresetLabels() {
  const p = preset();
  $('#ctl-preset .ctl-label').textContent = p.label;
  document.querySelectorAll('#preset-chips button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === p.id)));
  $('#preset-desc').textContent = p.desc;
  document.querySelectorAll('#hs-presets .choice').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === p.id)));
}

async function setCodec(id) {
  S.settings.codec = id;
  saveSettings();
  const mime = codecChoiceMime();
  await Promise.all([...S.peers.values()].map((p) => p.setCodec(mime).catch(() => {})));
}

// ================================================================== room
async function createRoom({ fresh = false } = {}) {
  const saved = storage.get('hostRoom', {});
  const r = await api('create', {
    code: fresh ? undefined : saved.code,
    token: saved.token,
    digits: S.settings.digits,
    name: HOST_NAME,
  });
  S.code = r.code;
  S.token = r.token;
  storage.set('hostRoom', { code: r.code, token: r.token });
  renderShare();
  if (r.notified > 0) toast(`Notification envoyée à ${r.notified} appareil${r.notified > 1 ? 's' : ''}`, { icon: 'bell' });
}

async function newCode() {
  const old = { code: S.code, token: S.token };
  try {
    if (S.live) {
      await createRoom({ fresh: true });
      if (old.code && old.code !== S.code) api('end', old).catch(() => {});
      S.poller.payload = { code: S.code, id: 'host', token: S.token };
    } else {
      const saved = storage.get('hostRoom', {});
      storage.set('hostRoom', { token: saved.token });
      renderHomeCode();
    }
    toast(S.live ? `Nouveau code : ${S.code}` : 'Un nouveau code sera créé au prochain live');
  } catch {
    toast('Impossible de changer le code', { type: 'warn' });
  }
  renderSettingsCode();
}

function renderShare() {
  $('#share-code').textContent = S.code || '—';
  $('#share-link').textContent = link().replace(/^https?:\/\//, '');
  renderSettingsCode();
}

function renderHomeCode() {
  const saved = storage.get('hostRoom', {});
  const chip = $('#host-code-chip');
  chip.hidden = !saved.code;
  chip.textContent = saved.code ? `Code ${saved.code}` : '';
}

function renderSettingsCode() {
  const code = S.live ? S.code : storage.get('hostRoom', {}).code;
  $('#hs-code').textContent = code || 'Nouveau';
}

// =========================================================== start / end
async function startLive() {
  if (S.live) return;
  const btn = $('#btn-start');
  S.mixer ||= new Mixer();
  S.mixer.resume();
  let stream;
  try {
    stream = await captureSource();
  } catch (err) {
    if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') toast('Partage annulé');
    else toast(S.mode === 'camera' ? 'Caméra inaccessible' : 'Capture d’écran impossible dans ce navigateur', { type: 'warn' });
    return;
  }
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    useCapture(stream);
    if (S.settings.micOn) await setMic(true);
    else renderMicState();
    await createRoom();
    S.enc = await encodeCaps().catch(() => ({ mimes: [], hw: {} }));
  } catch (err) {
    console.error(err);
    stream.getTracks().forEach((t) => t.stop());
    toast('Impossible de démarrer le live — vérifie ta connexion', { type: 'warn' });
    btn.disabled = false;
    btn.classList.remove('loading');
    return;
  }
  btn.disabled = false;
  btn.classList.remove('loading');

  S.live = true;
  S.startedAt = Date.now();
  S.approved.clear();
  S.poller = new Poller({
    payload: { code: S.code, id: 'host', token: S.token },
    idle: 2000,
    fast: 350,
    onResult: onSignal,
    onError: (err, n) => {
      if (err?.status === 403) toast('Session expirée, redémarre le live', { type: 'warn' });
      else if (n === 3) toast('Connexion au serveur instable…', { type: 'warn' });
    },
  });
  S.poller.start();
  S.stopStats = every(statsTick, 1000);
  S.stopTalk = every(talkTick, 120);
  timerTick();
  setGame(S.settings.gameOn);
  renderPresetLabels();
  renderViewers();
  renderChatEmpty();
  showView('view-host');
  renderRetour();
  renderChecks();
  getIceServers().then(({ relay }) => {
    S.relay = relay;
    renderChecks();
  });
  if (S.mode === 'screen' && S.settings.hdr === 'auto' && hdrDisplay()) setTimeout(() => calibrate({ quiet: true }), 600);
}

async function endLive({ ask = true } = {}) {
  if (!S.live) return;
  if (ask && !(await confirmDialog({ title: 'Terminer le live ?', confirm: 'Terminer', danger: true }))) return;
  broadcast({ t: 'bye' });
  await wait(150);
  for (const peer of [...S.peers.values()]) peer.close('end', { silent: true });
  S.poller?.stop();
  S.stopStats?.();
  S.stopTalk?.();
  closeMini();
  api('end', { code: S.code, token: S.token }).catch(() => {});
  S.pipe?.stop();
  S.pipe = null;
  [S.video, S.game].forEach((t) => t?.stop());
  S.mic?.stop();
  S.micMeter?.stop?.();
  S.gameMeter?.stop?.();
  S.mic = S.micMeter = S.gameMeter = S.video = S.out = S.game = null;
  S.hdr = { measured: null, measuring: false, slow: 0, reduced: false };
  S.mixer?.setGameTrack(null);
  S.mixer?.setMicTrack(null);
  $('#preview').srcObject = null;
  S.live = false;
  S.sourceLost = false;
  renderHomeCode();
  showView('view-home');
}

// ============================================================= signaling
async function onSignal({ messages }) {
  for (const m of messages) {
    const d = m.data || {};
    if (d.type === 'join') handleJoin(m.from, d);
    else if (d.type === 'answer') S.peers.get(m.from)?.onAnswer(d.sdp).catch((e) => {
      console.warn(e);
      S.peers.get(m.from)?.close('error');
    });
    else if (d.type === 'leave') S.peers.get(m.from)?.close('left');
  }
}

async function handleJoin(id, info) {
  for (const p of [...S.peers.values()]) if (p.clientId === info.clientId) p.close('replaced', { silent: true });
  if (S.settings.approve && !S.approved.has(info.clientId)) {
    if (S.settings.sounds) chime('alert');
    notify('StreamCast', `${info.name || 'Quelqu’un'} veut regarder le live`);
    const ok = await confirmDialog({
      title: `${info.name || 'Un spectateur'} veut regarder`,
      message: info.caps?.device ? `Depuis ${info.caps.device}` : '',
      confirm: 'Accepter',
      cancel: 'Refuser',
    });
    if (!S.live) return;
    if (!ok) {
      api('send', { code: S.code, token: S.token, from: 'host', to: id, data: { type: 'reject' } }).catch(() => {});
      return;
    }
    S.approved.add(info.clientId);
  }
  const peer = new Peer(id, info);
  S.peers.set(id, peer);
  renderViewers();
  S.poller.boost(20000);
  try {
    await peer.connect();
  } catch (err) {
    console.error(err);
    peer.close('error');
  }
}

// ================================================================= stats
async function statsTick() {
  let best = null;
  for (const peer of S.peers.values()) {
    if (!peer.pc || peer.state !== 'live') continue;
    try {
      const st = await senderStats(peer.pc, peer.stats);
      peer.stats = st;
      peer.adapt(st);
      if (!best || (st.bitrate || 0) > (best.bitrate || 0)) best = st;
    } catch {}
  }
  if (peerCount()) renderViewers();
  // Poll the signaling server calmly once everyone is connected.
  const handshaking = [...S.peers.values()].some((p) => p.state === 'connecting');
  if (S.poller) S.poller.idle = peerCount() && !handshaking ? 4000 : 2000;
  measureCapture();
  checkPipeSpeed();
  renderHostStats(best);
  renderViewerView();
  renderChecks();
  updateSourceInfo(S.capture.fps || best?.srcFps);
}

function renderHostStats(st) {
  const bar = $('#host-stats');
  if (!st || !st.width) {
    bar.replaceChildren(h('span', { class: 'muted', text: S.peers.size ? 'Connexion…' : 'En attente d’un spectateur' }));
    return;
  }
  const path = { local: 'Réseau local', direct: 'Direct', relay: 'Relais' }[st.path] || '';
  const enc = st.hw === true ? 'GPU' : st.hw === false ? 'CPU' : '';
  const limit = { cpu: 'limité par le processeur', bandwidth: 'limité par le réseau' }[st.limitation];
  const items = [
    stat('Résolution', `${heightLabel(st.height)} · ${st.width}×${st.height}`),
    stat('Images/s', `${Math.round(st.fps || 0)}`),
    stat('Débit', fmtBitrate(st.bitrate)),
    stat('Codec', `${codecLabel(st.codec)}${enc ? ` · ${enc}` : ''}`),
    stat('Ping', st.rtt != null ? `${Math.round(st.rtt * 1000)} ms` : '—'),
    path ? stat('Connexion', path) : null,
    limit ? h('span', { class: 'stat warn-text', text: limit }) : null,
  ];
  bar.replaceChildren(...items.filter(Boolean));
}

const stat = (label, value) => h('span', { class: 'stat' }, h('small', { text: label }), h('b', { text: value }));
const peerCount = () => [...S.peers.values()].filter((p) => p.state === 'live').length;

function timerTick() {
  if (!S.live) return;
  $('#host-timer').textContent = fmtDuration(Date.now() - S.startedAt);
  renderMini();
  later(timerTick, 1000);
}

// Who is talking: Ruben's mic (sent to spectateurs) and each spectateur's
// voice (shown on the dashboard and the mini-retour).
function talkTick() {
  const now = Date.now();
  const lvl = S.micMeter && S.settings.micOn && S.mic ? S.micMeter() : 0;
  if (lvl > 0.3) S.talkUntil = now + 450;
  const talking = now < S.talkUntil;
  if (talking !== S.talking) {
    S.talking = talking;
    broadcast({ t: 'talk', on: talking });
  }
  let changed = false;
  for (const peer of S.peers.values()) {
    if (!peer.voiceMeter) continue;
    if (peer.micOn && peer.voiceMeter() > 0.25) peer.speakUntil = now + 450;
    const speaking = now < peer.speakUntil;
    if (speaking !== peer.speaking) {
      peer.speaking = speaking;
      peer.row?.classList.toggle('speaking', speaking);
      changed = true;
    }
  }
  if (changed) renderMini();
}

function meterLoop() {
  requestAnimationFrame(meterLoop);
  if (!S.live || document.hidden) return;
  const mic = S.micMeter && S.settings.micOn && S.mic ? S.micMeter() : 0;
  const game = S.gameMeter && S.settings.gameOn ? S.gameMeter() : 0;
  $('#ctl-mic').style.setProperty('--lvl', mic.toFixed(3));
  $('#chk-mic').style.setProperty('--lvl', mic.toFixed(3));
  $('#chk-audio').style.setProperty('--lvl', game.toFixed(3));
}

// =============================================================== viewers
function renderViewers() {
  const list = $('#viewers');
  const peers = [...S.peers.values()];
  const live = peers.filter((p) => p.state === 'live').length;
  $('#host-count-n').textContent = live;
  $('#viewers-count').textContent = live;
  $('#viewers-empty').hidden = peers.length > 0;
  const rows = peers.map((peer) => {
    const st = peer.stats;
    const vs = peer.viewerStats;
    let quality = '';
    let network = 'Connexion…';
    let tone = 'wait';
    if (peer.state === 'live' && st?.height) {
      const net = netQuality(peer) || 'bon';
      quality = `${heightLabel(vs?.h || st.height)} · ${Math.round(vs?.fps ?? st.fps ?? 0)} FPS`;
      network = `Réseau ${net}`;
      tone = { bon: 'good', moyen: 'mid', faible: 'bad' }[net];
    }
    const row =
      peer.row ||
      h(
        'li',
        { class: 'viewer' },
        h('span', { class: 'avatar' }),
        h('div', { class: 'viewer-info' }, h('b'), h('small'), h('small', { class: 'viewer-net' })),
        h('span', { class: 'viewer-mic' }, icon('mic')),
        h('span', { class: 'viewer-dot' }),
        h('button', { class: 'icon-btn sm ghost', title: 'Retirer du live', 'aria-label': 'Retirer du live' }, icon('x')),
      );
    if (!peer.row) {
      row.querySelector('button').addEventListener('click', async () => {
        if (await confirmDialog({ title: `Retirer ${peer.name} du live ?`, confirm: 'Retirer', danger: true })) {
          peer.send({ t: 'kick' });
          setTimeout(() => peer.close('kick', { silent: true }), 250);
        }
      });
      peer.row = row;
    }
    row.querySelector('.avatar').textContent = (peer.name[0] || '?').toUpperCase();
    row.querySelector('.viewer-info b').textContent = peer.name;
    row.querySelector('.viewer-info small').textContent = [peer.device, quality].filter(Boolean).join(' · ');
    const netEl = row.querySelector('.viewer-net');
    netEl.textContent = network;
    netEl.dataset.tone = tone;
    row.querySelector('.viewer-mic').hidden = !peer.micOn;
    row.querySelector('.viewer-dot').dataset.tone = tone;
    return row;
  });
  list.replaceChildren(...rows);
}

// ================================================================== chat
function renderChatEmpty() {
  const log = $('#host-chat-log');
  if (!log.children.length) log.append(h('p', { class: 'chat-empty', text: 'Les messages apparaîtront ici' }));
}

function addChat(log, { name, text }, self = false) {
  log.querySelector('.chat-empty')?.remove();
  log.append(h('div', { class: `msg${self ? ' self' : ''}` }, h('b', { text: self ? 'Toi' : name }), h('span', { text })));
  while (log.children.length > 200) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

function receiveChat(msg, fromPeer) {
  addChat($('#host-chat-log'), msg);
  miniChat(msg);
  broadcast({ t: 'chat', name: msg.name, text: msg.text }, fromPeer);
  if (S.settings.sounds) chime('message');
  notify(msg.name, msg.text);
}

// ============================================================== settings
function openSettings() {
  renderSettingsCode();
  refreshDevices();
  openDialog($('#dlg-host'));
}

async function refreshDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const outs = devices.filter((d) => d.kind === 'audiooutput');
    fillSelect($('#hs-mic'), [{ id: '', label: 'Micro par défaut' }, ...mics.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => ({ id: d.deviceId, label: d.label || `Micro ${i + 1}` }))], S.settings.micDevice);
    const sinkSupported = 'setSinkId' in HTMLMediaElement.prototype;
    $('#hs-sink-row').hidden = !sinkSupported || outs.length < 2;
    fillSelect($('#hs-sink'), [{ id: '', label: 'Sortie par défaut' }, ...outs.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => ({ id: d.deviceId, label: d.label || `Sortie ${i + 1}` }))], S.settings.sinkId);
  } catch {}
}

function fillSelect(select, options, value) {
  select.replaceChildren(...options.map((o) => h('option', { value: o.id, text: o.label, selected: o.id === value })));
}

function wireSettings() {
  const presetsRoot = $('#hs-presets');
  presetsRoot.replaceChildren(
    ...PRESETS.map((p) =>
      h('button', { type: 'button', class: 'choice', 'data-id': p.id }, h('b', { text: p.label }), h('small', { text: p.desc })),
    ),
  );
  presetsRoot.addEventListener('click', (e) => {
    const b = e.target.closest('.choice');
    if (b) setPreset(b.dataset.id);
  });

  const supported = new Set(
    (RTCRtpSender.getCapabilities?.('video')?.codecs || []).map((c) => c.mimeType.toLowerCase()),
  );
  segmented(
    $('#hs-codec'),
    CODECS.filter((c) => !c.mime || supported.has(c.mime.toLowerCase())),
    S.settings.codec,
    (id) => setCodec(id),
  );

  $('#hs-mic').addEventListener('change', async (e) => {
    S.settings.micDevice = e.target.value;
    saveSettings();
    if (S.mic) {
      try {
        await openMic();
        S.mic.enabled = S.settings.micOn;
      } catch {
        toast('Micro inaccessible', { type: 'warn' });
      }
    }
  });
  bindSwitch('#hs-noise', 'noise', async () => {
    if (S.mic) await S.mic.applyConstraints({ noiseSuppression: S.settings.noise }).catch(() => {});
  });
  bindRange('#hs-mic-vol', 'micVolume', (v) => S.mixer?.setVoiceVolume(v));
  bindRange('#hs-game-vol', 'gameVolume', (v) => S.settings.gameOn && S.mixer?.setGameVolume(v));
  bindRange('#hs-viewer-vol', 'viewerVolume', (v) => {
    for (const p of S.peers.values()) if (p.audioEl) p.audioEl.volume = clamp(v, 0, 1);
  });
  $('#hs-sink').addEventListener('change', (e) => {
    S.settings.sinkId = e.target.value;
    saveSettings();
    for (const p of S.peers.values()) p.audioEl?.setSinkId?.(S.settings.sinkId).catch(() => {});
  });

  const hdrRow = $('#hs-hdr-k-row');
  const setHdrUi = segmented(
    $('#hs-hdr'),
    [{ id: 'auto', label: 'Auto' }, { id: 'manual', label: 'Manuelle' }, { id: 'off', label: 'Désactivée' }],
    S.settings.hdr,
    (id) => {
      S.settings.hdr = id;
      saveSettings();
      hdrRow.hidden = id !== 'manual';
      applyColor();
      if (id === 'auto' && S.live && !S.hdr.measured) calibrate();
    },
  );
  hdrRow.hidden = S.settings.hdr !== 'manual';
  bindRange('#hs-hdr-k', 'hdrStrength', () => applyColor());
  $('#hs-hdr-calib').addEventListener('click', () => {
    if (!S.live) return toast('Lance le live pour mesurer ton écran');
    S.settings.hdr = 'auto';
    saveSettings();
    setHdrUi('auto');
    hdrRow.hidden = true;
    closeDialog($('#dlg-host'));
    setTimeout(calibrate, 300);
  });

  $('#hs-newcode').addEventListener('click', newCode);
  bindSwitch('#hs-digits', 'digits', null, (on) => (on ? 4 : 3), (v) => v === 4);
  $('#hs-digits').addEventListener('change', () => S.live && newCode());
  bindSwitch('#hs-approve', 'approve');
  bindSwitch('#hs-sounds', 'sounds');
  bindSwitch('#hs-notify', 'notify', async (on) => {
    if (on && 'Notification' in window && Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission().catch(() => 'denied');
      if (perm !== 'granted') {
        S.settings.notify = false;
        saveSettings();
        $('#hs-notify').checked = false;
        toast('Notifications refusées par le navigateur', { type: 'warn' });
      }
    }
  });
  $('#hs-notify-row').hidden = !('Notification' in window);
}

function bindSwitch(sel, key, after, toValue = (on) => on, fromValue = (v) => !!v) {
  const input = $(sel);
  input.checked = fromValue(S.settings[key]);
  input.addEventListener('change', () => {
    S.settings[key] = toValue(input.checked);
    saveSettings();
    after?.(input.checked);
  });
}

function bindRange(sel, key, apply) {
  const input = $(sel);
  const out = input.closest('.range-row')?.querySelector('output');
  const show = () => out && (out.textContent = `${Math.round(input.value)} %`);
  input.value = Math.round(S.settings[key] * 100);
  show();
  input.addEventListener('input', () => {
    S.settings[key] = input.value / 100;
    show();
    apply(S.settings[key]);
  });
  input.addEventListener('change', saveSettings);
}

// ============================================================ retour
// "Mini-retour": a small always-on-top window (Document Picture-in-Picture)
// showing Ruben's capture, what the spectateur sees, the stats and the mic,
// so he can check the stream without leaving his game.
const mini = { win: null, video: null, chatCancel: null };

const MINI_CSS = `
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#000;color:#f4f4f8;overflow:hidden;-webkit-font-smoothing:antialiased;
  font:13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
[hidden]{display:none!important}
.i{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.mini{position:relative;height:100%}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
.m-lost{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:10px;padding:20px;background:rgba(8,8,13,.9);font-weight:700;text-align:center}
.m-resume{height:34px;padding:0 14px;border:none;border-radius:10px;background:linear-gradient(135deg,#8b7bff,#c06bff 55%,#ff4f8b);color:#fff;font:inherit;font-weight:700;cursor:pointer}
.m-talk{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;background:rgba(52,211,153,.2);color:#6ee7b7;font-size:11px;font-weight:700}
.m-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:10px;padding:8px 10px 18px;background:linear-gradient(rgba(0,0,0,.65),transparent)}
.badge-live{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 7px;border-radius:6px;background:#ff3b5c;font-size:10.5px;font-weight:800;letter-spacing:.08em}
.badge-live i{width:6px;height:6px;border-radius:50%;background:#fff;animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
.m-meta{display:inline-flex;align-items:center;gap:5px;font-weight:650;font-variant-numeric:tabular-nums}
.m-thumb{position:absolute;top:8px;right:8px;margin:0;width:36%;border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,.25);box-shadow:0 6px 18px rgba(0,0,0,.55);background:#000;cursor:pointer}
.m-thumb.big{width:72%}
.m-thumb img{display:block;width:100%}
.m-thumb figcaption{position:absolute;left:0;right:0;bottom:0;padding:2px 6px;background:rgba(0,0,0,.6);font-size:10.5px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m-chat{position:absolute;left:8px;right:8px;bottom:46px;padding:6px 9px;border-radius:10px;background:rgba(12,12,18,.88);border:1px solid rgba(255,255,255,.1);overflow-wrap:anywhere}
.m-chat b{color:#a597ff;margin-right:6px}
.m-bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:8px;padding:18px 8px 7px 10px;background:linear-gradient(transparent,rgba(0,0,0,.8))}
.m-dot{width:8px;height:8px;border-radius:50%;background:#6e6e82;flex:none}
.m-dot[data-tone=good]{background:#34d399}.m-dot[data-tone=mid]{background:#fbbf24}.m-dot[data-tone=bad]{background:#ff5a6e}
.m-stats{flex:1;min-width:0;font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m-btn{display:grid;place-items:center;flex:none;width:32px;height:32px;border-radius:50%;border:none;background:rgba(255,255,255,.14);color:#fff;cursor:pointer}
.m-btn.off{color:#ff6b81}
`;

const MINI_HTML = `
<div class="mini">
  <video id="m-video" muted autoplay playsinline></video>
  <div class="m-lost" id="m-lost" hidden><span>Partage arrêté</span><button class="m-resume" id="m-resume" type="button">Reprendre le partage</button></div>
  <div class="m-top">
    <span class="badge-live"><i></i>LIVE</span>
    <span class="m-meta" id="m-timer">00:00</span>
    <span class="m-meta"><svg class="i"><use href="#i-users"/></svg><span id="m-count">0</span></span>
    <span class="m-talk" id="m-talk" hidden><svg class="i"><use href="#i-mic"/></svg><span id="m-talk-name"></span></span>
  </div>
  <figure class="m-thumb" id="m-thumb" title="Ce que voit le spectateur" hidden><img id="m-thumb-img" alt=""><figcaption id="m-thumb-cap"></figcaption></figure>
  <div class="m-chat" id="m-chat" hidden></div>
  <div class="m-bar">
    <i class="m-dot" id="m-dot" data-tone="wait"></i>
    <span class="m-stats" id="m-stats"></span>
    <button class="m-btn" id="m-mic" type="button"><svg class="i"><use href="#i-mic-off"/></svg></button>
  </div>
</div>`;

// The button toggles: open the floating retour, or put it away.
function toggleMini() {
  if (mini.win || document.pictureInPictureElement) closeMini();
  else openMini();
}

async function openMini() {
  if (!('documentPictureInPicture' in window)) {
    try {
      await $('#preview').requestPictureInPicture();
    } catch {
      toast('Mini-retour indisponible dans ce navigateur : utilise Chrome ou Edge', { type: 'warn' });
    }
    return;
  }
  let win;
  try {
    win = await window.documentPictureInPicture.requestWindow({ width: 440, height: 300 });
  } catch {
    toast('Impossible d’ouvrir le mini-retour', { type: 'warn' });
    return;
  }
  mini.win = win;
  const doc = win.document;
  doc.title = 'StreamCast';
  const style = doc.createElement('style');
  style.textContent = MINI_CSS;
  doc.head.append(style);
  doc.body.append($('#sprite').cloneNode(true));
  doc.body.insertAdjacentHTML('beforeend', MINI_HTML);
  mini.video = doc.getElementById('m-video');
  if (S.out) mini.video.srcObject = new MediaStream([S.out]);
  mini.video.play().catch(() => {});
  doc.getElementById('m-mic').addEventListener('click', () => setMic(!(S.settings.micOn && S.mic)));
  doc.getElementById('m-resume').addEventListener('click', changeSource);
  doc.getElementById('m-thumb').addEventListener('click', (e) => e.currentTarget.classList.toggle('big'));
  win.addEventListener('pagehide', () => {
    mini.win = null;
    mini.video = null;
    renderMiniButton();
    broadcastState();
  });
  renderMiniButton();
  renderMini();
  broadcastState();
}

function renderMiniButton() {
  const open = !!mini.win || !!document.pictureInPictureElement;
  const btn = $('#ctl-mini');
  btn.setAttribute('aria-pressed', String(open));
  btn.querySelector('.ctl-label').textContent = open ? 'Ranger le mini-retour' : 'Mini-retour';
}

function closeMini() {
  mini.win?.close();
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
}

function freshThumbPeer() {
  const now = Date.now();
  return [...S.peers.values()].find((p) => p.state === 'live' && p.thumb && now - p.thumbAt < 10000) || null;
}

function viewerSummary(peer) {
  const vs = peer.viewerStats;
  const st = peer.stats;
  const height = vs?.h || st?.height;
  if (!height) return '';
  const fps = Math.round(vs?.fps ?? st?.fps ?? 0);
  return `${heightLabel(height)} · ${fps} FPS${vs?.latencyMs ? ` · ~${vs.latencyMs} ms` : ''}`;
}

// Dashboard: small picture of what the spectateur really sees.
function renderViewerView() {
  const peer = freshThumbPeer();
  $('#viewer-view').hidden = !peer;
  if (peer) {
    const img = $('#viewer-view-img');
    if (img.getAttribute('src') !== peer.thumb) img.src = peer.thumb;
    $('#viewer-view-cap').textContent = [`Vue de ${peer.name}`, viewerSummary(peer)].filter(Boolean).join(' · ');
  }
  renderMini();
}

function renderMini() {
  const doc = mini.win?.document;
  if (!doc) return;
  const el = (id) => doc.getElementById(id);
  el('m-timer').textContent = fmtDuration(Date.now() - S.startedAt);
  el('m-count').textContent = peerCount();
  const on = !!(S.settings.micOn && S.mic);
  const mic = el('m-mic');
  mic.classList.toggle('off', !on);
  mic.querySelector('use').setAttribute('href', on ? '#i-mic' : '#i-mic-off');
  mic.title = on ? 'Couper le micro' : 'Activer le micro';
  el('m-lost').hidden = !S.sourceLost;
  const speaker = [...S.peers.values()].find((p) => p.speaking);
  el('m-talk').hidden = !speaker;
  if (speaker) el('m-talk-name').textContent = speaker.name;

  const peer = [...S.peers.values()].find((p) => p.state === 'live');
  let text = peer ? 'Connexion…' : 'En attente d’un spectateur';
  let tone = 'wait';
  if (peer?.stats?.height) {
    text = `${viewerSummary(peer)} · ${fmtBitrate(peer.stats.bitrate)}`;
    tone = { bon: 'good', moyen: 'mid', faible: 'bad' }[netQuality(peer)] || 'wait';
  }
  el('m-stats').textContent = text;
  el('m-dot').dataset.tone = tone;

  const tp = freshThumbPeer();
  el('m-thumb').hidden = !tp;
  if (tp) {
    const img = el('m-thumb-img');
    if (img.getAttribute('src') !== tp.thumb) img.src = tp.thumb;
    el('m-thumb-cap').textContent = tp.name;
  }
}

function miniChat({ name, text }) {
  const doc = mini.win?.document;
  if (!doc) return;
  const box = doc.getElementById('m-chat');
  const b = doc.createElement('b');
  b.textContent = name;
  box.replaceChildren(b, doc.createTextNode(text));
  box.hidden = false;
  mini.chatCancel?.();
  mini.chatCancel = later(() => (box.hidden = true), 7000);
}

// ============================================================== view glue
let showView = () => {};

export function initHost({ show }) {
  showView = show;

  // Home card
  const chips = $('#preset-chips');
  chips.replaceChildren(
    ...PRESETS.map((p) => h('button', { type: 'button', class: 'chip-btn', 'data-id': p.id, text: p.label })),
  );
  chips.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) setPreset(b.dataset.id);
  });
  const optMic = $('#opt-mic');
  const optSys = $('#opt-sys');
  optMic.checked = S.settings.micOn;
  optSys.checked = S.settings.gameOn;
  optMic.addEventListener('change', () => {
    S.settings.micOn = optMic.checked;
    saveSettings();
  });
  optSys.addEventListener('change', () => {
    S.settings.gameOn = optSys.checked;
    saveSettings();
  });
  if (S.mode === 'camera') {
    $('#row-sys').hidden = true;
    $('#btn-start-label').textContent = 'Diffuser la caméra';
    $('#host-note').hidden = false;
    $('#ctl-source').hidden = true;
    $('#ctl-sys').hidden = true;
    $('#ctl-camera').hidden = false;
  }
  $('#btn-start').addEventListener('click', startLive);
  renderHomeCode();
  renderPresetLabels();

  // Live dashboard
  $('#btn-end').addEventListener('click', () => endLive());
  $('#ctl-mic').addEventListener('click', () => setMic(!(S.settings.micOn && S.mic)));
  $('#ctl-sys').addEventListener('click', () => setGame(!S.settings.gameOn));
  $('#ctl-preset').addEventListener('click', (e) =>
    openMenu(e.currentTarget, PRESETS, S.settings.preset, (id) => setPreset(id)),
  );
  $('#ctl-source').addEventListener('click', changeSource);
  $('#ctl-camera').addEventListener('click', switchCamera);
  $('#ctl-settings').addEventListener('click', openSettings);
  $('#btn-reshare').addEventListener('click', changeSource);
  $('#btn-surface-fix').addEventListener('click', changeSource);
  $('#btn-hdr-calib').addEventListener('click', () => calibrate());
  $('#ctl-mini').addEventListener('click', toggleMini);
  $('#preview').addEventListener('enterpictureinpicture', renderMiniButton);
  $('#preview').addEventListener('leavepictureinpicture', renderMiniButton);
  // Capture frame counter (fallback when the browser has no track stats).
  const pv = $('#preview');
  if (pv.requestVideoFrameCallback) {
    const onFrame = () => {
      S.capture.frames++;
      pv.requestVideoFrameCallback(onFrame);
    };
    pv.requestVideoFrameCallback(onFrame);
  }
  // Snapshots from the spectateur are only needed while Ruben can see them.
  document.addEventListener('visibilitychange', () => S.live && broadcastState());
  $('#btn-audio-retry').addEventListener('click', changeSource);
  $('#btn-retour-toggle').addEventListener('click', () => {
    S.settings.preview = !S.settings.preview;
    saveSettings();
    renderRetour();
    broadcastState();
  });
  renderRetour();

  $('#btn-copy').addEventListener('click', async () => {
    const ok = await copyText(link());
    toast(ok ? 'Lien copié' : link(), { icon: ok ? 'check' : 'link' });
  });
  $('#share-link-box').addEventListener('click', async () => {
    if (await copyText(link())) toast('Lien copié', { icon: 'check' });
  });
  $('#btn-share').addEventListener('click', async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'StreamCast', text: `Live de ${HOST_NAME} — code ${S.code}`, url: link() });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    if (await copyText(link())) toast('Lien copié', { icon: 'check' });
  });
  $('#btn-qr').addEventListener('click', () => showQr(link()));

  $('#host-chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#host-chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addChat($('#host-chat-log'), { name: HOST_NAME, text }, true);
    broadcast({ t: 'chat', name: HOST_NAME, text: text.slice(0, 500), host: true });
  });

  wireSettings();
  requestAnimationFrame(meterLoop);

  window.addEventListener('beforeunload', (e) => {
    if (!S.live) return;
    e.preventDefault();
    e.returnValue = '';
  });
  window.addEventListener('pagehide', () => {
    if (!S.live) return;
    broadcast({ t: 'bye' });
    navigator.sendBeacon?.('/api/signal', JSON.stringify({ op: 'end', code: S.code, token: S.token }));
  });
}

// In-app retour (capture + what the spectateur sees): shown or put away.
function renderRetour() {
  const on = S.settings.preview;
  $('#retour').classList.toggle('collapsed', !on);
  const btn = $('#btn-retour-toggle');
  setIcon(btn, on ? 'eye-off' : 'eye');
  btn.querySelector('.label').textContent = on ? 'Masquer' : 'Afficher';
}

export const isLive = () => S.live;
