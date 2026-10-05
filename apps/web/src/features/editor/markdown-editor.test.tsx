import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { nextHeadingLevel, normalizeHref } from './format-toolbar';
import { escapeMarkdownText, fromMarkdown, toMarkdown } from './markdown';
import { changeDebounceMs, MarkdownEditor, type MarkdownEditorProps } from './markdown-editor';

function setup(props: Partial<MarkdownEditorProps> = {}) {
  const onChange = vi.fn<(markdown: string) => void>();
  const result = render(
    <MarkdownEditor value="" onChange={onChange} ariaLabel="Description" {...props} />,
  );
  const dom = screen.getByRole('textbox', { name: 'Description' });
  const editor = (dom as HTMLElement & { editor: Editor }).editor;
  return { ...result, dom, editor, onChange };
}

/** Types like a user: each character goes through the input rules first. */
function typeText(editor: Editor, text: string) {
  act(() => {
    for (const ch of text) {
      const { view } = editor;
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (f) =>
        f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
    }
  });
}

beforeAll(() => {
  // jsdom has no layout; ProseMirror measures ranges when scrolling the caret into view.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The document position where `text` starts. */
function textPos(editor: Editor, text: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found === -1 && node.isText && node.text?.includes(text)) {
      found = pos + node.text.indexOf(text);
    }
  });
  if (found === -1) throw new Error(`text not found: ${text}`);
  return found;
}

