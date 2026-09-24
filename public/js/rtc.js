// WebRTC helpers: SDP tweaks, codec ordering, capability probing and stats.

export function waitIceGathering(pc, timeout = 2500) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', onCandidate);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const onCandidate = (e) => !e.candidate && done();
    const timer = setTimeout(done, timeout);
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', onCandidate);
  });
}

// ---------------------------------------------------------------- SDP munging
const splitSections = (sdp) => sdp.split(/\r\n(?=m=)/);
const joinSections = (parts) => parts.join('\r\n');

function payloadTypes(section, codecName) {
  const re = new RegExp(`^a=rtpmap:(\\d+) ${codecName}/`, 'gim');
  return [...section.matchAll(re)].map((m) => m[1]);
}

function setFmtp(section, pt, params) {
  const re = new RegExp(`^a=fmtp:${pt} (.*)$`, 'm');
  const serialize = (map) => Object.entries(map).map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';');
  if (re.test(section)) {
    return section.replace(re, (_, current) => {
      const map = {};
      for (const part of current.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k) map[k] = v.join('=');
      }
      Object.assign(map, params);
      return `a=fmtp:${pt} ${serialize(map)}`;
    });
  }
  return section.replace(new RegExp(`^(a=rtpmap:${pt} .*)$`, 'm'), `$1\r\na=fmtp:${pt} ${serialize(params)}`);
}

const midOf = (section) => section.match(/^a=mid:(\S+)/m)?.[1];

// Sender side (Ruben): faster bitrate ramp-up and stereo high-bitrate Opus for
// the game audio. Applied to the remote answer before setRemoteDescription.
export function tuneAnswerForSender(sdp, { programMid, startKbps = 8000 } = {}) {
  const parts = splitSections(sdp);
  for (let i = 1; i < parts.length; i++) {
    let s = parts[i];
    if (s.startsWith('m=video')) {
      for (const codec of ['H264', 'VP8', 'VP9', 'AV1', 'H265']) {
        for (const pt of payloadTypes(s, codec)) {
          s = setFmtp(s, pt, {
            'x-google-start-bitrate': String(startKbps),
            'x-google-min-bitrate': '500',
            'x-google-max-bitrate': '120000',
          });
        }
      }
    } else if (s.startsWith('m=audio') && (!programMid || midOf(s) === programMid)) {
      s = opusMusic(s);
    }
    parts[i] = s;
  }
  return joinSections(parts);
}

function opusMusic(section) {
  for (const pt of payloadTypes(section, 'opus')) {
    section = setFmtp(section, pt, {
      stereo: '1',
      'sprop-stereo': '1',
      maxaveragebitrate: '192000',
      useinbandfec: '1',
      usedtx: '0',
    });
  }
  return section;
}

// Receiver side (spectateur): ask for stereo on the program audio.
export function tuneAnswerForReceiver(sdp, programMid) {
  const parts = splitSections(sdp);
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].startsWith('m=audio') && midOf(parts[i]) === programMid) parts[i] = opusMusic(parts[i]);
  }
  return joinSections(parts);
}

// Returns mids of audio m-lines in order with their direction.
export function audioSections(sdp) {
  return splitSections(sdp)
    .slice(1)
    .filter((s) => s.startsWith('m=audio'))
    .map((s) => ({
      mid: midOf(s),
      direction: s.match(/^a=(sendrecv|sendonly|recvonly|inactive)/m)?.[1] || 'sendrecv',
    }));
}

// ------------------------------------------------------------- codec helpers
const isAux = (c) => /rtx|red|ulpfec|flexfec/i.test(c.mimeType);

function h264Rank(c) {
  const p = (c.sdpFmtpLine || '').match(/profile-level-id=([0-9a-f]{6})/i)?.[1]?.toLowerCase() || '';
  const packetization = /packetization-mode=1/.test(c.sdpFmtpLine || '') ? 0 : 1;
  const profile = p.startsWith('64') ? 0 : p.startsWith('4d') ? 1 : p.startsWith('42e0') ? 2 : 3;
  return packetization * 10 + profile;
}

export function orderCodecs(codecs, preferredMimes) {
  const main = codecs.filter((c) => !isAux(c));
  const aux = codecs.filter(isAux);
  const rank = (c) => {
    const i = preferredMimes.findIndex((m) => m.toLowerCase() === c.mimeType.toLowerCase());
    return i === -1 ? 99 : i;
  };
  main.sort((a, b) => rank(a) - rank(b) || (a.mimeType === 'video/H264' && b.mimeType === 'video/H264' ? h264Rank(a) - h264Rank(b) : 0));
  return [...main, ...aux];
}

