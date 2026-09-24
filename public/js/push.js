// "Ruben est en live" notifications on the spectateur's device (Web Push).
// On iPad/iPhone, Apple only allows them for the app added to the Home
// Screen, and the permission must be asked from a tap.
import { api } from './api.js';
import { storage, clientId } from './util.js';
import { isIOS, isStandalone } from './device.js';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// iOS in Safari (not the Home Screen app): push exists only once installed.
export const pushNeedsInstall = () => isIOS && !isStandalone();

export const pushEnabled = (code) =>
  pushSupported() && Notification.permission === 'granted' && storage.get('pushCode') === code;

const toBytes = (b64u) => {
  const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64u.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

// Must be called from a tap (the permission prompt needs it on iOS).
export async function enablePush(code) {
  if (!pushSupported()) throw new Error(pushNeedsInstall() ? 'install' : 'unsupported');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('denied');
  const reg = await withTimeout(navigator.serviceWorker.ready, 8000);
  const { publicKey } = await api('push-key');
  const key = toBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    // Keys changed on the server: subscribe again with the new one.
    const current = sub.options?.applicationServerKey;
    if (current && new Uint8Array(current).toString() !== key.toString()) {
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
  }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('push-subscribe', { code, clientId: clientId(), subscription: sub.toJSON() });
  storage.set('pushCode', code);
}

export async function disablePush(code) {
  storage.set('pushCode', null);
  await api('push-unsubscribe', { code, clientId: clientId() }).catch(() => {});
}
