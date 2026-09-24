const ua = navigator.userAgent;

export const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
export const isIPhone = /iPhone|iPod/.test(ua);
export const isIOS = isIPad || isIPhone;
export const isAndroid = /Android/.test(ua);
export const isMobile = isIOS || isAndroid;
export const isWindows = /Windows/.test(ua);
export const isDesktop = !isMobile;
export const isChromium =
  !!navigator.userAgentData?.brands?.some((b) => /Chrom|Edge/i.test(b.brand)) || /Chrome\/|Edg\//.test(ua);

// iPadOS / iOS browsers cannot capture the screen (Apple only allows it in
// native apps). They can still broadcast the camera.
export const canCaptureScreen = isDesktop && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
export const canCaptureCamera = typeof navigator.mediaDevices?.getUserMedia === 'function';

export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  matchMedia('(display-mode: fullscreen)').matches ||
  matchMedia('(display-mode: window-controls-overlay)').matches ||
  navigator.standalone === true;

export function deviceLabel() {
  if (isIPad) return 'iPad';
  if (isIPhone) return 'iPhone';
  if (isAndroid) return 'Android';
  if (isWindows) return 'PC';
  if (/Mac/.test(ua)) return 'Mac';
  return 'Navigateur';
}

export const canElementFullscreen = () =>
  !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);

export const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
