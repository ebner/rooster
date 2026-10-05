import { Editor } from '@tiptap/react';
import { describe, expect, test } from 'vitest';
import { editorExtensions } from './extensions';
import { fromMarkdown, toMarkdown } from './markdown';
import { markdownCorpus } from './markdown.corpus';

const noKeys = {
  onEscape: () => false,
  onModEnter: () => false,
  onLinkShortcut: () => false,
  onFocusToolbar: () => false,
};

/** md → the real editor schema (as the description editor loads it) → md. */
function roundTrip(markdown: string): string {
  const editor = new Editor({
    extensions: editorExtensions({ placeholder: '', ...noKeys }),
    content: fromMarkdown(markdown),
  });
  const out = toMarkdown(editor.getJSON());
  editor.destroy();
  return out;
}

describe('Markdown round-trip corpus (10 §3.5)', () => {
  test('has 40 samples', () => {
    expect(markdownCorpus).toHaveLength(40);
  });

  test.each(markdownCorpus.map((s) => [s.name, s] as const))('%s', (_name, sample) => {
    const canonical = sample.expected ?? sample.md;
    expect(roundTrip(sample.md)).toBe(canonical);
    // The canonical form is a fixed point.
    expect(roundTrip(canonical)).toBe(canonical);
  });
});
