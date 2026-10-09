import { COMMENT_BODY_MAX } from '@rooster/core/limits';
import { SendHorizontal } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { matchesShortcut, primaryKeys } from '../../keymap';
import { cn } from '../../lib/cn';
import { detectPlatform } from '../../lib/platform';
import { Avatar } from '../../ui/avatar';
import { IconButton } from '../../ui/icon-button';
import { readDraft, writeDraft } from './drafts';
import {
  filterCandidates,
  insertMention,
  type MentionCandidate,
  mentionQueryAt,
} from './mention-suggest';

export interface CommentComposerHandle {
  focus: () => void;
  /** Posts the draft (Ctrl/⌘+Enter, or Tab+Enter through the pane). */
  submit: () => void;
}

export interface CommentComposerProps {
  /** The draft is kept per task while the app runs. */
  taskId: string;
  /** Org members the `@` autocomplete offers. */
  candidates: readonly MentionCandidate[];
  onPost: (body: string) => void;
  /** Esc with nothing to dismiss: back to the list (02 §9.1). */
  onEscape?: (() => void) | undefined;
  /** Phones: full-width suggestion rows with touch-sized targets. */
  touch?: boolean;
  /** Left of the post button: the followers and the Follow toggle. */
  footer?: ReactNode;
  ref?: Ref<CommentComposerHandle>;
  /** Kitchen sink: a fixed draft (with the caret at its end). */
  initialText?: string;
  className?: string | undefined;
}

/** The field grows up to this many lines, then scrolls. */
const maxLines = 8;

/**
 * The comment composer (02 §9.2 item 8, ADR 0028): a plain auto-growing textarea. Typing `@`
 * offers the org's members; picking one inserts the stored mention `@[Name](user:<id>)`.
 * Ctrl/⌘+Enter posts here; Tab+Enter reaches it as the pane's chord (`data-comment-composer`).
 */
