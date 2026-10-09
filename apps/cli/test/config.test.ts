import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigStore,
  cacheDir,
  configDir,
  normalizeServer,
  parseConfig,
  resolveProfileName,
  serializeConfig,
  stateDir,
} from '../src/config.ts';
import { CliError } from '../src/errors.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rooster-config-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mode = (path: string) => statSync(path).mode & 0o777;

describe('paths (07 §2)', () => {
  it('follows XDG on Linux and macOS, APPDATA on Windows', () => {
    expect(configDir({}, 'linux', '/home/a')).toBe('/home/a/.config/rooster');
    expect(configDir({ XDG_CONFIG_HOME: '/x' }, 'darwin', '/Users/a')).toBe('/x/rooster');
    expect(configDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a')).toBe(
      join('C:\\Users\\a\\AppData\\Roaming', 'rooster'),
    );
    expect(stateDir({}, 'linux', '/home/a')).toBe('/home/a/.local/state/rooster');
    expect(cacheDir({ XDG_CACHE_HOME: '/c' }, 'linux', '/home/a')).toBe('/c/rooster');
  });
});

describe('config.toml', () => {
  it('round-trips profiles and drops unknown keys', () => {
    const text = `default_profile = "home"\n[profiles.home]\nserver = "https://r.example"\norg = "personal"\nlocale = "sv"\nbogus = 1\n[profiles.work]\nserver = "https://w.example"\n`;
    const config = parseConfig(text, 'config.toml');
    expect(config).toEqual({
      default_profile: 'home',
      profiles: {
        home: { server: 'https://r.example', org: 'personal', locale: 'sv' },
        work: { server: 'https://w.example' },
      },
    });
    expect(parseConfig(serializeConfig(config), 'x')).toEqual(config);
  });

  it('reports a broken file as a usage error with its path', () => {
    expect(() => parseConfig('[profiles', '/p/config.toml')).toThrow(CliError);
  });

  it('writes atomically with mode 0600 and leaves no temp files', () => {
    const store = new ConfigStore(join(dir, 'rooster'));
    store.updateProfile('home', (p) => ({ ...p, server: 'https://r.example' }));
    expect(mode(store.path)).toBe(0o600);
    expect(readFileSync(store.path, 'utf8')).toContain('server = "https://r.example"');
    store.updateProfile('home', (p) => ({ ...p, org: 'acme' }));
    expect(new ConfigStore(join(dir, 'rooster')).read().profiles.home).toEqual({
      server: 'https://r.example',
      org: 'acme',
    });
    expect(statSync(join(dir, 'rooster')).isDirectory()).toBe(true);
    const leftovers = readdirSync(join(dir, 'rooster'));
    expect(leftovers).toEqual(['config.toml']);
  });

  it('resolves the profile: flag, ROOSTER_PROFILE, default_profile, then "default"', () => {
    const config = { default_profile: 'home', profiles: {} };
    expect(resolveProfileName('cli', { ROOSTER_PROFILE: 'env' }, config)).toBe('cli');
    expect(resolveProfileName(undefined, { ROOSTER_PROFILE: 'env' }, config)).toBe('env');
    expect(resolveProfileName(undefined, {}, config)).toBe('home');
    expect(resolveProfileName(undefined, {}, { profiles: {} })).toBe('default');
  });

  it('normalises server URLs', () => {
    expect(normalizeServer('rooster.example.com')).toBe('https://rooster.example.com');
    expect(normalizeServer('https://r.example/sub/')).toBe('https://r.example/sub');
    expect(normalizeServer('http://localhost:3000')).toBe('http://localhost:3000');
    expect(() => normalizeServer('ftp://x')).toThrow(CliError);
  });
});
