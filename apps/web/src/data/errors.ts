/**
 * A failed API call, carrying the problem+json `code` (04 §4.10) so screens can
 * show a specific message ("last_owner", "personal_org", …) instead of a generic one.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, detail?: string) {
    super(detail ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}
