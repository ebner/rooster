import { assigneeTokenAt } from '@rooster/core/dates';
import { TASK_TITLE_MAX } from '@rooster/core/limits';
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { matches } from '../../keymap';
import { cn } from '../../lib/cn';
import { detectPlatform } from '../../lib/platform';
import type { Caret } from '../../state/list-store';
import { useTagsStore } from '../../state/tags-store';
import { Avatar } from '../../ui/avatar';
import { memberHandle, resolveAssigneeToken, suggestMembers } from '../people/assignee-token';
import type { Person } from '../people/members';
import { TagDot } from '../tags/tag-dot';
import { type TagOption, tagOptions } from '../tags/tag-options';
import type { CommitResult } from './controller';
import { useListContext } from './list-context';
import {
  blankSpan,
  findTagTokens,
  findTitleDate,
  resolveGroupToken,
  type Span,
  tagTokenAt,
  titleReminderTokens,
} from './title-tokens';

/** 02 §8.1: parsing runs debounced on every keystroke. */
const parseDebounceMs = 50;

const platform = detectPlatform();

/**
 * Set when Backspace removed a row: the rest of that key's auto-repeat must not eat the
 * previous row's title either (02 §3.5: holding Backspace removes at most one row).
 */
let backspaceLatch = false;

/**
 * What the phone's accessory bar (02 §13.3) can do to the title being edited: it lives
 * outside the row, so the input registers these while it is mounted.
 */
export interface TitleInputHandle {
  /** "↵ Next": the same as Enter (commit, then a new draft below). */
  next: () => void;
  /** Inserts text at the caret, e.g. `#` to start a tag token. */
  insert: (text: string) => void;
  focus: () => void;
}

const handles = new Map<string, TitleInputHandle>();

export function titleInputHandle(rowId: string): TitleInputHandle | undefined {
  return handles.get(rowId);
}

export interface TitleInputProps {
  rowId: string;
  initialValue: string;
  caret: Caret;
  /** Changes when the caret should be placed again. */
  caretSeq: number;
  label: string;
  className?: string | undefined;
}

interface Highlight {
  text: string;
  /** The date phrase (02 §8.1). */
  span: Span | null;
  /** `#tag` tokens (02 §3.4). */
  tags: Span[];
  /** `>Group` in a smart-view draft (02 §3.4). */
  group: Span | null;
  /** `@name` in a new task of a shared org (02 §3.4, P6). */
  assignee: Span | null;
  /** P10 (02 §8.1): `!15m`/`!1h`/`!1d`/`!due` reminder tokens. */
  reminders: Span[];
}

interface Suggest {
  token: Span & { name: string };
  options: TagOption[];
  active: number;
}

/** The `@name` autocomplete: org members (02 §3.4). */
interface MemberSuggest {
  token: Span & { query: string };
  options: Person[];
  active: number;
}

/** Mirror segments: plain text and highlighted tokens, in order. */
function segments(text: string, marks: readonly Span[]): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const m of [...marks].sort((a, b) => a.start - b.start)) {
    if (m.start < at) continue;
    out.push({ text: text.slice(at, m.start), mark: false });
    out.push({ text: text.slice(m.start, m.end), mark: true });
    at = m.end;
  }
  out.push({ text: text.slice(at), mark: false });
  return out;
}

/** Places the caret per the edit request. */
export function placeCaret(input: HTMLInputElement, caret: Caret): void {
  const length = input.value.length;
  if (caret === 'all') input.setSelectionRange(0, length);
  else if (caret === 'start') input.setSelectionRange(0, 0);
  else if (caret === 'end') input.setSelectionRange(length, length);
  else input.setSelectionRange(Math.min(caret, length), Math.min(caret, length));
}

/** Every occurrence of an ignored phrase in the current text (offsets move as the user types). */
function ignoredSpans(text: string, phrases: readonly string[]): Span[] {
  const spans: Span[] = [];
  for (const phrase of phrases) {
    let from = text.indexOf(phrase);
    while (from >= 0) {
      spans.push({ start: from, end: from + phrase.length });
      from = text.indexOf(phrase, from + 1);
    }
  }
  return spans;
}

