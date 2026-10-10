// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import enHelp from '../../../../../packages/i18n/locales/en/help.json';
import enList from '../../../../../packages/i18n/locales/en/list.json';
import svHelp from '../../../../../packages/i18n/locales/sv/help.json';
import svList from '../../../../../packages/i18n/locales/sv/list.json';
import { isKeyed, keymap, shortcutIds, shortcutSections } from '../../keymap';
import { escapeCell, keyboardDocBanner, keysMarkdown, renderKeyboardDoc } from './keyboard-doc';

const en = renderKeyboardDoc({ title: 'Keyboard shortcuts', list: enList, help: enHelp });

describe('the generated keyboard page (ADR 0052 §2, hard rule 8)', () => {
  test('one table per cheat-sheet section, in the same order', () => {
    const headings = [...en.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    const expected = shortcutSections
      .filter((s) => shortcutIds.some((id) => isKeyed(id) && keymap[id].section === s))
      .map((s) => enList.keys.section[s]);
    expect(headings).toEqual(expected);
    expect(en.startsWith(`# Keyboard shortcuts\n\n${keyboardDocBanner}\n`)).toBe(true);
    expect(en.match(/^\| Action \| Mac \| Windows and Linux \|$/gm)).toHaveLength(headings.length);
  });

  test('every keyed shortcut has a row; palette-only commands have none', () => {
    const rows = en
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| ---'));
    const keyed = shortcutIds.filter(isKeyed);
    expect(rows.length - (en.match(/^\| Action/gm)?.length ?? 0)).toBe(keyed.length);
    expect(en).toContain('| Search | <kbd>⌘K</kbd> | <kbd>Ctrl+K</kbd> |');
    expect(en).toContain(
      '| Open the guide | <kbd>G</kbd> <kbd>H</kbd> | <kbd>G</kbd> <kbd>H</kbd> |',
    );
    expect(en).not.toContain('Make subtask of');
  });

  test('Mac and Windows/Linux key names; symbols stay literal in Markdown', () => {
    expect(keysMarkdown(keymap.redo, 'mac')).toBe('<kbd>⌘⇧Z</kbd> / <kbd>⌃Y</kbd>');
    expect(keysMarkdown(keymap.redo, 'other')).toBe('<kbd>Ctrl+Shift+Z</kbd> / <kbd>Ctrl+Y</kbd>');
    expect(keysMarkdown(keymap.toggleSidebar, 'other')).toBe('<kbd>Ctrl+&#92;</kbd>');
    expect(keysMarkdown(keymap.goToOrg, 'mac')).toBe('<kbd>⌘1…9</kbd>');
    expect(escapeCell('a|b_c*d')).toBe('a&#124;b&#95;c&#42;d');
  });

  test('the Swedish page uses the Swedish catalogs', () => {
    const sv = renderKeyboardDoc({ title: 'Kortkommandon', list: svList, help: svHelp });
    expect(sv).toContain('| Åtgärd | Mac | Windows och Linux |');
    expect(sv).toContain(`## ${svList.keys.section.general}`);
  });

  test('AC-11.6 the committed pages match the keymap (pnpm docs:keyboard)', () => {
    const committed = (locale: string) =>
      readFileSync(
        new URL(`../../../../../docs/guide/${locale}/keyboard.md`, import.meta.url),
        'utf8',
      );
    expect(committed('en')).toBe(en);
    expect(committed('sv')).toBe(
      renderKeyboardDoc({ title: 'Kortkommandon', list: svList, help: svHelp }),
    );
  });
});
