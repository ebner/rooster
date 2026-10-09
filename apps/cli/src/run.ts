import { RoosterApiError } from './api.ts';
import { dispatch } from './cli.ts';
import { ConfigLockedError } from './config.ts';
import { CliError, EXIT, type ExitCode } from './errors.ts';
import { extractGlobals } from './globals.ts';
import { describeApiError } from './grant-info.ts';
import { localeFromEnv, resolveLocale, t, withLocale } from './i18n.ts';
import type { Io } from './io.ts';
import { stripAnsi } from './output/color.ts';
import { NO_GLOBALS, Runtime, withRuntime } from './runtime.ts';
import {
  CredentialStoreUnavailable,
  CredentialsChanging,
  KeychainRefused,
  type KeyringFactory,
} from './secrets.ts';

export interface RunOptions {
  /** Tests replace the keychain. */
  loadKeyring?: () => Promise<KeyringFactory | null>;
}

/** citty's own argument errors (unknown command, missing positional) are usage errors. */
function isUsageError(error: unknown): boolean {
  return error instanceof Error && error.name === 'CLIError';
}

/**
 * Runs one invocation and resolves its exit code (07 §4.2); never throws. Expected failures
 * print `rooster: <message>` on stderr; `--verbose` adds the stack of unexpected ones.
 */
export async function runCli(
  argv: readonly string[],
  io: Io,
  options: RunOptions = {},
): Promise<ExitCode> {
  const fallbackLocale = localeFromEnv(io.env) ?? 'en';
  let runtime: Runtime;
  let rest: string[];
  try {
    const extracted = withLocale(fallbackLocale, () => extractGlobals(argv));
    rest = extracted.rest;
    runtime = new Runtime(io, extracted.globals, options);
  } catch (error) {
    const fallback = new Runtime(io, NO_GLOBALS, options);
    return withLocale(fallbackLocale, () => report(fallback, error));
  }
  let locale = fallbackLocale;
  try {
    locale = resolveLocale(
      runtime.profile.locale,
      runtime.state.userLocale(runtime.profileName),
      io.env,
    );
  } catch {
    // A broken config file is reported by the command that reads it.
  }
  return withLocale(locale, () =>
    withRuntime(runtime, async () => {
      try {
        await dispatch(rest);
        return EXIT.ok;
      } catch (error) {
        return report(runtime, error);
      }
    }),
  );
}

async function report(runtime: Runtime, error: unknown): Promise<ExitCode> {
  let failure: CliError;
  if (error instanceof CliError) failure = error;
  else if (error instanceof ConfigLockedError) {
    failure = new CliError(
      EXIT.conflict,
      t('config.locked', { path: error.lockPath, pid: String(error.holderPid ?? '?') }),
    );
  } else if (error instanceof KeychainRefused) {
    failure = new CliError(EXIT.auth, t('auth.keychainRefused', { reason: error.message }));
  } else if (error instanceof CredentialsChanging) {
    failure = new CliError(EXIT.conflict, t('auth.credentialsChanging'));
  } else if (error instanceof CredentialStoreUnavailable) {
    failure = new CliError(EXIT.auth, t('auth.keychainUnavailable'));
  } else if (error instanceof RoosterApiError) {
    failure = await describeApiError(runtime, error).catch(
      () => new CliError(EXIT.unexpected, error.message, error.code),
    );
  } else if (isUsageError(error)) {
    failure = new CliError(
      EXIT.usage,
      `${stripAnsi((error as Error).message)}\n${t('usage.seeHelp')}`,
    );
  } else {
    failure = new CliError(EXIT.unexpected, t('error.unexpected', { message: String(error) }));
    if (runtime.globals.verbose && error instanceof Error && error.stack) {
      runtime.io.stderr.write(`${error.stack}\n`);
    }
  }
  if (runtime.globals.json) {
    runtime.io.stderr.write(
      `${JSON.stringify({ error: { code: failure.code ?? null, exitCode: failure.exitCode, message: failure.message } })}\n`,
    );
  } else {
    runtime.out.error(failure.message);
  }
  return failure.exitCode;
}