/**
 * The inline title editor (02 §3.4–3.5, 04 §5.4). Uncontrolled: typing never re-renders the
 * list; the title commits on Enter, Esc, blur or ↑/↓. A date phrase is highlighted (debounced)
 * through a mirror layer behind the transparent input.
 */
export function TitleInput({
  rowId,
  initialValue,
  caret,
  caretSeq,
  label,
  className,
}: TitleInputProps) {
  const { t } = useTranslation('list');
  const { controller, dateCtx, parseTitles, view, shared, everyone } = useListContext();
  const input = useRef<HTMLInputElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const committed = useRef(false);
  const ignored = useRef<string[]>([]);
  const [highlight, setHighlight] = useState<Highlight>({
    text: initialValue,
    span: null,
    tags: [],
    group: null,
    assignee: null,
    reminders: [],
  });
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [memberSuggest, setMemberSuggest] = useState<MemberSuggest | null>(null);
  const tagsById = useTagsStore((s) => s.byId);
  const [colonChip, setColonChip] = useState<'off' | 'shown' | 'declined'>('off');
  const [pasteLines, setPasteLines] = useState<string[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** A new task in a smart view: `>Group` picks its group (02 §3.4). */
  const groupTokens = () => {
    const draft = controller.ui().drafts.find((d) => d.id === rowId);
    return Boolean(view && draft?.sectionId && !draft.parentId);
  };

  /** A new task in a shared org: `@name` picks its assignee (02 §3.4); none in personal orgs. */
  const members = (): readonly Person[] => {
    if (!shared || !controller.ui().drafts.some((d) => d.id === rowId)) return [];
    return controller.deps.members?.() ?? [];
  };

  const reparse = () => {
    const text = input.current?.value ?? '';
    const skip = ignoredSpans(text, ignored.current);
    const groups = Object.values(controller.state()?.groups ?? {});
    const who = resolveAssigneeToken(text, members(), controller.deps.userId, skip);
    const withoutWho = who ? blankSpan(text, who) : text;
    const group = groupTokens() ? resolveGroupToken(withoutWho, groups, skip) : null;
    // A group named like a date ("Today") is the group, not a date phrase.
    const dateText = group ? blankSpan(withoutWho, group) : withoutWho;
    const match = parseTitles ? findTitleDate(dateText, dateCtx, skip) : null;
    // `!1h` needs a due date: the title's own phrase or the task's (02 §8.1, P10).
    const reminders = parseTitles
      ? titleReminderTokens(text, skip, match !== null || controller.hasDueFor(rowId))
      : [];
    setHighlight({
      text,
      span: match ? { start: match.start, end: match.end } : null,
      tags: findTagTokens(text, skip),
      group: group ? { start: group.start, end: group.end } : null,
      assignee: who ? { start: who.start, end: who.end } : null,
      reminders: reminders.map(({ start, end }) => ({ start, end })),
    });
  };

  /** The member autocomplete for the `@partial` token at the caret (02 §3.4). */
  const updateMemberSuggest = () => {
    const el = input.current;
    const all = members();
    const token =
      el && el.selectionStart === el.selectionEnd && all.length > 0
        ? assigneeTokenAt(el.value, el.selectionStart ?? 0)
        : null;
    if (!token) {
      setMemberSuggest(null);
      return;
    }
    const options = suggestMembers(token.query, all, controller.deps.userId).slice(0, 8);
    setMemberSuggest((current) =>
      options.length === 0
        ? null
        : {
            token,
            options,
            active:
              current && current.token.start === token.start
                ? Math.min(current.active, options.length - 1)
                : 0,
          },
    );
  };

  const acceptMember = (member: Person | undefined) => {
    const el = input.current;
    if (!el || !memberSuggest || !member) return;
    const { start, end } = memberSuggest.token;
    const insert = `${memberHandle(member, members())} `;
    const after = el.value.slice(end).replace(/^ /, '');
    el.value = `${el.value.slice(0, start)}${insert}${after}`.slice(0, TASK_TITLE_MAX);
    const caretAt = Math.min(start + insert.length, el.value.length);
    el.setSelectionRange(caretAt, caretAt);
    setMemberSuggest(null);
    reparse();
  };

  /** The autocomplete for the `#partial` token at the caret (02 §3.4). */
  const updateSuggest = () => {
    updateMemberSuggest();
    const el = input.current;
    if (!el || el.selectionStart !== el.selectionEnd) {
      setSuggest(null);
      return;
    }
    const token = tagTokenAt(el.value, el.selectionStart ?? 0);
    if (!token) {
      setSuggest(null);
      return;
    }
    const options = tagOptions(Object.values(tagsById), token.name, token.name !== '').slice(0, 8);
    setSuggest((current) =>
      options.length === 0
        ? null
        : {
            token,
            options,
            active:
              current && current.token.start === token.start
                ? Math.min(current.active, options.length - 1)
                : 0,
          },
    );
  };

  const acceptSuggestion = (option: TagOption | undefined) => {
    const el = input.current;
    if (!el || !suggest || !option) return;
    const { start, end } = suggest.token;
    const insert = `#${option.name} `;
    const after = el.value.slice(end).replace(/^ /, '');
    el.value = `${el.value.slice(0, start)}${insert}${after}`.slice(0, TASK_TITLE_MAX);
    const caretAt = Math.min(start + insert.length, el.value.length);
    el.setSelectionRange(caretAt, caretAt);
    setSuggest(null);
    reparse();
  };

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    placeCaret(el, caret);
    el.scrollIntoView?.({ block: 'nearest' });
    // caretSeq re-applies the requested caret on the same input.
  }, [caretSeq]);

  useEffect(() => {
    reparse();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    const handle: TitleInputHandle = {
      next: () => {
        const el = input.current;
        if (!el) return;
        finish(controller.enter(rowId, el.value, spans(), false));
      },
      insert: (text) => {
        const el = input.current;
        if (!el) return;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? start;
        const before = el.value.slice(0, start);
        const glue = text.startsWith('#') && before !== '' && !before.endsWith(' ') ? ' ' : '';
        el.focus({ preventScroll: true });
        el.setRangeText(`${glue}${text}`, start, end, 'end');
        onInput();
      },
      focus: () => input.current?.focus({ preventScroll: true }),
    };
    handles.set(rowId, handle);
    return () => {
      if (handles.get(rowId) === handle) handles.delete(rowId);
    };
  });

  const value = () => input.current?.value ?? '';
  const spans = () => ignoredSpans(value(), ignored.current);
  const apply = (result: CommitResult) => {
    if (result.restore !== undefined && input.current) {
      input.current.value = result.restore;
      reparse();
    }
  };
  /** A key already committed; the blur that follows must not commit again. */
  const finish = (result: CommitResult) => {
    committed.current = result.restore === undefined;
    apply(result);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const el = event.currentTarget;
    const native = event.nativeEvent;
    if (native.isComposing) return;
    if (backspaceLatch) {
      if (event.key === 'Backspace' && event.repeat) {
        event.preventDefault();
        return;
      }
      backspaceLatch = false;
    }
    if (memberSuggest) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const count = memberSuggest.options.length;
        setMemberSuggest({
          ...memberSuggest,
          active: (memberSuggest.active + step + count) % count,
        });
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        event.preventDefault();
        acceptMember(memberSuggest.options[memberSuggest.active]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMemberSuggest(null);
        return;
      }
    }
    if (suggest) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const count = suggest.options.length;
        setSuggest({ ...suggest, active: (suggest.active + step + count) % count });
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        event.preventDefault();
        acceptSuggestion(suggest.options[suggest.active]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSuggest(null);
        return;
      }
    }
    if (pasteLines) {
      if (event.key === 'Enter') {
        event.preventDefault();
        committed.current = true;
        setPasteLines(null);
        controller.createMany(rowId, pasteLines);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        el.value = pasteLines.join(' ').slice(0, TASK_TITLE_MAX);
        setPasteLines(null);
        reparse();
        return;
      }
      setPasteLines(null);
    }
    if (colonChip === 'shown' && event.key !== 'Enter') {
      setColonChip('declined');
      if (event.key === 'Escape') {
        event.preventDefault();
        return;
      }
    }
    if (matches(native, 'undo', platform) && el.value !== initialValue) {
      // 02 §3.7: the input's own text history first.
      event.stopPropagation();
      return;
    }
    if (matches(native, 'newBelow', platform) || matches(native, 'newAbove', platform)) {
      event.preventDefault();
      const trimmed = el.value.trim();
      if (!event.shiftKey && !view && !everyone && trimmed.length > 1 && trimmed.endsWith(':')) {
        if (colonChip === 'shown') {
          committed.current = true;
          setColonChip('off');
          controller.colonToGroup(rowId, trimmed.slice(0, -1));
          return;
        }
        if (colonChip === 'off') {
          setColonChip('shown');
          return;
        }
      }
      finish(controller.enter(rowId, el.value, spans(), event.shiftKey));
      return;
    }
    if (event.key === 'Escape' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      finish(controller.escapeEdit(rowId, el.value, spans()));
      return;
    }
    if (matches(native, 'caretUp', platform) || matches(native, 'caretDown', platform)) {
      event.preventDefault();
      const caretAt = el.selectionStart ?? el.value.length;
      finish(
        controller.caretMove(
          rowId,
          el.value,
          spans(),
          event.key === 'ArrowUp' ? -1 : 1,
          caretAt === el.value.length ? 'end' : caretAt,
        ),
      );
      return;
    }
    if (matches(native, 'deleteEmpty', platform)) {
      const at = el.selectionStart ?? 0;
      const collapsed = at === el.selectionEnd;
      const span = [
        highlight.span,
        highlight.group,
        highlight.assignee,
        ...highlight.reminders,
      ].find((s) => s && at === s.end);
      if (collapsed && span && highlight.text === el.value) {
        // 02 §8.1: Backspace right after a token cancels it instead of deleting a character.
        event.preventDefault();
        ignored.current = [...ignored.current, el.value.slice(span.start, span.end)];
        reparse();
        return;
      }
      if (el.value === '') {
        event.preventDefault();
        if (controller.backspaceEmpty(rowId, event.repeat)) {
          committed.current = true;
          backspaceLatch = true;
        }
      }
    }
  };

  const onInput = () => {
    if (colonChip !== 'off' && !value().trim().endsWith(':')) setColonChip('off');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(reparse, parseDebounceMs);
    updateSuggest();
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    if (value() !== '') return;
    const lines = event.clipboardData
      .getData('text/plain')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) return;
    event.preventDefault();
    setPasteLines(lines);
  };

  const onClick = (event: MouseEvent<HTMLInputElement>) => {
    // Clicking the highlighted phrase cancels it for this edit (02 §8.1).
    const at = event.currentTarget.selectionStart ?? -1;
    const span = [highlight.span, highlight.group, highlight.assignee, ...highlight.reminders].find(
      (s) => s && at > s.start && at < s.end,
    );
    if (span && highlight.text === value()) {
      ignored.current = [...ignored.current, value().slice(span.start, span.end)];
      reparse();
    }
  };

  const onBlur = () => {
    setSuggest(null);
    setMemberSuggest(null);
    if (committed.current) return;
    // A sheet from the accessory bar has focus for a moment; the edit resumes after it.
    if (controller.ui().suspendedEdit === rowId) return;
    apply(controller.blurEdit(rowId, value(), spans()));
  };

  const syncScroll = () => {
    if (mirror.current && input.current) mirror.current.scrollLeft = input.current.scrollLeft;
  };

  const { text, span, group, assignee } = highlight;
  const marks = [span, group, assignee, ...highlight.tags, ...highlight.reminders].filter(
    (m): m is Span => m !== null,
  );
  const listId = `tag-suggest-${rowId}`;
  const memberListId = `member-suggest-${rowId}`;
  const open = memberSuggest
    ? { id: memberListId, active: memberSuggest.active }
    : suggest
      ? { id: listId, active: suggest.active }
      : null;
  return (
    <div className={cn('relative flex min-w-0 flex-1 items-center', className)}>
      {marks.length > 0 && (
        <div
          ref={mirror}
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre text-transparent"
        >
          {segments(text, marks).map((part, i) =>
            part.mark ? (
              <mark key={i} className="rounded-2xs bg-bg-accent-subtle text-transparent">
                {part.text}
              </mark>
            ) : (
              <span key={i}>{part.text}</span>
            ),
          )}
        </div>
      )}
      {memberSuggest && (
        <div
          id={memberListId}
          role="listbox"
          aria-label={t('assign.suggestions')}
          data-overlay
          data-testid="member-suggest"
          className="absolute top-full left-0 z-(--z-popover) mt-1 flex w-date-popover flex-col rounded-md border border-border bg-bg-elevated p-1 shadow-md"
        >
          {memberSuggest.options.map((member, index) => (
            <div
              key={member.userId}
              id={`${memberListId}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === memberSuggest.active}
              onPointerDown={(e) => {
                // Keep focus (and the edit) in the title.
                e.preventDefault();
                acceptMember(member);
              }}
              onKeyDown={() => undefined}
              className={cn(
                'flex h-control cursor-default items-center gap-2 rounded-sm px-2 text-sm text-text',
                index === memberSuggest.active && 'bg-bg-muted',
              )}
            >
              <Avatar
                id={member.userId}
                name={member.name}
                src={member.image ?? undefined}
                size={20}
                decorative
              />
              <span className="min-w-0 flex-1 truncate">{member.name}</span>
            </div>
          ))}
        </div>
      )}
      {suggest && !memberSuggest && (
        <div
          id={listId}
          role="listbox"
          aria-label={t('tags.suggestions')}
          data-overlay
          className="absolute top-full left-0 z-(--z-popover) mt-1 flex w-date-popover flex-col rounded-md border border-border bg-bg-elevated p-1 shadow-md"
        >
          {suggest.options.map((option, index) => (
            <div
              key={option.id}
              id={`${listId}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === suggest.active}
              onPointerDown={(e) => {
                // Keep focus (and the edit) in the title.
                e.preventDefault();
                acceptSuggestion(option);
              }}
              onKeyDown={() => undefined}
              className={cn(
                'flex h-control cursor-default items-center gap-2 rounded-sm px-2 text-sm text-text',
                index === suggest.active && 'bg-bg-muted',
              )}
            >
              {option.tag ? <TagDot color={option.tag.color} /> : <span className="size-2" />}
              <span className="min-w-0 flex-1 truncate">
                {option.kind === 'create' ? t('tags.create', { name: option.name }) : option.name}
              </span>
            </div>
          ))}
        </div>
      )}
      <input
        ref={input}
        data-list-input
        aria-label={label}
        defaultValue={initialValue}
        maxLength={TASK_TITLE_MAX}
        placeholder={t('row.placeholder')}
        autoComplete="off"
        spellCheck
        onKeyDown={onKeyDown}
        onKeyUp={(event) => {
          if (event.key === 'Backspace') backspaceLatch = false;
          if (
            event.key === 'ArrowLeft' ||
            event.key === 'ArrowRight' ||
            event.key === 'Home' ||
            event.key === 'End'
          )
            updateSuggest();
        }}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open !== null}
        aria-controls={open?.id}
        aria-activedescendant={open ? `${open.id}-${open.active}` : undefined}
        onInput={onInput}
        onPaste={onPaste}
        onClick={onClick}
        onBlur={onBlur}
        onScroll={syncScroll}
        onSelect={syncScroll}
        className="relative min-w-0 flex-1 bg-transparent p-0 text-inherit outline-none placeholder:text-text-muted"
      />
      {colonChip === 'shown' && (
        <span className="ms-2 inline-flex h-chip shrink-0 items-center rounded-xs bg-bg-accent-subtle px-1.5 text-xs font-medium text-text-secondary">
          {t('row.colonChip', { name: value().trim().slice(0, -1) })}
        </span>
      )}
      {pasteLines && (
        <span className="ms-2 inline-flex h-chip shrink-0 items-center rounded-xs bg-bg-accent-subtle px-1.5 text-xs font-medium text-text-secondary">
          {t('row.pasteChip', { count: pasteLines.length })}
        </span>
      )}
    </div>
  );
}
