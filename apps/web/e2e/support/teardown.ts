import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** Removes this run's server data directory (created in playwright.config.ts). */
// biome-ignore lint/style/noDefaultExport: Playwright loads globalTeardown as a default export.
export default function globalTeardown(): void {
  const dir = process.env.ROOSTER_E2E_DATA_DIR;
  if (!dir?.startsWith(tmpdir())) return;
  rmSync(dir, { recursive: true, force: true });
  // The PWA server's directory (playwright.config.ts).
  rmSync(`${dir}-pwa`, { recursive: true, force: true });
}
