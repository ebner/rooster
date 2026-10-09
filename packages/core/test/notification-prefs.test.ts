import { describe, expect, it } from 'vitest';
import {
  defaultPrefEnabled,
  isPrefCell,
  NOTIFICATION_PREF_CELLS,
} from '../src/notification-prefs.ts';
import { notificationPrefSchema } from '../src/schemas/collab.ts';

describe('notification preference matrix (FR-NOT-4, ADR 0033)', () => {
  it('has every event on every channel, the digest by email and the reminder by push', () => {
    expect(NOTIFICATION_PREF_CELLS).toHaveLength(6 * 3 + 2);
    expect(isPrefCell('digest', 'email')).toBe(true);
    expect(isPrefCell('digest', 'push')).toBe(false);
    expect(isPrefCell('due_reminder', 'push')).toBe(true);
    expect(isPrefCell('due_reminder', 'inapp')).toBe(false);
  });

  it('defaults: in-app and push on, email only for assignments and mentions, opt-in extras', () => {
    expect(defaultPrefEnabled('comment', 'inapp')).toBe(true);
    expect(defaultPrefEnabled('comment', 'push')).toBe(true);
    expect(defaultPrefEnabled('comment', 'email')).toBe(false);
    expect(defaultPrefEnabled('assigned', 'email')).toBe(true);
    expect(defaultPrefEnabled('mention', 'email')).toBe(true);
    expect(defaultPrefEnabled('digest', 'email')).toBe(false);
    expect(defaultPrefEnabled('due_reminder', 'push')).toBe(false);
    expect(defaultPrefEnabled('digest', 'push')).toBe(false);
  });

  it('the schema rejects cells that do not exist', () => {
    expect(
      notificationPrefSchema.safeParse({ type: 'digest', channel: 'email', enabled: true }).success,
    ).toBe(true);
    expect(
      notificationPrefSchema.safeParse({ type: 'digest', channel: 'inapp', enabled: true }).success,
    ).toBe(false);
  });
});
