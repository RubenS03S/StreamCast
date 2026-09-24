export const HOST_NAME = 'Ruben';

// Résolutions (hauteur) utilisées par le mode Auto, de la meilleure à la plus légère.
export const LADDER = [2160, 1440, 1080, 900, 720, 540, 360];

// Débit (bit/s) visé pour du H.264 à 60 FPS, par hauteur. Ajusté ensuite selon codec et FPS.
const BASE_BITRATE = { 2160: 40e6, 1440: 24e6, 1080: 14e6, 900: 10e6, 720: 7e6, 540: 4e6, 360: 2e6 };
const CODEC_EFFICIENCY = { 'video/H264': 1, 'video/VP8': 1.1, 'video/VP9': 0.75, 'video/H265': 0.7, 'video/AV1': 0.65 };

export function bitrateFor(height, fps = 60, mime = 'video/H264') {
  const step = LADDER.find((h) => h <= height) ?? 360;
  const base = BASE_BITRATE[step] * (height / step);
  return base * Math.pow(fps / 60, 0.75) * (CODEC_EFFICIENCY[mime] ?? 1);
}

// « Version de diffusion ».
export const PRESETS = [
  {
    id: 'auto',
    label: 'Auto',
    desc: '60 FPS constants, qualité maximale selon le réseau et l’écran du spectateur',
    maxHeight: 2160, fps: 60, maxBitrate: 60e6, hint: 'motion', degradation: 'maintain-framerate', adaptive: true,
  },
  { id: '4k', label: '4K', desc: '2160p · 60 FPS · jusqu’à 70 Mb/s', maxHeight: 2160, fps: 60, maxBitrate: 70e6, hint: 'motion', degradation: 'maintain-framerate' },
  { id: '1440', label: '1440p', desc: '1440p · 60 FPS · jusqu’à 32 Mb/s', maxHeight: 1440, fps: 60, maxBitrate: 32e6, hint: 'motion', degradation: 'maintain-framerate' },
  { id: '1080', label: '1080p', desc: '1080p · 60 FPS · jusqu’à 18 Mb/s', maxHeight: 1080, fps: 60, maxBitrate: 18e6, hint: 'motion', degradation: 'maintain-framerate' },
  { id: '720', label: '720p', desc: '720p · 60 FPS · jusqu’à 9 Mb/s', maxHeight: 720, fps: 60, maxBitrate: 9e6, hint: 'motion', degradation: 'maintain-framerate' },
  { id: '120', label: '120 FPS', desc: '1080p · 120 FPS · pour écrans 120 Hz (iPhone 17)', maxHeight: 1080, fps: 120, maxBitrate: 30e6, hint: 'motion', degradation: 'maintain-framerate' },
  { id: 'text', label: 'Netteté', desc: 'Résolution native · 30 FPS · idéal pour texte et documents', maxHeight: 2160, fps: 30, maxBitrate: 24e6, hint: 'detail', degradation: 'maintain-resolution' },
  { id: 'eco', label: 'Éco', desc: '720p · 30 FPS · 3 Mb/s · pour la 4G / 5G', maxHeight: 720, fps: 30, maxBitrate: 3e6, hint: 'motion', degradation: 'maintain-framerate' },
];
export const presetById = (id) => PRESETS.find((p) => p.id === id) || PRESETS[0];

export const CODECS = [
  { id: 'auto', label: 'Auto', mime: null },
  { id: 'h264', label: 'H.264', mime: 'video/H264' },
  { id: 'av1', label: 'AV1', mime: 'video/AV1' },
  { id: 'h265', label: 'H.265', mime: 'video/H265' },
  { id: 'vp9', label: 'VP9', mime: 'video/VP9' },
];

// Préférences de qualité côté spectateur (appliquées à son flux uniquement).
export const VIEWER_QUALITY = {
  auto: { label: 'Auto', cap: 'screen' },
  max: { label: 'Max', cap: null },
  saver: { label: 'Économie', cap: 720, fps: 30, maxBitrate: 4e6 },
};

export const REACTIONS = ['🔥', '😂', '😮', '👏', '❤️', '💀'];
