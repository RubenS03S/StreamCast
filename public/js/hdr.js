// HDR screens on Windows: depending on the capture path, an HDR desktop can
// reach the stream too bright and washed out. The SDR picture is scaled by
// Windows' "SDR content brightness" (factor k) and clipped to 8 bits.
//
// - measureSdrScale() measures k with a short black/grey calibration shown in
//   the StreamCast window (k ≈ 1: the capture is already correct).
// - createColorPipeline() undoes it on the GPU (WebGL, in a worker) before the
//   picture is encoded: midtones come back to their real level, white stays
//   white. It can also downscale 4K to the size actually sent.

export const hdrDisplay = () => matchMedia('(dynamic-range: high)').matches;

export const canProcessVideo = () =>
  'MediaStreamTrackProcessor' in window && 'MediaStreamTrackGenerator' in window && typeof OffscreenCanvas !== 'undefined';

// sRGB value of the calibration grey: 10 % linear light.
const PATCH = 89;
const PATCH_LINEAR = 0.1;

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

// --------------------------------------------------------------- pipeline
const WORKER = `
let gl, canvas, uK, k = 1, maxH = 0, w = 0, h = 0, ready = false, frames = 0, busy = 0;
const VS = \`#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}\`;
const FS = \`#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D tex;
uniform float k;
vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 l) { l = clamp(l, 0.0, 1.0); return mix(l * 12.92, 1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, l)); }
void main() {
  vec3 lin = toLin(texture(tex, uv).rgb);
  // Undo the SDR brightness gain; the shoulder keeps white at white.
  vec3 fixedLin = lin / k + (1.0 - 1.0 / k) * pow(lin, vec3(6.0));
  color = vec4(toSrgb(fixedLin), 1.0);
}\`;

function setup() {
  canvas = new OffscreenCanvas(16, 16);
  gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!gl) return false;
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  uK = gl.getUniformLocation(prog, 'k');
  gl.bindVertexArray(gl.createVertexArray());
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return true;
}

function resize(tw, th) {
  if (tw === w && th === h) return;
  w = tw;
  h = th;
  canvas.width = w;
  canvas.height = h;
  gl?.viewport(0, 0, w, h);
  postMessage({ size: [w, h] });
}

async function run(readable, writable) {
  try {
    ready = setup();
  } catch (err) {
    postMessage({ error: String(err) });
    ready = false;
  }
  if (!ready) postMessage({ error: 'webgl2' });
  const reader = readable.getReader();
  const writer = writable.getWriter();
  for (;;) {
    const { value: frame, done } = await reader.read();
    if (done) break;
    let out = frame;
    const fw = frame.displayWidth;
    const fh = frame.displayHeight;
    const scale = maxH && fh > maxH ? maxH / fh : 1;
    if (ready && (k > 1.001 || scale < 1)) {
      const t0 = performance.now();
      try {
        resize(Math.round((fw * scale) / 2) * 2, Math.round((fh * scale) / 2) * 2);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        gl.uniform1f(uK, Math.max(1, k));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        out = new VideoFrame(canvas, { timestamp: frame.timestamp, alpha: 'discard' });
        frame.close();
        busy += performance.now() - t0;
      } catch (err) {
        postMessage({ error: String(err) });
        out = frame;
      }
    } else {
      if (fw !== w || fh !== h) {
        w = fw;
        h = fh;
        postMessage({ size: [w, h] });
      }
    }
    frames++;
    try {
      await writer.write(out);
    } catch {
      break;
    }
  }
  writer.close().catch(() => {});
}

setInterval(() => {
  postMessage({ fps: frames, ms: frames ? busy / frames : 0 });
  frames = 0;
  busy = 0;
}, 1000);

onmessage = ({ data }) => {
  if ('k' in data) k = data.k;
  if ('maxHeight' in data) maxH = data.maxHeight;
  if (data.readable) run(data.readable, data.writable);
};
`;

