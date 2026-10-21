import { createHash, randomBytes } from 'node:crypto';
import type { OAuthDeviceMode } from '../config.ts';

// The codes of the device authorization grant (RFC 8628, 11 §9.2) and the per-user limit on
// code entry at `/device`. Both codes are stored only as SHA-256 hashes (04 §4).

/** `rooster-cli`, the first-party client (07 §2). */
const FIRST_PARTY_CLIENT = 'rooster-cli';

/** The operator's switch (11 §9.1): may this client use the device grant? */
export function deviceGrantAllowed(mode: OAuthDeviceMode, clientId: string): boolean {
  if (mode === 'off') return false;
  return clientId === FIRST_PARTY_CLIENT || mode === 'all';
}

/** A device code lives 10 minutes (11 §9.2). */
export const DEVICE_CODE_TTL_MS = 10 * 60_000;
/** The polling interval a device starts with; `slow_down` adds `DEVICE_SLOW_DOWN_MS`. */
export const DEVICE_POLL_INTERVAL_MS = 5_000;
export const DEVICE_SLOW_DOWN_MS = 5_000;
/** A device that keeps polling too fast is never slowed beyond this. */
export const DEVICE_POLL_INTERVAL_MAX_MS = 60_000;

/** Upper case letters and digits without 0, 1, I and O (RFC 8628 §6.1): 32 symbols, 5 bits. */
const USER_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USER_CODE_LENGTH = 8;

/** `storeTokens: 'hashed'` style: SHA-256, base64url without padding. */
export function hashDeviceSecret(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

/** User codes are shown as `ABCD-EFGH`; typed codes may carry dashes, spaces or lower case. */
export function normalizeUserCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/** The stored form of a user code as typed: its normalised spelling, hashed. */
export function userCodeHash(input: string): string {
  return hashDeviceSecret(normalizeUserCode(input));
}

/** 256 random bits, base64url (RFC 8628 §5.2: the device code must not be guessable). */
export function generateDeviceCode(): string {
  return randomBytes(32).toString('base64url');
}

/** 8 symbols of 5 bits each (40 bits); 32 divides 256, so taking each byte mod 32 is unbiased. */
export function generateUserCode(): string {
  return [...randomBytes(USER_CODE_LENGTH)]
    .map((byte) => USER_CODE_CHARSET[byte % USER_CODE_CHARSET.length])
    .join('');
}

/** `ABCDEFGH` → `ABCD-EFGH`. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** 11 §9.2: wrong codes typed at `/device` per user, and the window they count in. */
export const USER_CODE_MISS_LIMIT = { max: 10, windowMs: 10 * 60_000 };

/**
 * Wrong user codes per user (11 §9.2, §9.5): after `max` misses within the window, code entry
 * is locked for that user until the oldest miss leaves the window, whatever is typed. With 40
 * bits per code this keeps a guess's chance below 2⁻³² per user and code lifetime. In memory,
 * like the other limiters (a single process serves the instance).
 */
export class UserCodeMisses {
  private readonly misses = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly options = USER_CODE_MISS_LIMIT) {}

  /** 0 when the user may try a code, else the ms until they may again. */
  lockedFor(userId: string, now: number): number {
    const recent = this.recent(userId, now);
    if (recent.length < this.options.max) return 0;
    return Math.max(1, (recent[0] ?? now) + this.options.windowMs - now);
  }

  record(userId: string, now: number): void {
    this.sweep(now);
    const recent = this.recent(userId, now);
    recent.push(now);
    this.misses.set(userId, recent);
  }

  private recent(userId: string, now: number): number[] {
    const since = now - this.options.windowMs;
    return (this.misses.get(userId) ?? []).filter((t) => t > since);
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.options.windowMs) return;
    this.lastSweep = now;
    const since = now - this.options.windowMs;
    for (const [key, list] of this.misses) {
      if ((list[list.length - 1] ?? 0) <= since) this.misses.delete(key);
    }
  }
}
