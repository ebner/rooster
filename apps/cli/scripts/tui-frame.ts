/**
 * Renders the TUI against a running rooster and prints one frame, ANSI colours included, for
 * the guide's screenshot (`pnpm docs:screenshots`, shot `tui`). It signs a throwaway CLI home in
 * with a token, opens the TUI at a fixed size through the same harness as its tests, presses
 * the given keys once it has synced (in `--org`, by name), and waits for the given text.
 *
 *   ROOSTER_TUI_SERVER=http://localhost:3181 ROOSTER_TUI_TOKEN=rooster_pat_… \
 *     pnpm --filter @rooster/cli exec tsx scripts/tui-frame.ts \
 *     --columns 112 --rows 34 --wait "My tasks" --keys '["j","j"]'
 *
 * Writes `{"frame": "…"}` on stdout.
 */
import { parseArgs } from 'node:util';
import { stripAnsi } from '../src/output/color.ts';
import { cliHarness } from '../test/support/fake-io.ts';
import { openTui } from '../test/support/tui.ts';

const { values } = parseArgs({
  options: {
    columns: { type: 'string', default: '112' },
    rows: { type: 'string', default: '34' },
    wait: { type: 'string', multiple: true, default: [] },
    keys: { type: 'string', default: '[]' },
    org: { type: 'string' },
  },
});
const server = process.env.ROOSTER_TUI_SERVER;
const token = process.env.ROOSTER_TUI_TOKEN;
if (!server || !token) throw new Error('ROOSTER_TUI_SERVER and ROOSTER_TUI_TOKEN are required');

const cli = cliHarness();
try {
  // Truecolor, as in a modern terminal: the Coop colours exactly.
  cli.env.FORCE_COLOR = '3';
  cli.env.TZ = process.env.TZ;
  const login = await cli.run(['login', '--with-token', '--server', server], { stdin: token });
  if (login.code !== 0) throw new Error(`login failed: ${login.stderr}`);
  const tui = await openTui(cli, { columns: Number(values.columns), rows: Number(values.rows) });
  try {
    const has = (texts: readonly string[]) => (frame: string) =>
      texts.every((text) => stripAnsi(frame).includes(text));
    await tui.waitFor(has(['synced']), 10_000);
    if (values.org) {
      const org = tui.session.controller.getState().me.orgs.find((o) => o.name === values.org);
      if (!org) throw new Error(`no org named ${values.org}`);
      await tui.session.controller.switchOrg(org);
      await tui.waitFor(has([`rooster ─ ${values.org}`]), 10_000);
    }
    for (const key of JSON.parse(values.keys) as string[]) await tui.press(key);
    await tui.waitFor(has(values.wait), 10_000);
    // Let the last keypress render, and the live connection settle.
    await new Promise((resolve) => setTimeout(resolve, 500));
    process.stdout.write(`${JSON.stringify({ frame: tui.frame() })}\n`);
  } finally {
    tui.close();
  }
} finally {
  cli.cleanup();
}
// Ink and the SSE client keep handles open; the frame is out.
process.exit(0);
