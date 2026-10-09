import { createRoosterClient } from '@rooster/api-client';
import { render } from 'ink';
import type { ReactElement } from 'react';
import { cliFetch } from '../api.ts';
import { editText } from '../editor.ts';
import { currentLocale } from '../i18n.ts';
import type { Runtime } from '../runtime.ts';
import { CLI_VERSION } from '../version.ts';
import { TuiApp } from './app.tsx';
import { TuiController } from './controller.ts';
import { collabTranslator, tuiTranslator } from './i18n.ts';
import { stampRequest } from './idempotency.ts';
import { SseClient } from './sse.ts';

/** `X-Rooster-Client` for the TUI: activity entries say "via the terminal app". */
export const TUI_CLIENT_NAME = `tui/${CLI_VERSION}`;

export interface TuiSession {
  controller: TuiController;
  element: ReactElement;
  sse: SseClient;
  /** Loads the data and opens the live stream. */
  start(): Promise<void>;
  stop(): void;
}

/**
 * Everything one TUI session needs, signed in as the runtime's profile: an API client of its
 * own (same token, origin checks and timeouts as the CLI, but its own `X-Rooster-Client`), the
 * controller, the SSE stream and the Ink element. Tests render `element` themselves.
 */
export async function createSession(runtime: Runtime): Promise<TuiSession> {
  const me = await runtime.me();
  const org = await runtime.org();
  const locale = currentLocale();
  const server = runtime.server();
  const token = () => runtime.token(server);
  const clientId = runtime.clientId;
  const api = createRoosterClient({
    baseUrl: server,
    token,
    clientName: TUI_CLIENT_NAME,
    clientId,
    fetch: (() => {
      const send = cliFetch({ io: runtime.io, verbose: false, server });
      // A change sent again with `r` reuses its Idempotency-Key and edit time.
      return (request: Request) => send(stampRequest(request));
    })(),
  });
  let suspend: ((run: () => Promise<void>) => Promise<void>) | null = null;
  const controller = new TuiController({
    runtime,
    api,
    locale,
    t: tuiTranslator(locale),
    clientId,
    me,
    org,
    now: () => runtime.io.now(),
    editText: async (text) => {
      let result: string | undefined;
      const run = async () => {
        result = await editText(runtime.io, text);
      };
      if (suspend === null) await run();
      else await suspend(run);
      return result;
    },
  });
  const sse = new SseClient({
    url: `${server}/api/v1/events`,
    headers: async () => {
      const value = await token();
      return {
        ...(value === undefined ? {} : { Authorization: `Bearer ${value}` }),
        'X-Rooster-Client': TUI_CLIENT_NAME,
        'X-Rooster-Client-Id': clientId,
      };
    },
    fetch: runtime.io.fetch,
    onMessage: controller.onSseMessage,
    onState: controller.onSseState,
    onDenied: controller.onSseDenied,
  });
  controller.setReconnect(() => sse.reconnect());
  const element = (
    <TuiApp
      controller={controller}
      level={runtime.out.level}
      t={tuiTranslator(locale)}
      collab={collabTranslator(locale)}
      onSuspend={(fn) => {
        suspend = fn;
      }}
    />
  );
  return {
    controller,
    element,
    sse,
    async start() {
      sse.start();
      await controller.start();
    },
    stop() {
      sse.stop();
      controller.close();
    },
  };
}

/** Runs the TUI full screen (the alternate screen, like `vim`) until the user quits. */
export async function startTui(
  runtime: Runtime,
  streams: { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream },
): Promise<void> {
  const session = await createSession(runtime);
  const instance = render(session.element, {
    stdin: streams.stdin,
    stdout: streams.stdout,
    exitOnCtrlC: false,
    alternateScreen: true,
  });
  try {
    await session.start();
    await instance.waitUntilExit();
  } finally {
    session.stop();
    instance.unmount();
  }
}
