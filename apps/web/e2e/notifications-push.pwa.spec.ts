import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { swActive } from './support/pwa';
import { expect, test } from './support/test';

/**
 * WP 7.1 against the production build (a real service worker). Headless Chromium has no push
 * service and denies notifications, so the permission and `PushManager` are stubbed: `subscribe` returns a subscription on an FCM-shaped
 * endpoint (the server accepts only known push hosts, ADR 0033). The server's attempt to
 * deliver to it fails, so "Send test" is checked by its request, not by a notification.
 */

/** Set to a directory to keep a screenshot of the device list. */
const shots = process.env.ROOSTER_P7_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Headless Chromium answers every notification permission with `denied`: stub the
    // prompt, which grants once asked (a user gesture on the button).
    let permission: NotificationPermission = 'default';
    Object.defineProperty(Notification, 'permission', { get: () => permission });
    Notification.requestPermission = async () => {
      permission = 'granted';
      return permission;
    };
    // A valid uncompressed P-256 point and 16 random bytes, as browsers hand them out.
    const p256dh =
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
    const auth = 'tBHItJI5svbpez7KI4CCXg';
    let current: PushSubscription | null = null;
    const make = (options: PushSubscriptionOptionsInit): PushSubscription => {
      const key = options.applicationServerKey as Uint8Array;
      const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${crypto.randomUUID()}`;
      const subscription = {
        endpoint,
        expirationTime: null,
        options: { applicationServerKey: key.slice().buffer, userVisibleOnly: true },
        getKey: () => null,
        toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }),
        unsubscribe: async () => {
          current = null;
          // Survives the full page load sign-out ends with.
          sessionStorage.setItem('e2e-push-unsubscribed', endpoint);
          return true;
        },
      };
      return subscription as unknown as PushSubscription;
    };
    PushManager.prototype.subscribe = async (options?: PushSubscriptionOptionsInit) => {
      current = make(options ?? {});
      return current;
    };
    PushManager.prototype.getSubscription = async () => current;
  });
});

test('WP 7.1 turning push on registers this device; send a test; turn it off', async ({ page }) => {
  await signInAs(page, uniqueEmail('pia.push'));
  await swActive(page);
  await page.goto('/settings/notifications');
  const state = page.getByTestId('push-state');
  await expect(state).toHaveAttribute('data-state', 'off');
  await expect(page.getByText('No devices yet.')).toBeVisible();

  const registered = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/me/push-subscriptions') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Turn on push for this device' }).click();
  const post = await registered;
  expect(post.ok()).toBe(true);
  const body = post.request().postDataJSON() as { endpoint: string; keys: unknown };
  expect(body.endpoint).toMatch(/^https:\/\/fcm\.googleapis\.com\/fcm\/send\/e2e-/);

  await expect(state).toHaveAttribute('data-state', 'on');
  await expect(page.getByText('Push is on for this device.')).toBeVisible();
  const devices = page.getByTestId('push-devices');
  await expect(devices.getByRole('listitem')).toHaveCount(1);
  await expect(devices.getByText('This device')).toBeVisible();
  await expect(devices.getByText('Nothing delivered yet')).toBeVisible();
  if (shots) {
    await page.getByRole('heading', { name: 'Push on this device' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/push-devices-on.png` });
  }

  const sent = page.waitForResponse(
    (r) =>
      /\/api\/v1\/me\/push-subscriptions\/[^/]+\/test$/.test(r.url()) &&
      r.request().method() === 'POST',
  );
  await devices.getByRole('button', { name: /^Send a test notification to / }).click();
  const response = await sent;

  // The fake endpoint never receives anything: when FCM answers that it does not know it, the
  // server drops the subscription (410 push_gone) and this device reads as off again.
  if (response.status() === 410) {
    await expect(
      page.getByText('That device is no longer subscribed and was removed.', { exact: false }),
    ).toBeVisible();
  } else {
    await page.getByRole('button', { name: 'Turn off' }).click();
  }
  await expect(state).toHaveAttribute('data-state', 'off');
  await expect(page.getByText('No devices yet.')).toBeVisible();
});

test('P1 signing out on a shared browser removes this device and unsubscribes it', async ({
  page,
}) => {
  await signInAs(page, uniqueEmail('sam.shared'));
  await swActive(page);
  await page.goto('/settings/notifications');
  const registered = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/me/push-subscriptions') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Turn on push for this device' }).click();
  const device = (await (await registered).json()) as { id: string };
  await expect(page.getByTestId('push-state')).toHaveAttribute('data-state', 'on');
  const endpoint = ((await (await registered).request().postDataJSON()) as { endpoint: string })
    .endpoint;

  // The DELETE goes out while the session is still valid, before sign-out ends it.
  const removed = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/v1/me/push-subscriptions/${device.id}`) &&
      r.request().method() === 'DELETE',
  );
  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  expect((await removed).ok()).toBe(true);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to rooster' })).toBeVisible();
  expect((await apiCall(page, 'GET', '/api/v1/me')).status()).toBe(401);
  expect(await page.evaluate(() => sessionStorage.getItem('e2e-push-unsubscribed'))).toBe(endpoint);
  const markers = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.endsWith('.pushDevice')),
  );
  expect(markers).toEqual([]);
});
