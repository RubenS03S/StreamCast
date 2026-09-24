import { later, wait } from './util.js';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(op, payload = {}, { timeout = 10000, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch('/api/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, ...payload }),
        signal: ctrl.signal,
        cache: 'no-store',
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) return json;
      const err = new ApiError(json.error || `HTTP ${res.status}`, res.status);
      if (res.status < 500 || attempt >= retries) throw err;
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) throw err;
      if (attempt >= retries) throw err instanceof ApiError ? err : new ApiError('network', 0);
    } finally {
      clearTimeout(timer);
    }
    await wait(500 * (attempt + 1));
  }
}

const FALLBACK_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
let icePromise = null;
let iceFetchedAt = 0;

export function getIceServers() {
  if (!icePromise || Date.now() - iceFetchedAt > 6 * 3600_000) {
    iceFetchedAt = Date.now();
    icePromise = api('ice', {}, { timeout: 5000, retries: 1 })
      .then((r) => ({ servers: r.iceServers?.length ? r.iceServers : FALLBACK_ICE, relay: !!r.relay }))
      .catch(() => {
        icePromise = null;
        return { servers: FALLBACK_ICE, relay: false };
      });
  }
  return icePromise;
}

// Polls a mailbox on the signaling server. Fast while a handshake is running,
// slow otherwise. `kick()` wakes it up immediately.
export class Poller {
  constructor({ payload, onResult, onError, idle = 1500, fast = 350 }) {
    this.payload = payload;
    this.onResult = onResult;
    this.onError = onError;
    this.idle = idle;
    this.fastInterval = fast;
    this.fastUntil = 0;
    this.errors = 0;
    this.running = false;
    this.cancelWait = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    this.cancelWait?.();
  }

  boost(ms = 10000) {
    this.fastUntil = Date.now() + ms;
    this.kick();
  }

  kick() {
    const cancel = this.cancelWait;
    if (cancel) {
      this.cancelWait = null;
      cancel(true);
    }
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const stop = later(() => {
        this.cancelWait = null;
        resolve();
      }, ms);
      this.cancelWait = () => {
        stop();
        resolve();
      };
    });
  }

  async loop() {
    while (this.running) {
      try {
        const result = await api('poll', this.payload, { timeout: 8000, retries: 0 });
        this.errors = 0;
        if (this.running) await this.onResult(result);
      } catch (err) {
        this.errors++;
        if (this.running) this.onError?.(err, this.errors);
      }
      if (!this.running) break;
      const base = Date.now() < this.fastUntil ? this.fastInterval : this.idle;
      await this.sleep(this.errors ? Math.min(8000, base * (1 + this.errors)) : base);
    }
  }
}
