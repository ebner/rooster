import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { DescriptionField, PlainDescription } from './description-field';

// One description the converter cannot handle, whatever the reason: the editor throws on it.
vi.mock('../editor/markdown', async (original) => {
  const real = await original<typeof import('../editor/markdown')>();
  return {
    ...real,
    fromMarkdown: (markdown: string) => {
      if (markdown.includes('UNPARSEABLE'))
        throw new RangeError('Maximum call stack size exceeded');
      return real.fromMarkdown(markdown);
    },
  };
});

beforeAll(() => {
  // jsdom has no layout; ProseMirror measures ranges when scrolling the caret into view.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

describe('the pane description survives any stored text', () => {
  test('a description nested 5,000 deep opens in the editor', async () => {
    render(<DescriptionField value={`${'> '.repeat(5000)}x`} onChange={vi.fn()} />);
    const editor = await screen.findByRole('textbox', { name: 'Description' });
    expect(editor.getAttribute('contenteditable')).toBe('true');
    expect(editor.textContent).toContain('x');
  });

  test('if the editor still fails, the text is shown and edited as plain text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onChange = vi.fn();
    const value = `${'> '.repeat(5000)}UNPARSEABLE`;
    render(<DescriptionField value={value} onChange={onChange} />);
    const plain = (await screen.findByRole('textbox', {
      name: 'Description',
    })) as HTMLTextAreaElement;
    expect(plain.tagName).toBe('TEXTAREA');
    expect(plain.value).toBe(value);
    expect(screen.getByText(/can’t be shown formatted/)).toBeTruthy();
    fireEvent.change(plain, { target: { value: 'Fixed' } });
    fireEvent.blur(plain);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('Fixed'));
    warn.mockRestore();
    error.mockRestore();
  });

  test('a failure met on blur (a change that waited for it) also falls back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(<DescriptionField value="Fine" onChange={vi.fn()} />);
    const editor = await screen.findByRole('textbox', { name: 'Description' });
    act(() => editor.focus());
    // Another device saves text the converter fails on; it waits for the blur.
    rerender(<DescriptionField value="UNPARSEABLE" onChange={vi.fn()} />);
    expect(screen.queryByTestId('description-plain')).toBeNull();
    act(() => {
      editor.blur();
      fireEvent.blur(editor);
    });
    const plain = (await screen.findByTestId('description-plain')).querySelector('textarea');
    expect(plain?.value).toBe('UNPARSEABLE');
    warn.mockRestore();
    error.mockRestore();
  });
});

describe('the plain-text description', () => {
  test('follows newer text until edited, and saves only an edit', () => {
    const onChange = vi.fn();
    const { rerender } = render(<PlainDescription value="Old" onChange={onChange} />);
    const field = screen.getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;
    rerender(<PlainDescription value="Newer" onChange={onChange} />);
    expect(field.value).toBe('Newer');
    fireEvent.blur(field);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'Mine' } });
    rerender(<PlainDescription value="Newest" onChange={onChange} />);
    expect(field.value).toBe('Mine');
    fireEvent.blur(field);
    expect(onChange).toHaveBeenCalledWith('Mine');
  });
});