export function applyCodecPreferences(transceiver, preferredMimes) {
  if (!transceiver.setCodecPreferences) return false;
  const sources = [RTCRtpSender.getCapabilities?.('video')?.codecs, RTCRtpReceiver.getCapabilities?.('video')?.codecs];
  for (const codecs of sources) {
    if (!codecs?.length) continue;
    try {
      transceiver.setCodecPreferences(orderCodecs(codecs, preferredMimes));
      return true;
    } catch {}
  }
  return false;
}

export const videoMimes = (kind = 'receiver') => {
  const Cls = kind === 'sender' ? window.RTCRtpSender : window.RTCRtpReceiver;
  const codecs = Cls?.getCapabilities?.('video')?.codecs || [];
  return [...new Set(codecs.filter((c) => !isAux(c)).map((c) => c.mimeType))];
};

async function mediaCapability(fn, mime, height = 1440, fps = 60) {
  try {
    const width = Math.round((height * 16) / 9);
    const info = await navigator.mediaCapabilities[fn]({
      type: 'webrtc',
      video: { contentType: mime, width, height, bitrate: 20e6, framerate: fps },
    });
    return { supported: !!info.supported, hw: !!info.powerEfficient, smooth: !!info.smooth };
  } catch {
    return null;
  }
}

// What this device can decode, and whether in hardware.
export async function decodeCaps() {
  const mimes = videoMimes('receiver');
  const hw = {};
  if (navigator.mediaCapabilities?.decodingInfo) {
    await Promise.all(
      mimes.map(async (m) => {
        const r = await mediaCapability('decodingInfo', m);
        if (r) hw[m] = r.hw;
      }),
    );
  }
  return { mimes, hw };
}

// What this device can encode, and whether in hardware (NVENC, etc.).
export async function encodeCaps() {
  const mimes = videoMimes('sender');
  const hw = {};
  if (navigator.mediaCapabilities?.encodingInfo) {
    await Promise.all(
      mimes.map(async (m) => {
        const r = await mediaCapability('encodingInfo', m, 2160, 60);
        if (r) hw[m] = r.hw;
      }),
    );
  }
  return { mimes, hw };
}

// Picks the video codec for a viewer: explicit choice, otherwise the most
// efficient codec both sides handle in hardware, H.264 as the safe default.
export function chooseCodec(choiceMime, enc, viewer) {
  const viewerMimes = viewer?.mimes || [];
  const both = (m) => enc.mimes.includes(m) && (!viewerMimes.length || viewerMimes.includes(m));
  if (choiceMime && both(choiceMime)) return choiceMime;
  if (both('video/AV1') && enc.hw['video/AV1'] && viewer?.hw?.['video/AV1']) return 'video/AV1';
  if (both('video/H264')) return 'video/H264';
  if (both('video/VP9') && enc.hw['video/VP9']) return 'video/VP9';
  return ['video/VP8', 'video/VP9', 'video/AV1'].find(both) || 'video/H264';
}

export const codecLabel = (mime) =>
  ({ 'video/H264': 'H.264', 'video/AV1': 'AV1', 'video/VP9': 'VP9', 'video/VP8': 'VP8', 'video/H265': 'H.265' })[mime] ||
  mime?.replace(/^video\//, '') ||
  '—';

// ---------------------------------------------------------------------- stats
function selectedPair(report) {
  let pair = null;
  report.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId);
  });
  if (!pair) {
    report.forEach((s) => {
      if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) pair = pair || s;
    });
  }
  return pair;
}

function connectionType(report, pair) {
  if (!pair) return null;
  const local = report.get(pair.localCandidateId);
  const remote = report.get(pair.remoteCandidateId);
  if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') return 'relay';
  if (local?.candidateType === 'host' && remote?.candidateType === 'host') return 'local';
  return 'direct';
}