export function CommentComposer({
  taskId,
  candidates,
  onPost,
  onEscape,
  touch = false,
  footer,
  ref,
  initialText,
  className,
}: CommentComposerProps) {
  const { t } = useTranslation('collab');
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => initialText ?? readDraft(taskId));
  const [caret, setCaret] = useState(() => (initialText ?? readDraft(taskId)).length);
  const [active, setActive] = useState(0);
  /** The `@` whose suggestions Esc closed; typing another mention opens them again. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const nextCaret = useRef<number | null>(null);
  const listId = useId();
  const platform = useMemo(() => detectPlatform(), []);

  const mention = mentionQueryAt(text, caret);
  const suggestions = useMemo(
    () => (mention ? filterCandidates(candidates, mention.query) : []),
    [mention?.query, candidates, mention],
  );
  const open = mention !== null && mention.start !== dismissedAt && suggestions.length > 0;
  const activeIndex = Math.min(active, suggestions.length - 1);

  const update = (next: string, at: number) => {
    setText(next);
    setCaret(at);
    setActive(0);
    if (initialText === undefined) writeDraft(taskId, next);
  };

  const submit = () => {
    const body = text.trim();
    if (body === '' || body.length > COMMENT_BODY_MAX) return;
    onPost(body);
    update('', 0);
    setDismissedAt(null);
  };

  useImperativeHandle(ref, () => ({ focus: () => field.current?.focus(), submit }));

  const pick = (candidate: MentionCandidate) => {
    if (!mention) return;
    const result = insertMention(text, mention, candidate);
    nextCaret.current = result.caret;
    update(result.text, result.caret);
    field.current?.focus();
  };

  // Grow with the text up to `maxLines`, measured from the field's own line height.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    if (nextCaret.current !== null) {
      el.setSelectionRange(nextCaret.current, nextCaret.current);
      nextCaret.current = null;
    }
    const style = getComputedStyle(el);
    const line = Number.parseFloat(style.lineHeight) || 20;
    const border =
      Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
    const chrome =
      Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) + border;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + border, line * maxLines + chrome)}px`;
  }, [text]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    const consume = () => {
      event.preventDefault();
      // The document's keymap must not see it (Tab would start a chord, Esc leave the pane).
      event.stopPropagation();
    };
    if (open) {
      const candidate = suggestions[activeIndex];
      if (event.key === 'ArrowDown' && plain) {
        consume();
        setActive((activeIndex + 1) % suggestions.length);
        return;
      }
      if (event.key === 'ArrowUp' && plain) {
        consume();
        setActive((activeIndex - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && plain && candidate) {
        if (event.nativeEvent.isComposing) return;
        consume();
        pick(candidate);
        return;
      }
      if (event.key === 'Escape') {
        consume();
        setDismissedAt(mention?.start ?? null);
        return;
      }
    }
    if (matchesShortcut(event, 'Mod+Enter', platform)) {
      consume();
      submit();
      return;
    }
    if (event.key === 'Escape' && plain) {
      consume();
      onEscape?.();
    }
  };

  const optionId = (index: number) => `${listId}-${index}`;
  const empty = text.trim() === '';

  return (
    <div className={cn('relative flex flex-col gap-2', className)}>
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={t('composer.suggestions')}
          data-testid="mention-suggestions"
          className={cn(
            'absolute inset-x-0 bottom-full z-(--z-popover) mb-1 flex flex-col overflow-y-auto',
            touch
              ? 'rounded-t-lg border-t border-border bg-bg-elevated py-1 shadow-lg'
              : 'w-pane-min max-w-full rounded-md border border-border bg-bg-elevated p-1 shadow-md animate-popover-in motion-reduce:animate-fade-in',
          )}
        >
          {suggestions.map((candidate, index) => (
            // Options stay in the field's keyboard flow (aria-activedescendant): ↑/↓, Enter or Tab pick.
            // biome-ignore lint/a11y/useKeyWithClickEvents: picked from the field's keys
            <div
              key={candidate.userId}
              id={optionId(index)}
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              // Keeps focus (and the keyboard) in the field.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(candidate)}
              onMouseEnter={() => setActive(index)}
              className={cn(
                'flex min-w-0 cursor-default items-center gap-2 px-2 text-sm',
                touch ? 'h-hit-touch px-4 text-md' : 'h-control rounded-sm',
                index === activeIndex && 'bg-bg-subtle',
              )}
            >
              <Avatar
                id={candidate.userId}
                name={candidate.name}
                src={candidate.image ?? undefined}
                size={touch ? 24 : 20}
                decorative
              />
              <span className="min-w-0 truncate text-text">{candidate.name}</span>
              {candidate.email && (
                <span className="min-w-0 truncate text-xs text-text-muted">{candidate.email}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={field}
        value={text}
        rows={1}
        maxLength={COMMENT_BODY_MAX}
        aria-label={t('composer.label')}
        placeholder={t('composer.placeholder')}
        // A multi-line textbox, not a combobox (ARIA allows that role only on <input>): the
        // suggestions are announced through aria-autocomplete and the active descendant.
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        data-comment-composer
        data-testid="comment-composer"
        enterKeyHint="enter"
        onChange={(event) => update(event.target.value, event.target.selectionStart)}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onBlur={() => setDismissedAt(mention?.start ?? null)}
        onFocus={() => setDismissedAt(null)}
        className={cn(
          'block w-full resize-none overflow-y-auto rounded-sm border border-border bg-bg-elevated px-3 py-2 text-sm text-text',
          'placeholder:text-text-muted hover:border-border-strong',
          'outline-none focus-visible:border-border-focus focus-visible:outline-2 focus-visible:outline-border-focus',
          touch && 'text-md',
        )}
      />
      <div className="flex min-h-control items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">{footer}</div>
        <IconButton
          icon={SendHorizontal}
          variant={empty ? 'ghost' : 'primary'}
          aria-label={t('composer.post')}
          shortcut={primaryKeys('postComment')}
          isDisabled={empty}
          onPress={submit}
          data-testid="comment-post"
        />
      </div>
    </div>
  );
}
