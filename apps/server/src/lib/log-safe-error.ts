/**
 * An error as it may be logged. Database errors carry the bound parameters of the failed
 * query (Drizzle's "Failed query: … params: …" message and `params` field), and those are user
 * content: task titles, descriptions, emails. Logs keep the SQL text, the error's name, code
 * and stack, but never parameter values.
 */
export interface LoggableError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  cause?: LoggableError;
}

const PARAMS_LINE = /\n?params:[\s\S]*$/;
const MAX_CAUSE_DEPTH = 3;

function scrub(text: string): string {
  return text.replace(PARAMS_LINE, '\nparams: [redacted]');
}

export function logSafeError(err: unknown, depth = 0): LoggableError {
  if (!(err instanceof Error)) return { name: typeof err, message: '[non-error thrown]' };
  const out: LoggableError = { name: err.name, message: scrub(err.message) };
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') out.code = code;
  if (err.stack) {
    // The stack's first line repeats the message.
    const [, ...frames] = err.stack.split('\n');
    out.stack = [
      `${out.name}: ${out.message.split('\n')[0]}`,
      ...frames.filter((l) => /^\s+at /.test(l)),
    ].join('\n');
  }
  if (err.cause !== undefined && depth < MAX_CAUSE_DEPTH)
    out.cause = logSafeError(err.cause, depth + 1);
  return out;
}
