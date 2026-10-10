import { keyedShortcutsBySection, keymap, type ShortcutDefinition } from '../../keymap.ts';
import { shortcutLabel } from '../../ui/kbd-labels.ts';

/*
 * The guide's keyboard page (ADR 0052 §2, hard rule 8), generated from the keymap registry and
 * the catalogs: `pnpm docs:keyboard` writes docs/guide/{en,sv}/keyboard.md, and `--check` fails CI
 * when a file no longer matches. It runs under plain Node (type stripping), so its own imports
 * carry the `.ts` extension and pull in nothing that needs a bundler.
 */

/** A locale's JSON catalog namespace, as in packages/i18n/locales/<locale>/<ns>.json. */
export interface Catalog {
  [key: string]: string | Catalog;
}

export interface KeyboardDocInput {
  /** The page title (docs/guide/pages.json). */
  title: string;
  /** The `list` namespace: `keys.<id>` and `keys.section.<section>` (as the cheat sheet). */
  list: Catalog;
  /** The `help` namespace: the page's own sentences. */
  help: Catalog;
}

export const keyboardDocBanner =
  '<!-- Generated from apps/web/src/keymap.ts by `pnpm docs:keyboard`. Do not edit. -->';

function message(catalog: Catalog, path: string): string {
  let node: string | Catalog | undefined = catalog;
  for (const part of path.split('.')) {
    node = typeof node === 'object' ? node[part] : undefined;
  }
  if (typeof node !== 'string') throw new Error(`keyboard doc: missing message ${path}`);
  // The messages used here take no arguments; ICU only escapes quotes as ''.
  return node.replace(/''/g, "'");
}

const entities: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '\\': '&#92;',
  '|': '&#124;',
  '*': '&#42;',
  _: '&#95;',
  '`': '&#96;',
  '[': '&#91;',
  ']': '&#93;',
};

/** Text that stays literal in a Markdown table cell and inside `<kbd>`. */
export function escapeCell(text: string): string {
  return text.replace(/[&<>\\|*_`[\]]/g, (c) => entities[c] ?? c);
}

/** One binding as `<kbd>` keys for a platform: `⌘K`, `Ctrl+K`, `G` `M` for a sequence. */
export function keysMarkdown(definition: ShortcutDefinition, platform: 'mac' | 'other'): string {
  const alternatives = definition.display ? [definition.display] : definition.keys;
  return alternatives
    .map((keys) =>
      keys
        .split(' ')
        .map((part) => `<kbd>${escapeCell(shortcutLabel(part, platform))}</kbd>`)
        .join(' '),
    )
    .join(' / ');
}

/** The whole Markdown page for one locale. */
export function renderKeyboardDoc({ title, list, help }: KeyboardDocInput): string {
  const lines: string[] = [
    `# ${title}`,
    '',
    keyboardDocBanner,
    '',
    message(help, 'keyboardDoc.intro'),
    '',
    `- ${message(help, 'keyboardDoc.notation.mod')}`,
    `- ${message(help, 'keyboardDoc.notation.tab')}`,
    `- ${message(help, 'keyboardDoc.notation.sequence')}`,
    '',
  ];
  const head = [
    message(help, 'keyboardDoc.column.action'),
    message(help, 'keyboardDoc.column.mac'),
    message(help, 'keyboardDoc.column.other'),
  ];
  for (const { section, ids } of keyedShortcutsBySection()) {
    if (ids.length === 0) continue;
    lines.push(`## ${message(list, `keys.section.${section}`)}`, '');
    lines.push(`| ${head.map(escapeCell).join(' | ')} |`, '| --- | --- | --- |');
    for (const id of ids) {
      const definition: ShortcutDefinition = keymap[id];
      lines.push(
        `| ${escapeCell(message(list, `keys.${id}`))} | ${keysMarkdown(definition, 'mac')} | ${keysMarkdown(definition, 'other')} |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