export function createColorPipeline(track, { k = 1, maxHeight = 0 } = {}) {
  const processor = new MediaStreamTrackProcessor({ track, maxBufferSize: 2 });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })));
  const pipe = {
    track: generator,
    size: null,
    fps: 0,
    ms: 0,
    error: null,
    onSize: null,
    setK(value) {
      worker.postMessage({ k: value });
    },
    setMaxHeight(value) {
      worker.postMessage({ maxHeight: value });
    },
    stop() {
      worker.terminate();
      generator.stop();
    },
  };
  worker.onmessage = ({ data }) => {
    if (data.size) {
      pipe.size = { width: data.size[0], height: data.size[1] };
      pipe.onSize?.(pipe.size);
    }
    if (typeof data.fps === 'number') {
      pipe.fps = data.fps;
      pipe.ms = data.ms;
    }
    if (data.error) pipe.error = data.error;
  };
  worker.onerror = (e) => {
    pipe.error = e.message || 'worker';
  };
  worker.postMessage({ readable: processor.readable, writable: generator.writable, k, maxHeight }, [
    processor.readable,
    generator.writable,
  ]);
  return pipe;
}

// ------------------------------------------------------------ calibration
const nextFrames = (n = 2) =>
  new Promise((resolve) => {
    const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns a function that grabs the current captured frame as an ImageBitmap
// or a video element that can be drawn to a canvas.
async function frameSource(track) {
  if ('ImageCapture' in window) {
    const ic = new ImageCapture(track);
    return {
      grab: () => Promise.race([ic.grabFrame(), sleep(1500).then(() => null)]),
      close() {},
    };
  }
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  video.srcObject = new MediaStream([track]);
  document.body.append(video);
  await video.play().catch(() => {});
  return {
    grab: async () => (video.videoWidth ? video : null),
    close: () => video.remove(),
  };
}

// Reads the brightness at a few points of the StreamCast window, as seen in
// the captured frame. Median of the points, 0..255.
function sampleWindow(img) {
  const iw = img.width || img.videoWidth;
  const ih = img.height || img.videoHeight;
  if (!iw || !ih) return null;
  const dpr = window.devicePixelRatio || 1;
  const left = screen.left ?? screen.availLeft ?? 0;
  const top = screen.top ?? screen.availTop ?? 0;
  const border = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const vx = window.screenX - left + border;
  const vy = window.screenY - top + Math.max(0, window.outerHeight - window.innerHeight - border);
  const scale = iw / (screen.width * dpr);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 9;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const values = [];
  for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.3], [0.5, 0.5], [0.3, 0.7], [0.7, 0.7]]) {
    const px = (vx + fx * window.innerWidth) * dpr * scale;
    const py = (vy + fy * window.innerHeight) * dpr * scale;
    if (px < 4 || py < 4 || px > iw - 5 || py > ih - 5) continue;
    ctx.drawImage(img, px - 4, py - 4, 9, 9, 0, 0, 9, 9);
    const d = ctx.getImageData(0, 0, 9, 9).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    values.push(sum / (d.length / 4));
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

async function grabSample(source) {
  const img = await source.grab();
  if (!img) return null;
  const value = sampleWindow(img);
  img.close?.();
  return value;
}

// { ok: true, k } when the StreamCast window was found in the capture.
export async function measureSdrScale(track) {
  if (!track || track.readyState !== 'live') return { ok: false, reason: 'no-track' };
  let source;
  try {
    source = await frameSource(track);
  } catch {
    return { ok: false, reason: 'unsupported' };
  }
  const overlay = document.createElement('div');
  overlay.className = 'calib';
  overlay.innerHTML = '<span>Réglage des couleurs…</span>';
  overlay.style.background = '#000';
  document.body.append(overlay);
  try {
    await nextFrames(2);
    await sleep(450);
    const dark = await grabSample(source);
    overlay.style.background = `rgb(${PATCH},${PATCH},${PATCH})`;
    await nextFrames(2);
    await sleep(450);
    const grey = await grabSample(source);
    if (dark == null || grey == null) return { ok: false, reason: 'no-frame' };
    if (dark > 60 || grey - dark < 20) return { ok: false, reason: 'not-visible' };
    const k = toLinear(Math.min(254.5, grey) / 255) / PATCH_LINEAR;
    return { ok: true, k: Math.min(8, Math.max(1, k)), raw: k };
  } catch {
    return { ok: false, reason: 'error' };
  } finally {
    overlay.remove();
    source.close();
  }
}
