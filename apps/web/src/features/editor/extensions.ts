import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { type AnyExtension, Extension, isActive } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { LinkMarkdown, linkOptions } from './link';

/** Heading levels the description supports (FR-DET-3). */
export const headingLevels = [1, 2, 3] as const;
export type HeadingLevel = (typeof headingLevels)[number];

/**
 * The description schema (FR-DET-3): H1–H3, bold, italic, strike, inline code, code
 * block, links, bullet/ordered/task lists (nested), blockquote, hr and hard breaks.
 * Underline is off: Markdown has no syntax for it. Shared by the editor and the
 * headless Markdown converter, so both agree on what a document can hold; the
 * converter swaps the interactive Link for its Markdown-only twin (see `LinkMarkdown`).
 */
export function schemaExtensions(
  target: 'editor' | 'markdown' = 'editor',
  options: { taskCheckboxLabel?: ((itemText: string) => string) | undefined } = {},
): AnyExtension[] {
  const { taskCheckboxLabel } = options;
  return [
    StarterKit.configure({
      heading: { levels: [...headingLevels] },
      underline: false,
      link: target === 'editor' ? linkOptions : false,
      codeBlock: { defaultLanguage: null, enableTabIndentation: false },
    }),
    ...(target === 'markdown' ? [LinkMarkdown] : []),
    TaskList,
    TaskItem.configure({
      nested: true,
      // Named by the item's own text, not its nested sub-items.
      ...(taskCheckboxLabel
        ? {
            a11y: {
              checkboxLabel: (node) => taskCheckboxLabel(node.firstChild?.textContent ?? ''),
            },
          }
        : {}),
    }),
  ];
}

export interface EditorKeymapOptions {
  /** Esc; return false to let the key through (e.g. no handler). */
  onEscape: () => boolean;
  /** Mod+Enter; return false to let the key through. */
  onModEnter: () => boolean;
  /** Mod+K (open the link field); return false to leave it to the global search. */
  onLinkShortcut: () => boolean;
  /** Alt+F10 (move focus into the bubble toolbar); return false when there is none. */
  onFocusToolbar: () => boolean;
}

/**
 * Editor-level command keys. High priority so they beat the starter kit (its hard
 * break also binds Mod+Enter); each returns false when unhandled, so the key falls
 * through to the default (a hard break, or the global search for Mod+K).
 */
export const EditorKeymap = Extension.create<EditorKeymapOptions>({
  name: 'roosterEditorKeymap',
  priority: 1000,
  addOptions() {
    return {
      onEscape: () => false,
      onModEnter: () => false,
      onLinkShortcut: () => false,
      onFocusToolbar: () => false,
    };
  },
  addKeyboardShortcuts() {
    return {
      Escape: () => this.options.onEscape(),
      'Mod-Enter': () => this.options.onModEnter(),
      'Mod-k': () => this.options.onLinkShortcut(),
      'Alt-F10': () => this.options.onFocusToolbar(),
    };
  },
});

const listItemTypes = ['listItem', 'taskItem'] as const;

/**
 * Tab in lists. Runs after the list extensions (lower priority), so their Tab
 * (indent) and Shift+Tab (outdent) win when they apply; inside a list, Tab is then
 * swallowed even when the item cannot move, so focus does not jump out mid-list.
 * Outside lists Tab is not handled and moves focus as usual.
 */
export const ListTabKeymap = Extension.create({
  name: 'roosterListTab',
  priority: 50,
  addKeyboardShortcuts() {
    const inList = () => listItemTypes.some((type) => isActive(this.editor.state, type));
    return {
      Tab: () => inList(),
      'Shift-Tab': () => inList(),
    };
  },
});

export interface EditorExtensionOptions extends EditorKeymapOptions {
  /** A function is read on every render of the placeholder (language switches). */
  placeholder: string | (() => string);
  /** The accessible name of a task item's checkbox, from the item's text. */
  taskCheckboxLabel?: ((itemText: string) => string) | undefined;
}

/** Everything the interactive editor uses: the schema plus placeholder and keys. */
export function editorExtensions(options: EditorExtensionOptions): AnyExtension[] {
  const { placeholder } = options;
  return [
    ...schemaExtensions('editor', { taskCheckboxLabel: options.taskCheckboxLabel }),
    Placeholder.configure({
      placeholder: typeof placeholder === 'string' ? placeholder : () => placeholder(),
      showOnlyWhenEditable: false,
    }),
    EditorKeymap.configure({
      onEscape: options.onEscape,
      onModEnter: options.onModEnter,
      onLinkShortcut: options.onLinkShortcut,
      onFocusToolbar: options.onFocusToolbar,
    }),
    ListTabKeymap,
  ];
}
