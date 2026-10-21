import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { displayNameOf, signInAs, uniqueEmail } from './support/auth';
import { expect, test } from './support/test';

/**
 * AC-8.1 (07 §2): `rooster login` on a headless machine (no browser) completes the device
 * flow approved from a phone, and `rooster whoami` then prints the user. The CLI runs from
 * source against the e2e server, through the same origin the phone uses.
 */

const cliDir = resolve(import.meta.dirname, '../../cli');

interface Cli {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exit: Promise<number | null>;
}

function rooster(home: string, args: readonly string[], server: string): Cli {
  // `node --import tsx` is `tsx src/main.ts` without the wrapper process.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args], {
    cwd: cliDir,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_STATE_HOME: join(home, 'state'),
      XDG_CACHE_HOME: join(home, 'cache'),
      // A headless machine: no keychain, no colours, no browser to open.
      ROOSTER_KEYRING: 'off',
      NO_COLOR: '1',
      LANG: 'en_US.UTF-8',
      ROOSTER_SERVER: server,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  const exit = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  return { child, stdout: () => out, stderr: () => err, exit };
}

test('AC-8.1 rooster login on a headless machine is approved from a phone; whoami prints the user', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const email = uniqueEmail('cli.phone');
  const name = displayNameOf(email);
  await signInAs(page, email, name);

  const server = baseURL as string;
  const home = mkdtempSync(join(tmpdir(), 'rooster-cli-e2e-'));
  const login = rooster(home, ['login', '--no-browser', '--server', server], server);
  try {
    // The CLI prints the verification URL and the code; the code also stands alone on stdout.
    await expect
      .poll(() => /Code: (\S+)/.exec(login.stdout())?.[1], { timeout: 30_000 })
      .toBeTruthy();
    const code = /Code: (\S+)/.exec(login.stdout())?.[1] as string;
    expect(login.stderr()).toContain(`${server}/device`);

    // On the phone: the consent page with the same code, then Approve.
    // The user types the code (11 §9.2).
    await page.goto('/device');
    await page.getByRole('textbox', { name: 'Code' }).fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Connect a device' })).toBeVisible();
    await expect(page.getByTestId('device-client-name')).toHaveText('rooster CLI');
    await expect(page.getByTestId('device-user-code')).toContainText(
      code.replace(/[^A-Z0-9]/gi, '').slice(0, 4),
    );
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(page.getByRole('heading', { name: /is connected/ })).toBeVisible();

    // The CLI's next poll gets the token (the device flow polls every few seconds).
    expect(await login.exit).toBe(0);
    expect(login.stderr()).toContain(`Signed in as ${name} <${email}>`);

    const whoami = rooster(home, ['whoami'], server);
    expect(await whoami.exit).toBe(0);
    expect(whoami.stdout()).toContain(`${name} <${email}>`);
    expect(whoami.stdout()).toContain('CLI device');
  } finally {
    login.child.kill();
    rmSync(home, { recursive: true, force: true });
  }
});
