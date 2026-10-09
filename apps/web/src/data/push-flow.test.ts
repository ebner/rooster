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

const {
  base64UrlToBytes,
  disablePush,
  enablePush,
  forgetPushOnSignOut,
  resyncPush,
  UnsupportedPushServiceError,
} = await import('./push');
const { forgetPushBeforeSignOut } = await import('./auth');
const { sweepUserStorage } = await import('../lib/user-storage');

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
      getRegistration: async () => ({
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
    // A renewal of the subscription it replaces (P2: never a fresh, gesture-less subscribe).
    expect(http.POST).toHaveBeenCalledWith('/api/v1/me/push-subscriptions', {
      body: expect.objectContaining({
        endpoint: 'https://fcm.googleapis.com/fcm/send/new',
        renewsEndpoint: 'https://fcm.googleapis.com/fcm/send/old',
      }),
    });
    expect(localStorage.getItem('rooster.user.u1.pushDevice')).toBe('device-1');
  });

  test.each([
    [410, 'push_gone'],
    [409, 'push_endpoint_taken'],
  ])(
    'P2: a device removed elsewhere is not resurrected (%i): unsubscribed, marker dropped',
    async (status, code) => {
      localStorage.setItem('rooster.user.u1.pushDevice', 'device-0');
      current = fakeSubscription(oldKey, 'https://fcm.googleapis.com/fcm/send/old');
      http.POST.mockImplementation(() =>
        Promise.resolve({ error: { code }, response: new Response(null, { status }) }),
      );
      await resyncPush();
      const renewed = current as ReturnType<typeof fakeSubscription> | null;
      expect(renewed?.unsubscribe).toHaveBeenCalled();
      expect(localStorage.getItem('rooster.user.u1.pushDevice')).toBeNull();
    },
  );

  test('P2: with no subscription left to renew, nothing is subscribed and the marker goes', async () => {
    localStorage.setItem('rooster.user.u1.pushDevice', 'device-0');
    current = null;
    await resyncPush();
    expect(subscribe).not.toHaveBeenCalled();
    expect(http.POST).not.toHaveBeenCalled();
    expect(localStorage.getItem('rooster.user.u1.pushDevice')).toBeNull();
  });

  test('a current subscription, or no opt-in here, does nothing', async () => {
    localStorage.setItem('rooster.user.u1.pushDevice', 'device-0');
    current = fakeSubscription(key, 'https://fcm.googleapis.com/fcm/send/same');
    await resyncPush();
    localStorage.clear();
    await resyncPush();
    expect(subscribe).not.toHaveBeenCalled();
    expect(http.POST).not.toHaveBeenCalled();
  });
});

describe('P1: push does not survive sign-out on a shared browser', () => {
  test('sign-out deletes the device on the server, unsubscribes, then drops the marker', async () => {
    await enablePush(new QueryClient(), 'u1', key);
    const subscription = current;
    await forgetPushBeforeSignOut();
    expect(http.DELETE).toHaveBeenCalledWith('/api/v1/me/push-subscriptions/{id}', {
      params: { path: { id: 'device-1' } },
    });
    expect(subscription?.unsubscribe).toHaveBeenCalled();
    expect(localStorage.getItem('rooster.user.u1.pushDevice')).toBeNull();
  });

  test('offline: the DELETE fails, the browser still unsubscribes', async () => {
    await enablePush(new QueryClient(), 'u1', key);
    const subscription = current;
    http.DELETE.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    await forgetPushOnSignOut();
    expect(subscription?.unsubscribe).toHaveBeenCalled();
    expect(localStorage.getItem('rooster.user.u1.pushDevice')).toBeNull();
  });

  test('a hung cleanup never blocks sign-out', async () => {
    const started = Date.now();
    await forgetPushBeforeSignOut(() => new Promise(() => undefined), 20);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('401 or another user signing in (the sweep): unsubscribes locally, no server call', async () => {
    await enablePush(new QueryClient(), 'u1', key);
    const subscription = current;
    http.DELETE.mockClear();
    sweepUserStorage('u2');
    await vi.waitFor(() => expect(subscription?.unsubscribe).toHaveBeenCalled());
    expect(http.DELETE).not.toHaveBeenCalled();
    expect(localStorage.getItem('rooster.user.u1.pushDevice')).toBeNull();
  });

  test('a sweep without a push marker leaves push alone', async () => {
    await enablePush(new QueryClient(), 'u1', key);
    const subscription = current;
    sweepUserStorage('u1');
    await Promise.resolve();
    expect(subscription?.unsubscribe).not.toHaveBeenCalled();
  });
});