export async function senderStats(pc, prev) {
  const report = await pc.getStats();
  const out = { ts: performance.now() };
  let outbound = null;
  report.forEach((s) => {
    if (s.type === 'outbound-rtp' && s.kind === 'video') {
      if (!outbound || (s.bytesSent || 0) > (outbound.bytesSent || 0)) outbound = s;
    }
  });
  if (outbound) {
    out.bytes = outbound.bytesSent;
    out.width = outbound.frameWidth;
    out.height = outbound.frameHeight;
    out.fps = outbound.framesPerSecond || 0;
    out.limitation = outbound.qualityLimitationReason || 'none';
    out.targetBitrate = outbound.targetBitrate;
    out.encoder = outbound.encoderImplementation;
    out.hw = outbound.powerEfficientEncoder;
    out.framesEncoded = outbound.framesEncoded;
    out.encodeTime = outbound.totalEncodeTime;
    out.codec = report.get(outbound.codecId)?.mimeType;
    const src = outbound.mediaSourceId && report.get(outbound.mediaSourceId);
    out.srcFps = src?.framesPerSecond;
    const remote = [...report.values()].find((s) => s.type === 'remote-inbound-rtp' && s.localId === outbound.id);
    if (remote) {
      out.loss = remote.fractionLost ?? 0;
      out.rtt = remote.roundTripTime;
    }
  }
  const pair = selectedPair(report);
  if (pair) {
    out.rtt = pair.currentRoundTripTime ?? out.rtt;
    out.available = pair.availableOutgoingBitrate;
    out.path = connectionType(report, pair);
  }
  if (prev?.bytes != null && out.bytes != null) {
    const dt = (out.ts - prev.ts) / 1000;
    out.bitrate = dt > 0 ? ((out.bytes - prev.bytes) * 8) / dt : 0;
    const frames = out.framesEncoded - prev.framesEncoded;
    out.encodeMs = frames > 0 ? ((out.encodeTime - prev.encodeTime) / frames) * 1000 : prev.encodeMs;
  }
  return out;
}

export async function receiverStats(pc, prev) {
  const report = await pc.getStats();
  const out = { ts: performance.now() };
  let inbound = null;
  let audio = null;
  report.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') inbound = s;
    if (s.type === 'inbound-rtp' && s.kind === 'audio' && (!audio || (s.bytesReceived || 0) > (audio.bytesReceived || 0))) audio = s;
  });
  if (inbound) {
    out.bytes = inbound.bytesReceived;
    out.width = inbound.frameWidth;
    out.height = inbound.frameHeight;
    out.fps = inbound.framesPerSecond || 0;
    out.framesDecoded = inbound.framesDecoded || 0;
    out.framesDropped = inbound.framesDropped || 0;
    out.framesReceived = inbound.framesReceived || 0;
    out.freezes = inbound.freezeCount || 0;
    out.packetsLost = inbound.packetsLost || 0;
    out.packetsReceived = inbound.packetsReceived || 0;
    out.jbDelay = inbound.jitterBufferDelay;
    out.jbEmitted = inbound.jitterBufferEmittedCount;
    out.decodeTime = inbound.totalDecodeTime;
    out.decoder = inbound.decoderImplementation;
    out.hw = inbound.powerEfficientDecoder;
    out.codec = report.get(inbound.codecId)?.mimeType;
  }
  if (audio) out.audioBytes = audio.bytesReceived;
  const pair = selectedPair(report);
  if (pair) {
    out.rtt = pair.currentRoundTripTime;
    out.path = connectionType(report, pair);
  }
  if (prev?.bytes != null && out.bytes != null) {
    const dt = (out.ts - prev.ts) / 1000;
    out.bitrate = dt > 0 ? (((out.bytes - prev.bytes) + ((out.audioBytes || 0) - (prev.audioBytes || 0))) * 8) / dt : 0;
    const decoded = out.framesDecoded - prev.framesDecoded;
    const received = out.framesReceived - prev.framesReceived;
    // Frames actually decoded per second (Safari's framesPerSecond can be
    // missing or lag behind).
    if (dt > 0 && decoded >= 0) out.fps = decoded / dt;
    out.dropRate = received > 0 ? Math.max(0, out.framesDropped - prev.framesDropped) / received : 0;
    out.decodeMs = decoded > 0 && out.decodeTime != null ? ((out.decodeTime - prev.decodeTime) / decoded) * 1000 : prev.decodeMs;
    const emitted = (out.jbEmitted || 0) - (prev.jbEmitted || 0);
    out.jitterMs = emitted > 0 ? ((out.jbDelay - prev.jbDelay) / emitted) * 1000 : prev.jitterMs;
    const lost = out.packetsLost - prev.packetsLost;
    const got = out.packetsReceived - prev.packetsReceived;
    out.loss = lost + got > 0 ? Math.max(0, lost) / (lost + got) : 0;
    out.newFreezes = Math.max(0, out.freezes - prev.freezes);
  }
  if (out.rtt != null) {
    out.latencyMs = Math.round((out.rtt * 1000) / 2 + (out.jitterMs || 0) + (out.decodeMs || 0) + 8);
  }
  return out;
}

export function supportsJitterTarget() {
  return typeof RTCRtpReceiver !== 'undefined' && 'jitterBufferTarget' in RTCRtpReceiver.prototype;
}
