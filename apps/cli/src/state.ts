import { join } from 'node:path';
import { readIfExists, writeFileAtomic } from './config.ts';

/** The task `@last` points at (07 §3). */
export interface LastTask {
  id: string;
  orgId: string;
  seq: number | null;
}

interface StateData {
  /** Per profile. */
  last?: Record<string, LastTask>;
  /** Per profile: the server user's locale, so messages need no `/me` round trip. */
  userLocale?: Record<string, string>;
  keychainNoticeShown?: boolean;
}

/** `state.json` in the state dir: small, best effort, never required for correctness. */
export class StateStore {
  readonly path: string;

  constructor(dir: string) {
    this.path = join(dir, 'state.json');
  }

  private read(): StateData {
    try {
      const text = readIfExists(this.path);
      return text === undefined ? {} : (JSON.parse(text) as StateData);
    } catch {
      return {};
    }
  }

  private update(change: (data: StateData) => void): void {
    const data = this.read();
    change(data);
    try {
      writeFileAtomic(this.path, `${JSON.stringify(data, null, 2)}\n`, 0o600);
    } catch {
      // A read-only home must not break a command; `@last` just stays stale.
    }
  }

  last(profile: string): LastTask | undefined {
    return this.read().last?.[profile];
  }

  setLast(profile: string, task: LastTask): void {
    this.update((data) => {
      data.last = { ...data.last, [profile]: task };
    });
  }

  userLocale(profile: string): string | undefined {
    return this.read().userLocale?.[profile];
  }

  setUserLocale(profile: string, locale: string): void {
    if (this.userLocale(profile) === locale) return;
    this.update((data) => {
      data.userLocale = { ...data.userLocale, [profile]: locale };
    });
  }

  forgetProfile(profile: string): void {
    this.update((data) => {
      if (data.last) delete data.last[profile];
      if (data.userLocale) delete data.userLocale[profile];
    });
  }

  /** True the first time only (the keychain fallback notice). */
  takeKeychainNotice(): boolean {
    if (this.read().keychainNoticeShown === true) return false;
    this.update((data) => {
      data.keychainNoticeShown = true;
    });
    return true;
  }
}
