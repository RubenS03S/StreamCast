// StreamCast signaling core.
// Only used to connect the two devices (code → WebRTC offer/answer). Once the
// peer connection is up, everything (video, audio, chat, controls) flows
// directly between the devices and this server is no longer involved.
//
// The same logic runs in the Netlify function (Netlify Blobs store) and in the
// local dev server (in-memory store). A store must implement:
//   get(key) -> object | null, set(key, obj), del(key), list(prefix) -> string[]

const LIVE_TIMEOUT_MS = 25_000;
const HEARTBEAT_WRITE_MS = 4_000;
const ROOM_RECLAIM_MS = 30 * 24 * 3600_000;
const MAX_BODY = 96 * 1024;

const RE_CODE = /^\d{3,4}$/;
const RE_ID = /^[a-z0-9]{8,32}$/;
const RE_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

const DEFAULT_STUN = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function randomString(len, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function randomCode(digits) {
  const min = 10 ** (digits - 1);
  const span = 9 * min;
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(min + (n[0] % span));
}

const msgKey = () => `${Date.now().toString(36).padStart(9, '0')}-${randomString(6)}`;
const isLive = (room, now) => !!room && room.live && now - room.lastSeen < LIVE_TIMEOUT_MS;

let turnCache = null;

async function iceServers(env) {
  const servers = [...DEFAULT_STUN];
  const urls = env('TURN_URLS');
  if (urls) {
    servers.push({
      urls: urls.split(',').map((u) => u.trim()).filter(Boolean),
      username: env('TURN_USERNAME') || undefined,
      credential: env('TURN_CREDENTIAL') || undefined,
    });
  }
  const keyId = env('CF_TURN_KEY_ID');
  const apiToken = env('CF_TURN_API_TOKEN');
  if (keyId && apiToken) {
    if (!turnCache || turnCache.expires < Date.now()) {
      try {
        const res = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ttl: 86400 }),
          },
        );
        if (res.ok) {
          const json = await res.json();
          const list = Array.isArray(json.iceServers) ? json.iceServers : [json.iceServers];
          turnCache = { list: list.filter(Boolean), expires: Date.now() + 12 * 3600_000 };
        }
      } catch {
        // TURN is optional: fall back to STUN only.
      }
    }
    if (turnCache) servers.push(...turnCache.list);
  }
  return { iceServers: servers, relay: servers.length > DEFAULT_STUN.length };
}

export function createSignaling(store, env = () => undefined) {
  const roomKey = (code) => `rooms/${code}`;
  const boxPrefix = (code, to) => `box/${code}/${to}/`;

  async function clearBoxes(code) {
    const keys = await store.list(`box/${code}/`);
    await Promise.all(keys.map((k) => store.del(k)));
  }

  async function requireHost(code, token) {
    if (!RE_CODE.test(code || '') || !RE_TOKEN.test(token || '')) throw new HttpError(400, 'bad-request');
    const room = await store.get(roomKey(code));
    if (!room || room.token !== token) throw new HttpError(403, 'not-host');
    return room;
  }

  async function drain(code, id) {
    const keys = (await store.list(boxPrefix(code, id))).sort();
    if (!keys.length) return [];
    const items = await Promise.all(keys.map((k) => store.get(k)));
    await Promise.all(keys.map((k) => store.del(k)));
    return items.filter(Boolean);
  }

  const ops = {
    async ice() {
      return iceServers(env);
    },

    async create({ code, token, digits, name }) {
      const now = Date.now();
      const wanted = digits === 4 ? 4 : 3;
      const hostToken = RE_TOKEN.test(token || '') ? token : randomString(32, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
      const fresh = { token: hostToken, live: true, lastSeen: now, since: now, name: String(name || '').slice(0, 40) };

      if (RE_CODE.test(code || '') && code.length === wanted) {
        const room = await store.get(roomKey(code));
        const free = !room || room.token === hostToken || (!isLive(room, now) && now - room.lastSeen > ROOM_RECLAIM_MS);
        if (free) {
          await clearBoxes(code);
          await store.set(roomKey(code), fresh);
          return { code, token: hostToken };
        }
      }

      for (let i = 0; i < 40; i++) {
        const c = randomCode(i < 25 ? wanted : 4);
        const room = await store.get(roomKey(c));
        if (!room || (!isLive(room, now) && now - room.lastSeen > ROOM_RECLAIM_MS)) {
          await clearBoxes(c);
          await store.set(roomKey(c), fresh);
          return { code: c, token: hostToken };
        }
      }
      throw new HttpError(503, 'no-code-available');
    },

    async status({ code }) {
      if (!RE_CODE.test(code || '')) throw new HttpError(400, 'bad-code');
      const room = await store.get(roomKey(code));
      return { exists: !!room, live: isLive(room, Date.now()), name: room?.name || '' };
    },

    async join({ code, name, clientId, caps }) {
      if (!RE_CODE.test(code || '')) throw new HttpError(400, 'bad-code');
      const room = await store.get(roomKey(code));
      if (!room) return { ok: false, reason: 'unknown' };
      if (!isLive(room, Date.now())) return { ok: false, reason: 'offline', name: room.name || '' };
      const viewerId = randomString(16);
      await store.set(`${boxPrefix(code, 'host')}${msgKey()}`, {
        from: viewerId,
        data: {
          type: 'join',
          name: String(name || '').slice(0, 32),
          clientId: RE_ID.test(clientId || '') ? clientId : viewerId,
          caps: caps && typeof caps === 'object' ? caps : {},
        },
      });
      return { ok: true, viewerId, name: room.name || '' };
    },

    async send({ code, from, token, to, data }) {
      if (!RE_CODE.test(code || '') || !data || typeof data !== 'object') throw new HttpError(400, 'bad-request');
      if (from === 'host') {
        await requireHost(code, token);
        if (!RE_ID.test(to || '')) throw new HttpError(400, 'bad-recipient');
      } else {
        if (!RE_ID.test(from || '') || to !== 'host') throw new HttpError(400, 'bad-request');
        const room = await store.get(roomKey(code));
        if (!isLive(room, Date.now())) return { ok: false, reason: 'offline' };
      }
      await store.set(`${boxPrefix(code, to)}${msgKey()}`, { from, data });
      return { ok: true };
    },

    async poll({ code, id, token }) {
      if (id === 'host') {
        const room = await requireHost(code, token);
        const now = Date.now();
        if (!room.live || now - room.lastSeen > HEARTBEAT_WRITE_MS) {
          await store.set(roomKey(code), { ...room, live: true, lastSeen: now });
        }
        return { messages: await drain(code, 'host') };
      }
      if (!RE_CODE.test(code || '') || !RE_ID.test(id || '')) throw new HttpError(400, 'bad-request');
      const [room, messages] = await Promise.all([store.get(roomKey(code)), drain(code, id)]);
      return { messages, live: isLive(room, Date.now()) };
    },

    async end({ code, token }) {
      const room = await requireHost(code, token);
      await store.set(roomKey(code), { ...room, live: false, lastSeen: Date.now() });
      await clearBoxes(code);
      return { ok: true };
    },
  };

  return async function handle(request) {
    if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405);
    let body;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return json({ error: 'too-large' }, 413);
      body = JSON.parse(text);
    } catch {
      return json({ error: 'bad-json' }, 400);
    }
    const op = ops[body?.op];
    if (!op) return json({ error: 'unknown-op' }, 400);
    try {
      return json(await op(body));
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error('[signal]', body.op, err);
      return json({ error: 'server-error' }, 500);
    }
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
