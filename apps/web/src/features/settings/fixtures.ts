import type { PushSubscriptionInfo } from '@rooster/core/schemas';
import type { UserSession } from '../../data/types';

const minute = 60 * 1000;
const day = 24 * 60 * minute;
const now = Date.now();

export const fixtureSessions: UserSession[] = [
  {
    id: 'session-current',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    ipAddress: '192.168.1.20',
    createdAt: now - 12 * day,
    lastActiveAt: now,
    isCurrent: true,
  },
  {
    id: 'session-phone',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    ipAddress: '83.250.12.7',
    createdAt: now - 20 * day,
    lastActiveAt: now - 3 * 60 * minute,
    isCurrent: false,
  },
  {
    id: 'session-laptop',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
    ipAddress: '10.0.0.14',
    createdAt: now - 25 * day,
    lastActiveAt: now - 4 * day,
    isCurrent: false,
  },
];

/** Settings → Notifications → Push: three devices, one never delivered to (kitchen sink). */
export const fixturePushDevices: PushSubscriptionInfo[] = [
  {
    id: 'push-laptop',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    createdAt: now - 12 * day,
    lastOkAt: now - 25 * minute,
  },
  {
    id: 'push-phone',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    createdAt: now - 20 * day,
    lastOkAt: now - 2 * day,
  },
  {
    id: 'push-firefox',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
    createdAt: now - day,
    lastOkAt: null,
  },
];
