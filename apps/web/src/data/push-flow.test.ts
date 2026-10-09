import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const http = vi.hoisted(() => ({
  GET: vi.fn(),
  POST: vi.fn(),
  DELETE: vi.fn(),
}));
vi.mock('./http', async (original) => ({
  ...(await original<typeof import('./http')>()),
  api: http,
}));

const { base64UrlToBytes, disablePush, enablePush, resyncPush, UnsupportedPushServiceError } =
  await import('./push');

const key =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const oldKey = `${key.slice(0, -2)}AA`;
const ok = (data: unknown) =>
  Promise.resolve({ data, response: new Response(null, { status: 200 }) });

function fakeSubscription(applicationServerKey: string, endpoint: string) {
  return {
    endpoint,
    options: { applicationServerKey: base64UrlToBytes(applicationServerKey).buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true),
  };
}

let current: ReturnType<typeof fakeSubscription> | null = null;
const subscribe = vi.fn(async () => {
  current = fakeSubscription(key, 'https://fcm.googleapis.com/fcm/send/new');
  return current;
});

beforeEach(() => {
  current = null;
  localStorage.clear();
  vi.stubGlobal('Notification', {
    permission: 'granted',
    requestPermission: vi.fn(async () => 'granted'),
  });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: { getSubscription: async () => current, subscribe },
      }),
    },
  });
  http.GET.mockImplementation(() => ok({ publicKey: key }));
  http.POST.mockImplementation(() =>
    ok({ id: 'device-1', userAgent: null, createdAt: 1, lastOkAt: null }),
  );
  http.DELETE.mockImplementation(() => ok(undefined));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('turning push on and off', () => {
  test('subscribes with the key, registers the device and marks it for this user', async () => {
    const result = await enablePush(new QueryClient(), 'u1', key);
    expect(result).toBe('on');
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(key),
    });
    expect(http.POST).toHaveBeenCalledWith('/api/v1/me/push-subscriptions', {
      body: expect.objectContaining({ endpoint: 'https://fcm.googleapis.com/fcm/send/new' }),
    });
    expect(localStorage.getItem('rooster.user.u1.pushDevice')).toBe('device-1');

    await disablePush(new QueryClient(), 'u1');
    expect(http.DELETE).toHaveBeenCalled();
    expect(localStorage.getItem('rooster.user.u1.pushDevice')).toBeNull();
  });

  test('a refused permission subscribes nothing', async () => {
    vi.stubGlobal('Notification', { requestPermission: vi.fn(async () => 'denied') });
    expect(await enablePush(new QueryClient(), 'u1', key)).toBe('denied');
    expect(subscribe).not.toHaveBeenCalled();
  });

  test('an endpoint off the known push services is refused before the POST', async () => {
    subscribe.mockImplementationOnce(async () => {
      current = fakeSubscription(key, 'https://push.example.net/x');
      return current;
    });
    await expect(enablePush(new QueryClient(), 'u1', key)).rejects.toBeInstanceOf(
      UnsupportedPushServiceError,
    );
    expect(http.POST).not.toHaveBeenCalled();
  });
});

describe('re-subscribing on open (key rotation)', () => {
  test('a subscription on the old key is replaced and registered again', async () => {
    localStorage.setItem('rooster.user.u1.pushDevice', 'device-0');
    const stale = fakeSubscription(oldKey, 'https://fcm.googleapis.com/fcm/send/old');
    current = stale;
    await resyncPush();
    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalled();
    expect(localStorage.getItem('rooster.user.u1.pushDevice')).toBe('device-1');
  });

  test('a current subscription, or no opt-in here, does nothing', async () => {
    localStorage.setItem('rooster.user.u1.pushDevice', 'device-0');
    current = fakeSubscription(key, 'https://fcm.googleapis.com/fcm/send/same');
    await resyncPush();
    localStorage.clear();
    current = null;
    await resyncPush();
    expect(subscribe).not.toHaveBeenCalled();
    expect(http.POST).not.toHaveBeenCalled();
  });
});
