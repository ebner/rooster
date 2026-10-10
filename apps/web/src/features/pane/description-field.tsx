import {
  Component,
  type ErrorInfo,
  memo,
  type ReactNode,
  Suspense,
  useEffect,
  useId,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { lazyWithPreload, preloadWhenIdle } from '../../lib/lazy';
import { LazyPaneActivity } from '../collab/lazy';
import { LazyDatePanel, LazyDatePopover } from '../dates/lazy';
import { LazyGroupDeletePopover, LazyMoveToPopover, LazyTagPicker } from '../list/lazy';

// 10 §4: Tiptap and ProseMirror stay out of the initial bundle (see `lib/lazy.ts`).
const MarkdownEditor = lazyWithPreload(() =>
  import('../editor/markdown-editor').then((m) => m.MarkdownEditor),
);

let prefetched = false;

/**
 * Warms the lazily loaded interaction chunks (editor, date picker, tag picker, menus, the
 * activity feed) once the app is idle, so their first open needs no network, also offline
 * before the service worker has cached them. Mounted by the tasks screen.
 */
export function InteractionPrefetch() {
  useEffect(() => {
    if (prefetched) return;
    prefetched = true;
    preloadWhenIdle([
      MarkdownEditor.preload,
      LazyDatePopover.preload,
      LazyDatePanel.preload,
      LazyTagPicker.preload,
      LazyMoveToPopover.preload,
      LazyGroupDeletePopover.preload,
      LazyPaneActivity.preload,
    ]);
  }, []);
  return null;
}

export interface DescriptionFieldProps {
  /** Markdown. */
  value: string;
  /** Called on blur and after 600 ms idle (FR-DET-5), only with a changed value. */
  onChange: (markdown: string) => void;
  autoFocus?: boolean | undefined;
  readOnly?: boolean | undefined;
  /** Esc in the text: back to the list (02 §9.1). */
  onEscape?: (() => void) | undefined;
  onModEnter?: (() => void) | undefined;
}

/**
 * The pane's description (02 §9.2 item 5) behind one small adapter, so the pane does not
 * depend on the editor's internals. Tab belongs to the editor here (list indent), so Tab
 * chords are off inside it (`data-no-chords`).
 */
export const DescriptionField = memo(function DescriptionField({
  value,
  onChange,
  autoFocus,
  readOnly,
  onEscape,
  onModEnter,
}: DescriptionFieldProps) {
  const { t } = useTranslation('pane');
  return (
    <div data-no-chords data-testid="description-field">
      <EditorFallbackBoundary
        fallback={
          <PlainDescription
            value={value}
            onChange={onChange}
            readOnly={readOnly}
            onEscape={onEscape}
            onModEnter={onModEnter}
          />
        }
      >
        <Suspense
          fallback={
            // The raw Markdown in the editor's type, so the pane doesn't jump when it loads.
            <div className="line-clamp-12 min-h-row w-full whitespace-pre-wrap text-md text-text-secondary">
              {value || t('description.placeholder')}
            </div>
          }
        >
          <MarkdownEditor
            value={value}
            onChange={onChange}
            ariaLabel={t('description.label')}
            placeholder={t('description.placeholder')}
            collapsedLines={12}
            autoFocus={autoFocus}
            readOnly={readOnly}
            onEscape={onEscape}
            onModEnter={onModEnter}
          />
        </Suspense>
      </EditorFallbackBoundary>
    </div>
  );
});

/**
 * A description the editor cannot show (it threw while parsing or rendering) must not take the
 * pane down for everyone who opens the task: the plain text takes over, still editable, until
 * the pane closes.
 */
class EditorFallbackBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.warn('rooster: the description editor failed; showing plain text', error, info);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** The description as plain, editable text: saved on blur, like the editor (FR-DET-5). */
export function PlainDescription({
  value,
  onChange,
  readOnly,
  onEscape,
  onModEnter,
}: Omit<DescriptionFieldProps, 'autoFocus'>) {
  const { t } = useTranslation('pane');
  const noteId = useId();
  const [text, setText] = useState(value);
  const commit = () => {
    if (text !== value) onChange(text);
  };
  return (
    <div className="flex flex-col gap-1" data-testid="description-plain">
      <p id={noteId} className="text-xs text-text-muted">
        {t('description.plainNote')}
      </p>
      <textarea
        value={text}
        rows={6}
        readOnly={readOnly}
        aria-label={t('description.label')}
        aria-describedby={noteId}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            commit();
            onEscape?.();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            commit();
            onModEnter?.();
          }
        }}
        className={cn(
          'block w-full resize-y rounded-sm border border-border bg-bg-elevated px-3 py-2 text-sm text-text',
          'outline-none focus-visible:border-border-focus focus-visible:outline-2 focus-visible:outline-border-focus',
        )}
      />
    </div>
  );
}
