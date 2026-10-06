import { memo, Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { lazyWithPreload, preloadWhenIdle } from '../../lib/lazy';
import { LazyDatePanel, LazyDatePopover } from '../dates/lazy';
import { LazyGroupDeletePopover, LazyMoveToPopover, LazyTagPicker } from '../list/lazy';

// 10 §4: Tiptap and ProseMirror stay out of the initial bundle (see `lib/lazy.ts`).
const MarkdownEditor = lazyWithPreload(() =>
  import('../editor/markdown-editor').then((m) => m.MarkdownEditor),
);

let prefetched = false;

/**
 * Warms the lazily loaded interaction chunks (editor, date picker, tag picker, menus) once the
 * app is idle, so their first open needs no network, also offline before the service worker
 * has cached them. Mounted by the tasks screen.
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
    </div>
  );
});
