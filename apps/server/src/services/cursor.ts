import { AppError } from '../lib/errors.ts';

/** Opaque page cursors (06 §1): base64url JSON the client passes back unchanged. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<T>(
  cursor: string | undefined,
  check: (v: unknown) => v is T,
): T | null {
  if (cursor === undefined) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (check(value)) return value;
  } catch {
    // Reported below.
  }
  throw new AppError('validation_failed', 422, 'Invalid cursor.', [
    { path: 'cursor', message: 'Pass back nextCursor unchanged' },
  ]);
}

/** `[createdAt, id]`: a keyset position in a feed ordered by time, then ID. */
export const isTimeIdCursor = (v: unknown): v is [number, string] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'string';

/** Plain code-unit order, the same as SQLite's BINARY collation (never `localeCompare`). */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
