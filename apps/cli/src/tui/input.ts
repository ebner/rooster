import { clean } from '../output/color.ts';
import type { KeyInfo } from './keymap.ts';

/** A one-line text field: the title editor, drafts, the pickers' filters and search. */
export interface LineInput {
  value: string;
  /** Caret position in code points. */
  cursor: number;
}

export const lineInput = (value = ''): LineInput => ({ value, cursor: [...value].length });

export type InputResult =
  | { kind: 'change'; input: LineInput }
  | { kind: 'submit' }
  | { kind: 'cancel' }
  | { kind: 'ignored' };

/**
 * Applies one keypress (or a paste) to the field. Enter submits and Esc cancels; the caller
 * decides what they mean. Pasted text loses control characters and line breaks, since a title
 * is one line.
 */
export function editLine(input: LineInput, text: string, key: KeyInfo): InputResult {
  const chars = [...input.value];
  const at = Math.min(input.cursor, chars.length);
  const change = (value: string[], cursor: number): InputResult => ({
    kind: 'change',
    input: { value: value.join(''), cursor: Math.max(0, Math.min(cursor, value.length)) },
  });
  if (key.return) return { kind: 'submit' };
  if (key.escape) return { kind: 'cancel' };
  if (key.leftArrow) return change(chars, at - 1);
  if (key.rightArrow) return change(chars, at + 1);
  if (key.home || (key.ctrl && text === 'a')) return change(chars, 0);
  if (key.end || (key.ctrl && text === 'e')) return change(chars, chars.length);
  if (key.ctrl && text === 'u') return change(chars.slice(at), 0);
  if (key.ctrl && text === 'k') return change(chars.slice(0, at), at);
  if (key.ctrl && text === 'w') {
    let start = at;
    while (start > 0 && chars[start - 1] === ' ') start--;
    while (start > 0 && chars[start - 1] !== ' ') start--;
    return change([...chars.slice(0, start), ...chars.slice(at)], start);
  }
  if (key.backspace) {
    if (at === 0) return { kind: 'ignored' };
    return change([...chars.slice(0, at - 1), ...chars.slice(at)], at - 1);
  }
  if (key.delete) {
    if (at >= chars.length) return { kind: 'ignored' };
    return change([...chars.slice(0, at), ...chars.slice(at + 1)], at);
  }
  if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return { kind: 'ignored' };
  if (key.pageDown || key.pageUp) return { kind: 'ignored' };
  const typed = [...clean(text.replace(/[\r\n\t]+/g, ' '))];
  if (typed.length === 0) return { kind: 'ignored' };
  return change([...chars.slice(0, at), ...typed, ...chars.slice(at)], at + typed.length);
}