describe('MarkdownEditor', () => {
  test('shows the placeholder on an empty description', () => {
    const { dom } = setup();
    expect(dom.getAttribute('aria-placeholder')).toBe('Add more detail…');
    expect(dom.querySelector('p')?.getAttribute('data-placeholder')).toBe('Add more detail…');
  });

  test.each([
    ['# ', 'Title', '# Title'],
    ['## ', 'Sub', '## Sub'],
    ['- ', 'Milk', '- Milk'],
    ['1. ', 'First', '1. First'],
    ['[] ', 'Call Anna', '- [ ] Call Anna'],
    ['[x] ', 'Done', '- [x] Done'],
    ['> ', 'Quote', '> Quote'],
  ])('the shortcut "%s" formats the block', (shortcut, text, markdown) => {
    const { editor } = setup();
    act(() => editor.commands.focus());
    typeText(editor, shortcut + text);
    expect(toMarkdown(editor.getJSON())).toBe(markdown);
  });

  test('"**bold**" and "`code`" become marks as you type', () => {
    const { editor } = setup();
    act(() => editor.commands.focus());
    typeText(editor, 'a **b** `c` ');
    expect(toMarkdown(editor.getJSON())).toBe('a **b** `c`');
  });

  test('Mod+B makes the selection bold', () => {
    const { dom, editor } = setup({ value: 'make me bold' });
    act(() => {
      editor.commands.focus();
      editor.commands.setTextSelection({ from: 9, to: 13 });
    });
    fireEvent.keyDown(dom, { key: 'b', code: 'KeyB', ctrlKey: true });
    expect(toMarkdown(editor.getJSON())).toBe('make me **bold**');
  });

  test('Tab indents a list item and stays in the editor; Shift+Tab outdents', () => {
    const { dom, editor } = setup({ value: '- one\n- two' });
    const caretIn = (text: string) =>
      act(() => {
        editor.commands.focus();
        editor.commands.setTextSelection(textPos(editor, text) + text.length);
      });
    caretIn('two');
    expect(fireEvent.keyDown(dom, { key: 'Tab', code: 'Tab' })).toBe(false); // focus stays
    expect(toMarkdown(editor.getJSON())).toBe('- one\n  - two');
    // The first item cannot indent, but Tab still does not leave the list.
    caretIn('one');
    expect(fireEvent.keyDown(dom, { key: 'Tab', code: 'Tab' })).toBe(false);
    expect(toMarkdown(editor.getJSON())).toBe('- one\n  - two');
    caretIn('two');
    fireEvent.keyDown(dom, { key: 'Tab', code: 'Tab', shiftKey: true });
    expect(toMarkdown(editor.getJSON())).toBe('- one\n- two');
  });

  test('Tab outside a list is left to the browser (focus moves on)', () => {
    const { dom, editor } = setup({ value: 'plain text' });
    act(() => {
      editor.commands.focus('end');
    });
    expect(fireEvent.keyDown(dom, { key: 'Tab', code: 'Tab' })).toBe(true);
  });

  test('Esc and Mod+Enter call their handlers after reporting a pending edit', () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const { dom, editor, onChange } = setup({
      onEscape: () => calls.push('escape'),
      onModEnter: () => calls.push('modEnter'),
    });
    onChange.mockImplementation(() => calls.push('change'));
    act(() => editor.commands.focus());
    typeText(editor, 'x');
    fireEvent.keyDown(dom, { key: 'Escape', code: 'Escape' });
    fireEvent.keyDown(dom, { key: 'Enter', code: 'Enter', ctrlKey: true });
    expect(calls).toEqual(['change', 'escape', 'modEnter']);
    expect(onChange).toHaveBeenCalledExactlyOnceWith('x');
  });

  test('onChange fires once after 600 ms of idle time', () => {
    vi.useFakeTimers();
    const { editor, onChange } = setup({ value: 'Hello' });
    act(() => editor.commands.focus('end'));
    typeText(editor, ' wor');
    act(() => vi.advanceTimersByTime(changeDebounceMs - 100));
    typeText(editor, 'ld');
    act(() => vi.advanceTimersByTime(changeDebounceMs - 1));
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('Hello world');
  });

  test('blur reports a pending edit at once, and only real changes are reported', () => {
    vi.useFakeTimers();
    const { dom, editor, onChange } = setup({ value: 'Hello' });
    act(() => editor.commands.focus('end'));
    typeText(editor, '!');
    act(() => {
      fireEvent.blur(dom);
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('Hello!');
    act(() => vi.advanceTimersByTime(changeDebounceMs * 2));
    expect(onChange).toHaveBeenCalledTimes(1);
    // Typing and deleting again returns to the reported text: nothing to report.
    typeText(editor, '?');
    act(() => editor.commands.deleteRange({ from: 7, to: 8 }));
    act(() => vi.advanceTimersByTime(changeDebounceMs));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('a pending edit is reported on unmount', () => {
    const { editor, onChange, unmount } = setup({ value: 'a' });
    act(() => editor.commands.focus('end'));
    typeText(editor, 'b');
    unmount();
    expect(onChange).toHaveBeenCalledExactlyOnceWith('ab');
  });

  test('a new value from outside replaces the content when not focused', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <MarkdownEditor value="one" onChange={onChange} ariaLabel="Description" />,
    );
    rerender(<MarkdownEditor value="**two**" onChange={onChange} ariaLabel="Description" />);
    const dom = screen.getByRole('textbox', { name: 'Description' });
    expect(dom.querySelector('strong')?.textContent).toBe('two');
    expect(onChange).not.toHaveBeenCalled();
  });

  test('long text collapses with "Show more"; focusing or the toggle expands it', () => {
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('rooster-prose') ? 13 * 24 : 0;
      });
    try {
      const { editor } = setup({
        value: Array.from({ length: 13 }, (_, i) => `Line ${i}`).join('\n\n'),
      });
      const more = screen.getByRole('button', { name: 'Show more' });
      expect(more.getAttribute('aria-expanded')).toBe('false');
      const region = document.getElementById(more.getAttribute('aria-controls') ?? '');
      expect(region?.className).toContain('rooster-prose-clip');
      fireEvent.click(more);
      expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
        'true',
      );
      expect(region?.className).not.toContain('rooster-prose-clip');
      fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
      expect(region?.className).toContain('rooster-prose-clip');
      // Editing expands.
      act(() => {
        fireEvent.focus(editor.view.dom);
      });
      expect(region?.className).not.toContain('rooster-prose-clip');
    } finally {
      scrollHeight.mockRestore();
    }
  });

  test('short text has no toggle', () => {
    setup({ value: 'Short' });
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  test('read-only renders links that open safely in a new tab', () => {
    const { dom, editor } = setup({ value: 'See [docs](https://example.com)', readOnly: true });
    expect(editor.isEditable).toBe(false);
    expect(dom.getAttribute('aria-readonly')).toBe('true');
    const link = dom.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  test('javascript: links are not rendered as links', () => {
    const { dom } = setup({ value: '[x](javascript:alert(1))' });
    expect(dom.querySelector('a[href^="javascript"]')).toBeNull();
  });

  test('the static toolbar applies formatting and reflects the selection', () => {
    const { editor } = setup({ value: 'some text', forceToolbar: 'buttons' });
    act(() => {
      editor.commands.focus();
      editor.commands.setTextSelection({ from: 1, to: 5 });
    });
    const italic = screen.getByRole('button', { name: 'Italic' });
    expect(italic.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(italic);
    expect(toMarkdown(editor.getJSON())).toBe('*some* text');
    expect(screen.getByRole('button', { name: 'Italic' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Heading' }));
    expect(toMarkdown(editor.getJSON())).toBe('# *some* text');
    fireEvent.click(screen.getByRole('button', { name: 'Heading 1' }));
    expect(toMarkdown(editor.getJSON())).toBe('## *some* text');
    fireEvent.click(screen.getByRole('button', { name: 'Checklist' }));
    expect(toMarkdown(editor.getJSON())).toBe('- [ ] *some* text');
  });

  test('the link field adds https:// to a typed domain', () => {
    const { editor } = setup({ value: 'docs here', forceToolbar: 'buttons' });
    act(() => {
      editor.commands.focus();
      editor.commands.setTextSelection({ from: 1, to: 5 });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    const field = screen.getByRole('textbox', { name: 'Link address' });
    fireEvent.change(field, { target: { value: 'example.com/a_b' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(toMarkdown(editor.getJSON())).toBe('[docs](https://example.com/a_b) here');
  });
});

describe('Markdown helpers', () => {
  test('escaping is minimal but safe', () => {
    const plain = { atLineStart: true, before: undefined, after: undefined };
    expect(escapeMarkdownText('snake_case 2 * 3 [ref] Tom & Jerry', plain)).toBe(
      'snake_case 2 * 3 [ref] Tom & Jerry',
    );
    expect(escapeMarkdownText('# a *b* _c_ `d` [e](f) &amp; <https://x>', plain)).toBe(
      '\\# a \\*b\\* \\_c\\_ \\`d\\` \\[e](f) \\&amp; \\<https://x>',
    );
    expect(escapeMarkdownText('1. x\n- y\n===', plain)).toBe('1\\. x\n\\- y\n\\===');
  });

  test('every escaped string parses back to the same text', () => {
    for (const text of [
      '*a*',
      '_a_',
      '`a`',
      '[a](b)',
      '# a',
      '- a',
      '1) a',
      '> a',
      'a\\*',
      '~~a~~',
    ]) {
      const md = escapeMarkdownText(text, {
        atLineStart: true,
        before: undefined,
        after: undefined,
      });
      const doc = fromMarkdown(md);
      expect(doc.content?.[0]?.content?.[0]?.text).toBe(text);
    }
  });

  test('normalizeHref', () => {
    expect(normalizeHref('example.com')).toBe('https://example.com');
    expect(normalizeHref('anna@example.com')).toBe('mailto:anna@example.com');
    expect(normalizeHref('http://x.test')).toBe('http://x.test');
    expect(normalizeHref('javascript:alert(1)')).toBeNull();
    expect(normalizeHref('two words')).toBeNull();
  });

  test('the H button cycles paragraph → H1 → H2 → H3 → paragraph', () => {
    expect([0, 1, 2, 3].map((l) => nextHeadingLevel(l as 0 | 1 | 2 | 3))).toEqual([1, 2, 3, 0]);
  });
});
