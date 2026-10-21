/**
 * One of several processes taking the same profile lock (profile lock test): `count` times,
 * reads a counter file, waits a little, and writes it back incremented, all under the lock.
 * A lost update means two holders at once.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withProfileLock } from '../../src/profile-lock.ts';

const [dir, countText] = process.argv.slice(2);
if (dir === undefined || countText === undefined) {
  console.error('usage: lock-holder.ts <dir> <count>');
  process.exit(2);
}
const counter = join(dir, 'counter');
for (let n = 0; n < Number(countText); n++) {
  await withProfileLock(
    dir,
    'agent',
    async () => {
      const value = Number(readFileSync(counter, 'utf8'));
      await new Promise((r) => setTimeout(r, 2));
      writeFileSync(counter, String(value + 1));
    },
    { timeoutMs: 30_000 },
  );
}
