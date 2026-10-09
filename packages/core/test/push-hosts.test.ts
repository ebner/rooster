import { describe, expect, it } from 'vitest';
import { isAllowedPushEndpoint } from '../src/push-hosts.ts';
import { pushSubscriptionCreateSchema } from '../src/schemas/delivery.ts';

describe('push endpoint allowlist (SSRF guard, 04 §4.11)', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGd',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://FCM.googleapis.com./fcm/send/abc',
  ])('allows %s', (url) => {
    expect(isAllowedPushEndpoint(url)).toBe(true);
  });

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://user:pw@fcm.googleapis.com/x',
    'https://evilfcm.googleapis.com.attacker.example/x',
    'https://fcm.googleapis.com.attacker.example/x',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://localhost/x',
    'https://intranet.example.com/x',
    'not a url',
  ])('rejects %s', (url) => {
    expect(isAllowedPushEndpoint(url)).toBe(false);
  });

  it('accepts extra hosts when given', () => {
    expect(isAllowedPushEndpoint('https://push.example.org/x', ['push.example.org'])).toBe(true);
  });

  it('the create schema enforces it', () => {
    const keys = { p256dh: 'k', auth: 'a' };
    expect(
      pushSubscriptionCreateSchema.safeParse({
        endpoint: 'https://fcm.googleapis.com/fcm/send/a',
        keys,
      }).success,
    ).toBe(true);
    expect(
      pushSubscriptionCreateSchema.safeParse({ endpoint: 'https://10.0.0.5/x', keys }).success,
    ).toBe(false);
  });
});
