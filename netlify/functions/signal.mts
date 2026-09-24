import type { Config, Context } from '@netlify/functions';
import { getDeployStore, getStore } from '@netlify/blobs';
import { createSignaling } from '../lib/signal-core.mjs';

type Handler = (req: Request) => Promise<Response>;
let handler: Handler | null = null;

function getHandler(): Handler {
  if (handler) return handler;
  // Production uses a global store; previews and branch deploys get their own
  // deploy-scoped store so test sessions never collide with the real one.
  const options = { name: 'streamcast-signal', consistency: 'strong' as const };
  const blobs = Netlify.context?.deploy?.context === 'production' ? getStore(options) : getDeployStore(options);

  const store = {
    get: (key: string) => blobs.get(key, { type: 'json' }),
    set: (key: string, value: unknown) => blobs.setJSON(key, value),
    del: (key: string) => blobs.delete(key),
    list: async (prefix: string) => (await blobs.list({ prefix })).blobs.map((b) => b.key),
  };
  handler = createSignaling(store, (name: string) => Netlify.env.get(name)) as Handler;
  return handler;
}

export default async (req: Request, _context: Context) => getHandler()(req);

export const config: Config = {
  path: '/api/signal',
};
