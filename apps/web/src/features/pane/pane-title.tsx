import { TASK_TITLE_MAX } from '@rooster/core/schemas';
import { type Ref, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';

export interface PaneTitleHandle {
  focus: () => void;
  /** Commits a pending edit (before another action or a task switch). */
  commit: () => void;
}

export interface PaneTitleProps {
  value: string;
  done: boolean;
  onCommit: (title: string) => void;
  onEscape: () => void;
  ref?: Ref<PaneTitleHandle>;
}

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * 02 §9.2 item 3: a 24/32 semibold textarea that grows with the text. Enter commits and
 * Shift+Enter is ignored (titles are one line); blur and Esc commit too. An emptied title is
 * restored.
 */
export function PaneTitle({ value, done, onCommit, onEscape, ref }: PaneTitleProps) {
  const { t } = useTranslation('pane');
  const area = useRef<HTMLTextAreaElement>(null);
  const committed = useRef(value);

  const grow = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  // Outside changes (undo, another device) show up unless the user is typing.
  useLayoutEffect(() => {
    const el = area.current;
    committed.current = value;
    if (el && document.activeElement !== el) el.value = value;
    grow();
  }, [value]);

  const commit = () => {
    const el = area.current;
    if (!el) return;
    const next = clean(el.value).slice(0, TASK_TITLE_MAX);
    if (next === '') {
      el.value = committed.current;
      grow();
      return;
    }
    if (next !== el.value) el.value = next;
    if (next === committed.current) return;
    committed.current = next;
    onCommit(next);
  };

  useImperativeHandle(ref, () => ({
    focus: () => {
      const el = area.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    },
    commit,
  }));

  // A pending edit is saved when the pane switches task or closes.
  useLayoutEffect(() => () => commit(), []);

  return (
    <textarea
      ref={area}
      data-pane-input
      data-testid="pane-title"
      rows={1}
      aria-label={t('title.label')}
      placeholder={t('title.placeholder')}
      defaultValue={value}
      maxLength={TASK_TITLE_MAX}
      spellCheck
      onInput={grow}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          if (!event.shiftKey) commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          commit();
          onEscape();
        }
      }}
      className={cn(
        '-mx-1 resize-none overflow-hidden rounded-sm bg-transparent px-1 text-xl text-text outline-none',
        'placeholder:text-text-muted focus-visible:outline-2 focus-visible:outline-border-focus',
        done && 'text-text-muted line-through',
      )}
    />
  );
}
