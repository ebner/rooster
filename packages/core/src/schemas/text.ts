import { z } from 'zod';

/**
 * Removes C0 control characters and DEL. Names and titles are single-line, so tabs and
 * newlines go too (04 §4.11).
 */
export function stripControlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code > 0x1f && code !== 0x7f) out += ch;
  }
  return out;
}

/** A user-entered single-line name: control characters stripped, trimmed, 1–`max` characters. */
export function nameSchema(max: number) {
  return z.string().overwrite(stripControlChars).trim().min(1).max(max);
}
