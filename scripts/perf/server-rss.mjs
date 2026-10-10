#!/usr/bin/env node
// [perf] AC-11.4 (10 §4): idle server memory with 5 users ≤ 150 MB RSS.
//
//   pnpm --filter @rooster/server build
//   node scripts/perf/server-rss.mjs [--idle 30] [--tasks 200] [--port 3191] [--budget 150]
//   node scripts/perf/server-rss.mjs --image rooster:ci     # the built image instead
//
// Boots the built server (apps/server/dist/main.js) on a temp data dir with the mock OIDC
// issuer, signs in 5 users, gives each one tasks (groups, subtasks, tags, comments) in their
// personal org and in a shared org, keeps an event stream open per user (as an open tab
// does), then idles and reports the RSS. Exits 1 above the budget. The server gets the image's
// MALLOC_ARENA_MAX=2.

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startMockIdp } from '../../apps/server/test/mock-idp.ts';
import { HttpSession, waitReady } from './http-session.mjs';

const { values: args } = parseArgs({
  options: {
    idle: { type: 'string', default: '30' },
    tasks: { type: 'string', default: '200' },
    port: { type: 'string', default: '3191' },
    budget: { type: 'string', default: '150' },
    // Node flags for the server, e.g. --node-flags=--max-semi-space-size=2
    'node-flags': { type: 'string', default: '' },
    // Measure a built image instead of apps/server/dist (needs Docker; Linux host networking).
    image: { type: 'string' },
  },
});
const IDLE_S = Number(args.idle);
const TASKS_PER_USER = Number(args.tasks);
const PORT = Number(args.port);
const BUDGET_MB = Number(args.budget);
const IMAGE = args.image;

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const main = join(root, 'apps/server/dist/main.js');
if (IMAGE === undefined && !existsSync(main)) {
  console.error('server-rss: build the server first (pnpm --filter @rooster/server build)');
  process.exit(2);
}

const rssMb = (pid) =>
  Math.round(
    (Number(
      execFileSync('ps', ['-o', 'rss=', '-p', String(pid)])
        .toString()
        .trim(),
    ) /
      1024) *
      10,
  ) / 10;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dataDir = mkdtempSync(join(tmpdir(), 'rooster-rss-'));
