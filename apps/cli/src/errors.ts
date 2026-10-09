/** Exit codes (07 §4.2). */
export const EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  conflict: 5,
  network: 6,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An expected failure: printed as `rooster: <message>` and mapped to its exit code. */
export class CliError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    /** The problem+json `code` when the failure came from the API. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

const AUTH_CODES = new Set([
  'unauthenticated',
  'forbidden',
  'forbidden_scope',
  'outside_grant',
  'session_required',
  'invalid_token',
  'token_expired',
]);
const NOT_FOUND_CODES = new Set(['not_found', 'ambiguous_ref', 'task_deleted', 'gone']);

/** The exit code for an API problem (status plus stable `code`). */
export function exitCodeForProblem(status: number, code: string | undefined): ExitCode {
  if (code !== undefined && AUTH_CODES.has(code)) return EXIT.auth;
  if (code !== undefined && NOT_FOUND_CODES.has(code)) return EXIT.notFound;
  if (code === 'rate_limited') return EXIT.network;
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 404 || status === 410) return EXIT.notFound;
  if (status === 400 || status === 409 || status === 412 || status === 413 || status === 422) {
    return EXIT.conflict;
  }
  if (status === 429 || status >= 500) return EXIT.network;
  return EXIT.unexpected;
}
