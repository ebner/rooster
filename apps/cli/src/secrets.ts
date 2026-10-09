import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { readIfExists, writeFileAtomic } from './config.ts';

/** Where a profile's token is kept (07 §2). */
export interface SecretStore {
  get(profile: string): Promise<string | undefined>;
  set(profile: string, token: string): Promise<'keychain' | 'file'>;
  delete(profile: string): Promise<void>;
}

const SERVICE = 'rooster';

interface KeyringEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
type KeyringFactory = (service: string, account: string) => KeyringEntry;

/**
 * The OS keychain through `@napi-rs/keyring`, imported lazily: a compiled binary or a host
 * without a native build (or without a Secret Service, as in headless Linux and containers)
 * falls back to the credentials file. Null when the module cannot be loaded.
 */
export async function loadKeyring(): Promise<KeyringFactory | null> {
  try {
    const mod = await import('@napi-rs/keyring');
    return (service, account) => new mod.AsyncEntry(service, account);
  } catch {
    return null;
  }
}

/** `credentials` next to `config.toml`, mode 0600: `[profiles.<name>] token = "…"`. */
export class FileSecretStore implements SecretStore {
  readonly path: string;

  constructor(dir: string) {
    this.path = join(dir, 'credentials');
  }

  private read(): Record<string, { token?: string }> {
    const text = readIfExists(this.path);
    if (text === undefined) return {};
    try {
      const raw = parse(text) as { profiles?: Record<string, { token?: string }> };
      return raw.profiles ?? {};
    } catch {
      return {};
    }
  }

  private write(profiles: Record<string, { token?: string }>): void {
    writeFileAtomic(this.path, `${stringify({ profiles })}\n`, 0o600);
  }

  async get(profile: string): Promise<string | undefined> {
    const token = this.read()[profile]?.token;
    return typeof token === 'string' && token !== '' ? token : undefined;
  }

  async set(profile: string, token: string): Promise<'file'> {
    this.write({ ...this.read(), [profile]: { token } });
    return 'file';
  }

  async delete(profile: string): Promise<void> {
    const profiles = this.read();
    if (!(profile in profiles)) return;
    delete profiles[profile];
    this.write(profiles);
  }
}

/**
 * Keychain first, file second. Reads check both (a token may have been stored in the file
 * while the keychain was unavailable); `onFallback` fires when a write had to use the file.
 */
export class LayeredSecretStore implements SecretStore {
  private keyring: Promise<KeyringFactory | null> | undefined;

  constructor(
    private readonly file: FileSecretStore,
    private readonly loadKeyringFn: () => Promise<KeyringFactory | null>,
    private readonly onFallback: () => void,
  ) {}

  private entry(profile: string): Promise<KeyringEntry | null> {
    this.keyring ??= this.loadKeyringFn();
    return this.keyring.then((factory) => (factory === null ? null : factory(SERVICE, profile)));
  }

  async get(profile: string): Promise<string | undefined> {
    try {
      const token = await (await this.entry(profile))?.getPassword();
      if (token !== undefined && token !== null && token !== '') return token;
    } catch {
      // A locked or missing keychain: the file may still hold it.
    }
    return this.file.get(profile);
  }

  async set(profile: string, token: string): Promise<'keychain' | 'file'> {
    try {
      const entry = await this.entry(profile);
      if (entry !== null) {
        await entry.setPassword(token);
        // A token from an earlier fallback must not shadow or outlive the new one.
        await this.file.delete(profile);
        return 'keychain';
      }
    } catch {
      // Fall through to the file.
    }
    this.onFallback();
    return this.file.set(profile, token);
  }

  async delete(profile: string): Promise<void> {
    try {
      await (await this.entry(profile))?.deletePassword();
    } catch {
      // Nothing stored there, or no keychain.
    }
    await this.file.delete(profile);
  }
}
