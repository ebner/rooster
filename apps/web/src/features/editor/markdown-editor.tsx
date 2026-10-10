import { type Editor, EditorContent, isTextSelection, useEditor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { detectPlatform } from '../../lib/platform';
import { Button } from '../../ui/button';
import { overlayOffsetPx } from '../../ui/popover';
import { editorExtensions } from './extensions';
import { FormatToolbar } from './format-toolbar';
import { fromMarkdown, toMarkdown } from './markdown';
import './editor.css';

/** FR-DET-5: edits are reported after this much idle time (and on blur). */
export const changeDebounceMs = 600;

/** 02 §9.2: descriptions longer than this collapse behind "Show more". */
export const defaultCollapsedLines = 12;

export interface MarkdownEditorProps {
  /** The stored Markdown. Changes from outside replace the content unless the editor has focus. */
  value: string;
  /**
   * Reports the edited Markdown (FR-DET-5): 600 ms after the last edit, and at once on
   * blur, Esc, Mod+Enter and unmount when an edit is still pending. Only called when the
   * Markdown actually differs from the last value seen, so callers save it as is.
   */
  onChange: (markdown: string) => void;
  /** Accessible name of the text area, e.g. "Description". */
  ariaLabel: string;
  /** Defaults to "Add more detail…". */
  placeholder?: string | undefined;
  /** Collapse when not focused and taller than this many lines (default 12). */
  collapsedLines?: number | undefined;
  /** Focus the end of the text on mount. */
  autoFocus?: boolean | undefined;
  /** Render only: no caret, no toolbar; links open in a new tab. */
  readOnly?: boolean | undefined;
  /** Esc in the text (02 §9.1: back to the list). Pending edits are reported first. */
  onEscape?: (() => void) | undefined;
  /** Mod+Enter in the text. Pending edits are reported first. */
  onModEnter?: (() => void) | undefined;
  className?: string | undefined;
  /** Kitchen sink: show the bubble toolbar statically under the text. */
  forceToolbar?: 'buttons' | 'link' | undefined;
}

/** Fallback when the computed line height is unavailable (jsdom): `--text-md` is 24 px. */
const fallbackLineHeightPx = 24;

/**
 * The task description editor (FR-DET-3, 02 §9.2): WYSIWYG Markdown with Markdown
 * shortcuts (`# `, `- `, `1. `, `[] `, `> `, ``` ``` ```, `**`, `` ` ``), a bubble toolbar
 * on selection (Alt+F10 focuses it), and a collapsed view for long text. Tab and
 * Shift+Tab indent and outdent inside lists and otherwise move focus as usual.
 */
export function MarkdownEditor({
  value,
  onChange,
  ariaLabel,
  placeholder,
  collapsedLines = defaultCollapsedLines,
  autoFocus = false,
  readOnly = false,
  onEscape,
  onModEnter,
  className,
  forceToolbar,
}: MarkdownEditorProps) {
  const { t } = useTranslation('editor');
  const contentId = useId();
  const latest = useRef({ onChange, onEscape, onModEnter, readOnly, value });
  latest.current = { onChange, onEscape, onModEnter, readOnly, value };
  const tRef = useRef(t);
  tRef.current = t;
  const placeholderText = placeholder ?? t('placeholder');
  const placeholderRef = useRef(placeholderText);
  placeholderRef.current = placeholderText;

  /** The Markdown the document is known to match (the last value received or reported). */
  const known = useRef(value);
  /** The last `value` prop handled, and whether applying it waits for the blur. */
  const received = useRef(value);
  const deferred = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [linkMode, setLinkMode] = useState(forceToolbar === 'link');
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  /** Reports a pending edit; true when something was reported. */
  const flush = useCallback(() => {
    if (timer.current === null) return false;
    clearTimeout(timer.current);
    timer.current = null;
    const editor = editorRef.current;
    if (!editor) return false;
    const markdown = toMarkdown(editor.state.doc.toJSON());
    if (markdown === known.current) return false;
    known.current = markdown;
    latest.current.onChange(markdown);
    return true;
  }, []);

  // A description the converter fails on, met outside React's rendering (a blur, a change from
  // outside): rethrown while rendering, so the caller's error boundary shows the fallback.
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  if (failure) throw failure.error;
  const replaceContent = useCallback((markdown: string) => {
    known.current = markdown;
    try {
      editorRef.current?.commands.setContent(fromMarkdown(markdown), { emitUpdate: false });
    } catch (error) {
      setFailure({ error });
    }
  }, []);

  const [extensions] = useState(() =>
    editorExtensions({
      placeholder: () => placeholderRef.current,
      taskCheckboxLabel: (text) => tRef.current('taskCheckbox', { text: text || '…' }),
      linkOpenHint: () =>
        tRef.current('link.openHint', { key: detectPlatform() === 'mac' ? '⌘' : 'Ctrl' }),
      onEscape: () => {
        const handler = latest.current.onEscape;
        if (!handler) return false;
        flush();
        handler();
        return true;
      },
      onModEnter: () => {
        const handler = latest.current.onModEnter;
        if (!handler) return false;
        flush();
        handler();
        return true;
      },
      onLinkShortcut: () => {
        const editor = editorRef.current;
        if (!editor?.isEditable) return false;
        if (editor.state.selection.empty) {
          // Inside a link, select it; on plain text leave Mod+K to the global search.
          if (!editor.isActive('link')) return false;
          editor.commands.extendMarkRange('link');
        }
        setLinkMode(true);
        return true;
      },
      onFocusToolbar: () => {
        const first = toolbarRef.current?.querySelector<HTMLElement>('button, input');
        if (!first?.isConnected) return false;
        first.focus();
        return true;
      },
    }),
  );
  const [initialContent] = useState(() => fromMarkdown(value));

  const editorProps = useMemo(
    () => ({
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': ariaLabel,
        ...(readOnly ? { 'aria-readonly': 'true' } : {}),
        'aria-placeholder': placeholderText,
        class: cn('rooster-prose min-h-control w-full outline-none', !readOnly && 'cursor-text'),
        'data-testid': 'markdown-editor',
      },
    }),
    [ariaLabel, readOnly, placeholderText],
  );

  const editor = useEditor({
    extensions,
    content: initialContent,
    editable: !readOnly,
    autofocus: autoFocus ? 'end' : false,
    editorProps,
    onUpdate: () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        // Run the same path as blur, which clears the timer itself.
        flush();
      }, changeDebounceMs);
    },
    onFocus: () => setExpanded(true),
    onBlur: () => {
      const reported = flush();
      // A change from outside that arrived while editing applies now, unless this
      // editor just reported its own edit (the last edit wins).
      if (!deferred.current) return;
      deferred.current = false;
      if (!reported && received.current !== known.current) replaceContent(received.current);
    },
  });
  editorRef.current = editor;

  // A new value from outside (another device, the CLI, undo) replaces the content;
  // while the text has focus it waits for the blur.
  useEffect(() => {
    if (value === received.current) return;
    received.current = value;
    if (value === known.current) return;
    if (editor.isFocused) deferred.current = true;
    else replaceContent(value);
  }, [editor, value, replaceContent]);

  useEffect(() => {
    if (editor.isEditable === !readOnly) return;
    editor.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  // Report a pending edit when the editor goes away (navigating to another task).
  useEffect(
    () => () => {
      flush();
    },
    [flush],
  );

  // Collapse: measure the natural height of the text against N lines.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const measure = () => {
      const prose = element.querySelector<HTMLElement>('.rooster-prose') ?? element;
      const lineHeight = Number.parseFloat(getComputedStyle(prose).lineHeight);
      const line =
        Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : fallbackLineHeightPx;
      setOverflowing(prose.scrollHeight > line * collapsedLines + 1);
    };
    measure();
    editor.on('update', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      editor.off('update', measure);
      observer?.disconnect();
    };
  }, [editor, collapsedLines]);

  const collapsed = overflowing && !expanded;

  return (
    <div className={cn('flex w-full flex-col items-start gap-1', className)}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: focus inside expands the text */}
      <div
        id={contentId}
        ref={contentRef}
        // Focus anywhere inside (the text, or a link in read-only text) expands it.
        onFocus={() => setExpanded(true)}
        className={cn('w-full', collapsed && 'rooster-prose-clip')}
        style={
          collapsed
            ? { maxHeight: `calc(${collapsedLines} * var(--text-md--line-height))` }
            : undefined
        }
      >
        <EditorContent editor={editor} />
      </div>
      {overflowing && (
        <Button
          variant="link"
          size="sm"
          aria-expanded={!collapsed}
          aria-controls={contentId}
          // A 28 px row keeps the 24 px target size (WCAG 2.5.8).
          className="h-control-sm"
          onPress={() => setExpanded((open) => !open)}
        >
          {collapsed ? t('showMore') : t('showLess')}
        </Button>
      )}
      {!readOnly && !forceToolbar && (
        <BubbleMenu
          editor={editor}
          shouldShow={({ editor: e, view, state, from, to }) => {
            if (!e.isEditable || e.isActive('codeBlock')) return false;
            const inMenu = toolbarRef.current?.contains(document.activeElement) ?? false;
            if (!view.hasFocus() && !inMenu) return false;
            return !state.selection.empty && isTextSelection(state.selection) && from !== to;
          }}
          options={{
            placement: 'top',
            strategy: 'fixed',
            offset: overlayOffsetPx,
            onHide: () => setLinkMode(false),
          }}
          appendTo={() => document.body}
          className="z-(--z-popover)"
        >
          <div ref={toolbarRef}>
            <FormatToolbar editor={editor} linkMode={linkMode} onLinkModeChange={setLinkMode} />
          </div>
        </BubbleMenu>
      )}
      {forceToolbar && (
        <div ref={toolbarRef}>
          <FormatToolbar
            editor={editor}
            linkMode={linkMode}
            onLinkModeChange={setLinkMode}
            isTooltipOpen={false}
            autoFocusLink={false}
          />
        </div>
      )}
    </div>
  );
}