const idp = await startMockIdp({ host: '127.0.0.1' });
const base = `http://127.0.0.1:${PORT}`;
const nodeFlags = args['node-flags'].split(' ').filter((f) => f !== '');
const env = {
  NODE_ENV: 'production',
  PORT: String(PORT),
  ROOSTER_BASE_URL: base,
  ROOSTER_AUTH_SECRET: randomBytes(48).toString('base64'),
  ROOSTER_ADMIN_EMAILS: 'user1@example.com',
  ROOSTER_ALLOWED_EMAILS: [2, 3, 4, 5].map((i) => `user${i}@example.com`).join(','),
  ROOSTER_OIDC_PROVIDERS: JSON.stringify([idp.provider()]),
  ROOSTER_BACKUP_CRON: 'off',
  ROOSTER_TRUST_PROXY: 'true',
  ROOSTER_LOG_LEVEL: 'warn',
};
const container = `rooster-rss-${process.pid}`;
let server;
let serverPid;
if (IMAGE === undefined) {
  server = spawn(process.execPath, [...nodeFlags, main], {
    cwd: join(root, 'apps/server'),
    env: {
      ...env,
      PATH: process.env.PATH,
      ROOSTER_DATA_DIR: dataDir,
      // As docker/Dockerfile sets it (glibc arenas otherwise keep memory freed after a burst);
      // MALLOC_* variables in the environment override it.
      MALLOC_ARENA_MAX: '2',
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('MALLOC_'))),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  serverPid = server.pid;
} else {
  // The image as shipped (its own MALLOC_ARENA_MAX); the host network reaches the issuer.
  // /data is the image's anonymous volume, removed with the container.
  server = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      container,
      '--network',
      'host',
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      IMAGE,
      ...(nodeFlags.length > 0 ? [...nodeFlags, '/app/dist/main.js'] : []),
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
}
const streams = [];
let exitCode = 0;

try {
  await waitReady(base);
  if (IMAGE !== undefined) {
    serverPid = Number(
      execFileSync('docker', ['inspect', '-f', '{{.State.Pid}}', container]).toString().trim(),
    );
  }
  const booted = rssMb(serverPid);

  const users = [];
  for (let i = 1; i <= 5; i++) {
    const s = new HttpSession(base, { ip: `198.51.100.${i}` });
    await s.signIn(`user${i}@example.com`);
    users.push(s);
  }
  const [owner, ...members] = users;
  const shared = await owner.ok('POST', '/api/v1/orgs', { name: 'Team' }, 201);
  for (const m of members) {
    const { url } = await owner.ok(
      'POST',
      `/api/v1/orgs/${shared.id}/invites`,
      { role: 'member' },
      201,
    );
    await m.ok('POST', `/api/v1/invites/${url.split('/invite/')[1]}/accept`);
  }
  for (const [u, s] of users.entries()) {
    for (const org of ['personal', shared.id]) {
      const group = await s.ok('POST', `/api/v1/orgs/${org}/groups`, { name: `Project ${u}` }, 201);
      for (let n = 1; n <= TASKS_PER_USER / 2; n++) {
        const task = await s.ok(
          'POST',
          `/api/v1/orgs/${org}/tasks`,
          {
            title: `Task ${n} of user ${u + 1}`,
            groupId: group.group.id,
            ...(n % 3 === 0 ? { tagNames: ['work'] } : {}),
            ...(n % 4 === 0 ? { dueDate: '2026-11-15' } : {}),
          },
          201,
        );
        if (n % 10 === 0) {
          await s.ok(
            'POST',
            `/api/v1/orgs/${org}/tasks`,
            { title: 'A step', parentId: task.id },
            201,
          );
          await s.ok('POST', `/api/v1/tasks/${task.id}/comments`, { body: 'On it.' }, 201);
        }
        if (n % 7 === 0) {
          await s.ok('POST', `/api/v1/tasks/${task.id}/complete`, { completed: true });
        }
      }
      await s.ok('GET', `/api/v1/orgs/${org}/my-list`);
    }
    // An open tab: one event stream per user.
    const controller = new AbortController();
    const res = await fetch(`${base}/api/v1/events`, {
      headers: { ...s.extra, cookie: s.cookieHeader() },
      signal: controller.signal,
    });
    if (res.status !== 200) throw new Error(`events: ${res.status}`);
    res.body?.pipeTo(new WritableStream()).catch(() => {});
    streams.push(controller);
  }
  const seeded = rssMb(serverPid);

  const samples = [];
  for (let t = 0; t < IDLE_S; t += 5) {
    await sleep(5_000);
    samples.push(rssMb(serverPid));
  }
  const idle = samples.at(-1) ?? seeded;
  const report = {
    users: users.length,
    tasksPerUser: TASKS_PER_USER,
    sseStreams: streams.length,
    rssMb: { booted, seeded, idle, idleMax: Math.max(...samples, idle) },
    budgetMb: BUDGET_MB,
    nodeFlags,
    ...(IMAGE === undefined ? {} : { image: IMAGE }),
  };
  console.log(`[perf] AC-11.4 server RSS ${JSON.stringify(report)}`);
  if (idle > BUDGET_MB) {
    console.error(`✗ idle RSS ${idle} MB > ${BUDGET_MB} MB`);
    exitCode = 1;
  } else {
    console.log(`✓ idle RSS ${idle} MB ≤ ${BUDGET_MB} MB`);
  }
} catch (err) {
  console.error('server-rss failed:', err);
  exitCode = 1;
} finally {
  for (const c of streams) c.abort();
  if (IMAGE === undefined) server.kill('SIGTERM');
  else execFileSync('docker', ['stop', '-t', '10', container], { stdio: 'ignore' });
  await new Promise((resolve) =>
    server.exitCode !== null ? resolve() : server.once('exit', resolve),
  );
  await idp.stop();
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(exitCode);
