declare const __APP_VERSION__: string | undefined;
declare const __APP_GIT_SHA__: string | undefined;

/**
 * The bundle's version and commit (Vite `define`, from `apps/web/package.json` and
 * `ROOSTER_GIT_SHA`). Tests run without the defines and get the dev values.
 */
export const buildInfo = {
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0',
  gitSha: typeof __APP_GIT_SHA__ === 'string' ? __APP_GIT_SHA__ : 'dev',
} as const;

/** 04 §6.1: a new app version discards the persisted query cache (not the outbox). */
export const cacheBuster = buildInfo.version;
