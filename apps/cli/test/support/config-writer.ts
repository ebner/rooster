/**
 * One of several processes updating the same config.toml at once (config lock test):
 * adds `count` new profiles named `<prefix>-<n>`, one locked update each (lock timeout in
 * ms optional).
 */
import { ConfigStore } from '../../src/config.ts';

const [dir, prefix, countText, timeoutText] = process.argv.slice(2);
if (dir === undefined || prefix === undefined || countText === undefined) {
  console.error('usage: config-writer.ts <dir> <prefix> <count>');
  process.exit(2);
}
const store = new ConfigStore(dir, { timeoutMs: Number(timeoutText ?? 20_000) });
for (let n = 0; n < Number(countText); n++) {
  store.updateProfile(`${prefix}-${n}`, (profile) => ({ ...profile, org: String(n) }));
}
