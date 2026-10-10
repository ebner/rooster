import type { AdminSystem } from '@rooster/core/schemas';
import { tagPalette } from '@rooster/tokens';
import type { GuidePage } from './guide-model';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** A small coloured stand-in for a screenshot (the kitchen sink has no build-time images). */
const { gray, amber } = tagPalette;
const screenshot = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 300"><rect width="640" height="300" fill="${gray.bg}"/><rect x="24" y="24" width="140" height="252" rx="8" fill="${amber.bg}"/><rect x="188" y="40" width="380" height="20" rx="4" fill="${gray.fg}"/><rect x="188" y="80" width="300" height="20" rx="4" fill="${gray.fg}"/><rect x="188" y="120" width="340" height="20" rx="4" fill="${amber.fg}"/></svg>`,
)}`;

/** Build-time output of a typical guide page: headings, a list, a table, code, keys, links. */
export const fixtureGuideHtml = `<p>Reminders tell you about a task at the moment you choose, by push, email or in the inbox. Add one while you type with a <code>!</code> token, or from the date picker.</p>
<h2 id="add-a-reminder">Add a reminder</h2>
<ol>
<li>Type the task, for example <code>Call the dentist tomorrow 9:00 !15m</code>.</li>
<li>Press <kbd>Enter</kbd>. The bell on the row shows when the reminder fires.</li>
<li>To change it, open the date picker with <kbd>D</kbd> and press <kbd>⌥R</kbd>.</li>
</ol>
<img src="${screenshot}" alt="The date picker with its reminder section open" width="640" height="300" loading="lazy" decoding="async">
<h2 id="tokens">Tokens</h2>
<div class="guide-table"><table>
<thead>
<tr><th>Token</th><th>Fires</th></tr>
</thead>
<tbody><tr><td><code>!15m</code></td><td>15 minutes before the due time</td></tr>
<tr><td><code>!1h</code></td><td>1 hour before</td></tr>
<tr><td><code>!due</code></td><td>At the due time</td></tr>
</tbody></table></div>
<blockquote>
<p>A task without a time is due at your all-day reminder time, which you set in <a href="/help/settings-and-data" data-guide-link>Settings and your data</a>.</p>
</blockquote>
<h3 id="from-the-terminal">From the terminal</h3>
<pre><code>rooster add "Water the plants" --due tomorrow --remind 1h
</code></pre>
<p>See also <a href="https://github.com/201works/rooster" target="_blank" rel="noopener noreferrer">the project on GitHub</a>.</p>
`;

export const fixtureGuidePages: GuidePage[] = [
  {
    slug: 'getting-started',
    title: 'Getting started',
    lang: 'en',
    html: '<p>Welcome to rooster.</p>',
  },
  { slug: 'my-tasks', title: 'My tasks', lang: 'en', html: '<p>Your list.</p>' },
  { slug: 'reminders', title: 'Reminders', lang: 'en', html: fixtureGuideHtml },
  { slug: 'keyboard', title: 'Keyboard shortcuts', lang: 'en', html: '<p>Keys.</p>' },
  {
    slug: 'settings-and-data',
    title: 'Settings and your data',
    lang: 'en',
    html: '<p>Settings.</p>',
  },
];

/** A healthy instance as `GET /admin/system` reports it. */
export function fixtureSystem(now: number): AdminSystem {
  return {
    version: '1.5.0',
    gitSha: '7e6a2dd4c1f09b2a',
    startedAt: now - 3 * day - 4 * hour,
    database: { sizeBytes: 48_300_000, walSizeBytes: 4_100_000 },
    lastBackup: {
      name: 'auto-2026-10-10T02-00-00Z.sqlite',
      createdAt: now - 9 * hour,
      sizeBytes: 47_900_000,
    },
    jobs: [
      { job: 'backup', lastRunAt: now - 9 * hour, lastStatus: 'ok', lastError: null },
      { job: 'purge', lastRunAt: now - 8 * hour, lastStatus: 'ok', lastError: null },
      { job: 'due-reminders', lastRunAt: now - 40_000, lastStatus: 'ok', lastError: null },
      {
        job: 'email-batch',
        lastRunAt: now - 3 * minute,
        lastStatus: 'failed',
        lastError: 'connect ECONNREFUSED 10.0.0.25:587',
      },
      { job: 'blob-gc', lastRunAt: null, lastStatus: null, lastError: null },
    ],
    smtp: { configured: true },
    push: { keySource: 'generated', subscriptions: 7 },
    sse: { connections: 4 },
    storage: {
      backend: 'local',
      attachmentBytes: 1_340_000_000,
      attachmentCount: 2_816,
      userQuotaBytes: 1024 * 1024 * 1024,
    },
    counts: { users: 12, orgs: 5, tasks: 4_208 },
  };
}

/** A fresh instance: no backup, no SMTP, no push, S3 storage without a quota. */
export function fixtureSystemBare(now: number): AdminSystem {
  return {
    ...fixtureSystem(now),
    gitSha: null,
    startedAt: now - 20_000,
    lastBackup: null,
    jobs: [],
    smtp: { configured: false },
    push: { keySource: 'none', subscriptions: 0 },
    sse: { connections: 1 },
    storage: { backend: 's3', attachmentBytes: 0, attachmentCount: 0, userQuotaBytes: null },
    counts: { users: 1, orgs: 1, tasks: 1 },
  };
}
