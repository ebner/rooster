import { describe, expect, test, vi } from 'vitest';
import { resubscribeAfterChange } from '../features/pwa/push-resubscribe';
import { pushSupport } from '../features/pwa/push-support';
import { base64UrlToBytes, sameApplicationServerKey, subscriptionBody } from './push';

const key =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

describe('push helpers', () => {
  test('a base64url VAPID key decodes to 65 bytes', () => {
    const bytes = base64UrlToBytes(key);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
  });

  test('a subscription made with another key is stale (key rotation)', () => {
    const current = base64UrlToBytes(key).buffer;
    expect(sameApplicationServerKey(current, key)).toBe(true);
    const other = new Uint8Array(base64UrlToBytes(key));
    other[10] = (other[10] ?? 0) ^ 1;
    expect(sameApplicationServerKey(other.buffer, key)).toBe(false);
    expect(sameApplicationServerKey(null, key)).toBe(false);
  });

  test('the POST body carries endpoint, keys and a capped user agent', () => {
    const body = subscriptionBody(
      {
        toJSON: () => ({
          endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
          keys: { p256dh: 'p', auth: 'a' },
        }),
      },
      'x'.repeat(300),
    );
    expect(body).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'p', auth: 'a' },
      userAgent: 'x'.repeat(256),
    });
  });
});

describe('push support', () => {
  const desktop = {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0.0.0 Safari/537.36',
    maxTouchPoints: 0,
    standalone: false,
    serviceWorker: true,
    pushManager: true,
    notifications: true,
  };
  const iphone =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

  test('a desktop browser with a service worker can turn push on', () => {
    expect(pushSupport(desktop)).toBe('available');
  });

  test('no service worker (vite dev) or no Push API: unsupported', () => {
    expect(pushSupport({ ...desktop, serviceWorker: false })).toBe('unsupported');
    expect(pushSupport({ ...desktop, pushManager: false })).toBe('unsupported');
  });

  test('iOS outside the installed app: install first; installed: available', () => {
    expect(pushSupport({ ...desktop, userAgent: iphone, pushManager: false })).toBe('ios-install');
    expect(pushSupport({ ...desktop, userAgent: iphone, standalone: true })).toBe('available');
  });
});

describe('pushsubscriptionchange', () => {
  const applicationServerKey = () => base64UrlToBytes(key).buffer;
  const fresh = () => ({
    toJSON: () => ({
      endpoint: 'https://fcm.googleapis.com/fcm/send/new',
      keys: { p256dh: 'p', auth: 'a' },
    }),
    unsubscribe: vi.fn(async () => true),
  });
  const oldSubscription = () => ({
    endpoint: 'https://fcm.googleapis.com/fcm/send/old',
    options: { applicationServerKey: applicationServerKey(), userVisibleOnly: true },
  });
  const answer = (status: number) => vi.fn(async (_body: string) => ({ status, ok: status < 300 }));

  test('renews: re-subscribes with the old key and posts the new endpoint as a renewal', async () => {
    const created = fresh();
    const subscribe = vi.fn(async () => created);
    const post = answer(201);
    const result = await resubscribeAfterChange(
      { oldSubscription: oldSubscription(), newSubscription: null },
      { subscribe } as unknown as PushManager,
      post,
      'UA',
    );
    expect(result).toBe('renewed');
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(),
    });
    expect(JSON.parse(post.mock.calls[0]?.[0] ?? '')).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/new',
      keys: { p256dh: 'p', auth: 'a' },
      userAgent: 'UA',
      renewsEndpoint: 'https://fcm.googleapis.com/fcm/send/old',
    });
    expect(created.unsubscribe).not.toHaveBeenCalled();
  });

  test.each([410, 409])(
    'P2: a device removed elsewhere (or another account’s endpoint, %i) is not resurrected',
    async (status) => {
      const created = fresh();
      const result = await resubscribeAfterChange(
        { oldSubscription: oldSubscription(), newSubscription: created },
        { subscribe: vi.fn() } as unknown as PushManager,
        answer(status),
        'UA',
      );
      expect(result).toBe('gone');
      expect(created.unsubscribe).toHaveBeenCalled();
    },
  );

  test('without an old subscription nothing is posted (the next app open decides)', async () => {
    const post = answer(201);
    const created = fresh();
    const result = await resubscribeAfterChange(
      { oldSubscription: null, newSubscription: created },
      { subscribe: vi.fn() } as unknown as PushManager,
      post,
      'UA',
    );
    expect(result).toBe('skipped');
    expect(post).not.toHaveBeenCalled();
  });
});
