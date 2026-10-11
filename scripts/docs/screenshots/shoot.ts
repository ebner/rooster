import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { signInAs } from '../../../apps/web/e2e/support/auth';
import { test as base, expect } from '../../../apps/web/e2e/support/test';
import { writeShotMeta } from '../png-meta.mjs';
import { type DemoState, loadState } from './demo-api';
import { DEMO } from './demo-env';

/**
 * Shared by the desktop and phone shot specs: Maja's signed-in page with an English UI and the
 * one-time hints dismissed, and `shot()`, which waits for a settled screen, hides what would
 * differ between runs or machines, and writes `<name>.<form>.<theme>.png` for the optimiser.
 */

export { expect };

export const test = base.extend<{ demo: DemoState }>({
  // A fixed documentation address (RFC 5737) instead of the e2e suite's random one, so the
  // session list in Settings → Security looks the same on every run.
  extraHTTPHeaders: async ({ isMobile }, use) => {
    await use({ 'X-Forwarded-For': isMobile ? '198.51.100.21' : '198.51.100.20' });
  },
  demo: async ({ page }, use, testInfo) => {
    const theme = testInfo.project.metadata.theme as string;
    await page.addInitScript((dark: boolean) => {
      localStorage.setItem('rooster.locale', 'en');
      localStorage.setItem('rooster.list.shortcutHintDismissed', '1');
      localStorage.setItem('rooster.installToastShown', '1');
      localStorage.setItem('rooster.visits', '1');
      // A future dark theme hangs off this attribute (03 §1); harmless until then.
      if (dark) document.documentElement.dataset.theme = 'dark';
    }, theme === 'dark');
    const state = loadState();
    await signInAs(page, DEMO.adminEmail, 'Maja Lind', { landing: /\/o\/[^/]+\/my$/ });
    // Let the post-sign-in redirects finish, so the first goto of a spec isn't interrupted.
    await page.getByTestId('task-row').first().waitFor();
    await page.waitForLoadState('load');
    if (theme === 'dark') {
      // Until the app has a dark theme (D-22) a dark run would only duplicate the light images.
      const dark = await page.evaluate(() => {
        const rgb = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.map(Number);
        if (!rgb || rgb.length < 3) return false;
        const [r = 255, g = 255, b = 255] = rgb;
        return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
      });
      testInfo.skip(!dark, 'The app has no dark theme yet; dark screenshots are skipped.');
    }
    await use(state);
  },
});

const rawDir = () => {
  const dir = resolve(process.env.ROOSTER_DOCS_DATA_DIR ?? '', 'raw');
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Requested names (`DOCS_SHOTS=my-tasks,inbox`) limit a run to those shots. */
const only = (process.env.DOCS_SHOTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
export const wanted = (name: string) => only.length === 0 || only.includes(name);

const settleCss = `
  [role="status"][aria-label="Sync status"] { visibility: hidden !important; }
  *, *::before, *::after { transition: none !important; animation: none !important; }
`;

export interface ShotOptions {
  /** Keep toasts (hidden by default). */
  toasts?: boolean;
  /** Capture just this element's box (plus `padding`). */
  clip?: { x: number; y: number; width: number; height: number };
  fullPage?: boolean;
}

export async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const images = [...document.images].filter((img) => !img.complete);
    await Promise.all(
      images.map(
        (img) =>
          new Promise((done) => {
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
          }),
      ),
    );
  });
  const pending = page.getByTestId('sync-state');
  if ((await pending.count()) > 0) {
    await expect(pending.first()).toHaveAttribute('data-pending', '0');
  }
  await page.waitForTimeout(400);
}

/**
 * Replaces what differs per run or machine wherever it is visible: the local origin becomes a
 * neutral public one, and random codes (a device code, a token prefix) become fixed samples.
 */
export async function hideOrigin(page: Page) {
  await page.evaluate(
    ({ from, to }) => {
      const swaps: [RegExp, string][] = [
        [new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), to],
        [/rooster_pat_[A-Za-z0-9_-]+/g, 'rooster_pat_kL7q'],
        // RFC 8628's example user code.
        [/^[A-Z0-9]{4}-[A-Z0-9]{4}$/g, 'WDJB-MJHT'],
      ];
      const swap = (text: string) => swaps.reduce((out, [re, by]) => out.replace(re, by), text);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const next = swap(node.nodeValue ?? '');
        if (next !== node.nodeValue) node.nodeValue = next;
      }
      for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input, textarea',
      )) {
        const next = swap(input.value);
        if (next !== input.value) input.value = next;
      }
    },
    { from: DEMO.baseURL, to: DEMO.publicURL },
  );
}

export async function shot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: ShotOptions = {},
) {
  const { theme, form } = testInfo.project.metadata as { theme: string; form: string };
  await settle(page);
  await hideOrigin(page);
  const style = await page.addStyleTag({
    content: options.toasts
      ? settleCss
      : `${settleCss} [data-toast-region] { display: none !important; }`,
  });
  const path = resolve(rawDir(), `${name}.${form}.${theme}.png`);
  await page.screenshot({
    path,
    animations: 'disabled',
    caret: 'hide',
    ...(options.clip ? { clip: options.clip } : {}),
    ...(options.fullPage ? { fullPage: true } : {}),
  });
  await style.evaluate((el) => el.remove());
  // The guide shows each picture at its real size, and a crop at the scale of a whole screen.
  const scale = testInfo.project.use.deviceScaleFactor ?? 1;
  const viewport = page.viewportSize()?.width ?? 0;
  writeFileSync(path, writeShotMeta(readFileSync(path), { scale, viewport }));
  console.log(`  ✓ ${name}.${form}.${theme}`);
}

/**
 * Runs one capture as a step and keeps going when it fails, so one broken screen doesn't cost
 * the rest; the test still fails at the end with every failure listed.
 */
export function capturing(testInfo: TestInfo) {
  const failures: string[] = [];
  return {
    async take(name: string, body: () => Promise<void>) {
      if (!wanted(name)) return;
      try {
        await test.step(name, body);
      } catch (error) {
        failures.push(`${name}: ${(error as Error).message.split('\n')[0]}`);
        await testInfo.attach(`${name}-failure`, { body: String(error) });
      }
    },
    done() {
      expect(failures, 'screens that failed').toEqual([]);
    },
  };
}
