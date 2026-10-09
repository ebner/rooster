import type { FeedEntry } from '@rooster/core/activity';
import type { Activity, ActivityVia, Comment } from '@rooster/core/schemas';
import type { Locale } from '@rooster/i18n/core';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { type KeyboardEvent, memo, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { matchesShortcut } from '../../keymap';
import { cn } from '../../lib/cn';
import { formatTimeAgo } from '../../lib/format';
import { detectPlatform } from '../../lib/platform';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { Menu, MenuItem, MenuPopover, MenuTrigger } from '../../ui/menu';
import type { ViewerDateContext } from '../dates';
import { CommentBody } from './comment-body';
import { DueText } from './due-text';

export interface FeedPerson {
  name: string;
  image?: string | null | undefined;
}

export interface ActivityFeedProps {
  /** `groupActivity` output, oldest first. */
  entries: readonly FeedEntry[];
  viewerId: string;
  /** Org members by ID (former members fall back to "Someone"). */
  person: (userId: string) => FeedPerson | undefined;
  /** Comments with an op still in the outbox ("Sending…"). */
  pending: ReadonlySet<string>;
  now: number;
  locale: Locale;
  dateCtx: ViewerDateContext;
  onEdit: (comment: Comment, body: string) => void;
  onDelete: (comment: Comment) => void;
  /** Kitchen sink: open this comment's editor. */
  editingId?: string | undefined;
  'data-force'?: string;
}

/** Shown after the time for work that came from elsewhere than the web app. */
const viaShown = ['cli', 'tui', 'mcp', 'import'] as const;
type ShownVia = (typeof viaShown)[number];
const isShownVia = (via: ActivityVia): via is ShownVia =>
  (viaShown as readonly string[]).includes(via);

/**
 * The pane's feed (02 §9.2 item 8, FR-COL-3/5): comments and grouped activity lines in time
 * order, newest last. Own comments can be edited inline ("edited") and deleted.
 */
export const ActivityFeed = memo(function ActivityFeed({
  entries,
  viewerId,
  person,
  pending,
  now,
  locale,
  dateCtx,
  onEdit,
  onDelete,
  editingId,
  'data-force': force,
}: ActivityFeedProps) {
  return (
    <ol className="flex flex-col gap-3" data-testid="activity-feed">
      {entries.map((entry) =>
        entry.kind === 'comment' ? (
          <CommentItem
            key={entry.key}
            comment={entry.comment}
            own={entry.comment.authorId === viewerId}
            author={person(entry.comment.authorId)}
            viewerId={viewerId}
            person={person}
            pending={pending.has(entry.comment.id)}
            now={now}
            locale={locale}
            onEdit={onEdit}
            onDelete={onDelete}
            startEditing={editingId === entry.comment.id}
            force={force}
          />
        ) : (
          <ActivityLine
            key={entry.key}
            entry={entry}
            viewerId={viewerId}
            person={person}
            now={now}
            locale={locale}
            dateCtx={dateCtx}
          />
        ),
      )}
    </ol>
  );
});

interface CommentItemProps {
  comment: Comment;
  own: boolean;
  author: FeedPerson | undefined;
  viewerId: string;
  person: (userId: string) => FeedPerson | undefined;
  pending: boolean;
  now: number;
  locale: Locale;
  onEdit: (comment: Comment, body: string) => void;
  onDelete: (comment: Comment) => void;
  startEditing: boolean;
  force: string | undefined;
}

function CommentItem({
  comment,
  own,
  author,
  viewerId,
  person,
  pending,
  now,
  locale,
  onEdit,
  onDelete,
  startEditing,
  force,
}: CommentItemProps) {
  const { t } = useTranslation('collab');
  const [editing, setEditing] = useState(startEditing);
  const name = author?.name ?? t('someone');
  const ago = formatTimeAgo(comment.createdAt, now, locale, t('justNow'));
  return (
    <li
      className="group/comment flex gap-3"
      data-testid="comment"
      data-comment-id={comment.id}
      data-pending={pending || undefined}
    >
      <Avatar
        id={comment.authorId}
        name={name}
        src={author?.image ?? undefined}
        size={24}
        decorative
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-h-control-sm items-center gap-2">
          <p className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-sm">
            <span className="truncate font-semibold text-text">{name}</span>
            <time
              dateTime={new Date(comment.createdAt).toISOString()}
              className="text-xs text-text-muted"
            >
              {ago}
            </time>
            {comment.editedAt !== null && (
              <span className="text-xs text-text-muted" data-testid="comment-edited">
                {t('comment.edited')}
              </span>
            )}
            {pending && (
              <span className="text-xs text-text-muted" role="status">
                {t('comment.sending')}
              </span>
            )}
          </p>
          {own && !editing && (
            <MenuTrigger>
              <IconButton
                icon={MoreHorizontal}
                size="sm"
                aria-label={t('comment.actions')}
                className={cn(
                  'opacity-0 pointer-coarse:opacity-100',
                  'group-hover/comment:opacity-100 group-focus-within/comment:opacity-100',
                  force && 'opacity-100',
                )}
                data-testid="comment-menu"
              />
              <MenuPopover placement="bottom end">
                <Menu aria-label={t('comment.actions')}>
                  <MenuItem icon={Pencil} onAction={() => setEditing(true)}>
                    {t('comment.edit')}
                  </MenuItem>
                  <MenuItem icon={Trash2} tone="danger" onAction={() => onDelete(comment)}>
                    {t('comment.delete')}
                  </MenuItem>
                </Menu>
              </MenuPopover>
            </MenuTrigger>
          )}
        </div>
        {editing ? (
          <CommentEditor
            initial={comment.body}
            onCancel={() => setEditing(false)}
            onSave={(body) => {
              setEditing(false);
              if (body !== comment.body) onEdit(comment, body);
            }}
          />
        ) : (
          <CommentBody body={comment.body} viewerId={viewerId} nameOf={(id) => person(id)?.name} />
        )}
      </div>
    </li>
  );
}

/** Inline editing of an own comment: Ctrl/⌘+Enter saves, Esc cancels. */
function CommentEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('collab');
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initial);
  const empty = text.trim() === '';

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [text]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matchesShortcut(event, 'Mod+Enter', detectPlatform())) {
      event.preventDefault();
      event.stopPropagation();
      if (!empty) onSave(text.trim());
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="comment-editor">
      <textarea
        ref={field}
        value={text}
        rows={2}
        aria-label={t('comment.editLabel')}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className={cn(
          'block w-full resize-none rounded-sm border border-border bg-bg-elevated px-3 py-2 text-sm text-text',
          'outline-none focus-visible:border-border-focus focus-visible:outline-2 focus-visible:outline-border-focus',
        )}
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onPress={onCancel}>
          {t('comment.cancel')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          isDisabled={empty}
          onPress={() => onSave(text.trim())}
          data-testid="comment-save"
        >
          {t('comment.save')}
        </Button>
      </div>
    </div>
  );
}

interface ActivityLineProps {
  entry: Extract<FeedEntry, { kind: 'activity' }>;
  viewerId: string;
  person: (userId: string) => FeedPerson | undefined;
  now: number;
  locale: Locale;
  dateCtx: ViewerDateContext;
}

/** One (grouped) activity entry: "Anna renamed this task to “Q4 plan” · 5 minutes ago". */
function ActivityLine({ entry, viewerId, person, now, locale, dateCtx }: ActivityLineProps) {
  const { t } = useTranslation('collab');
  const last = entry.entries.at(-1) as Activity;
  const actor =
    entry.actorId === null
      ? t('activity.system')
      : entry.actorId === viewerId
        ? t('activity.you')
        : (person(entry.actorId)?.name ?? t('someone'));
  const ago = formatTimeAgo(last.createdAt, now, locale, t('justNow'));
  const via = isShownVia(last.via) ? t(`activity.via.${last.via}`) : null;
  return (
    <li className="flex gap-3 text-sm text-text-secondary" data-testid="activity-line">
      <span className="flex h-5 w-6 shrink-0 items-center justify-center" aria-hidden>
        <span className="size-1.5 rounded-full bg-border-strong" />
      </span>
      <p className="min-w-0 flex-1">
        <span className="font-medium text-text">{actor}</span>{' '}
        <ActivityText
          entry={entry}
          last={last}
          viewerId={viewerId}
          person={person}
          dateCtx={dateCtx}
          locale={locale}
        />
        <span className="text-xs text-text-muted">
          {' · '}
          {ago}
          {via && ` · ${via}`}
        </span>
      </p>
    </li>
  );
}

/** The predicate of an activity line, from the group's entries (FR-COL-5). */
function ActivityText({
  entry,
  last,
  viewerId,
  person,
  dateCtx,
  locale,
}: Omit<ActivityLineProps, 'now'> & { last: Activity }): ReactNode {
  const { t } = useTranslation('collab');
  const list = new Intl.ListFormat(locale, { type: 'conjunction' });
  switch (last.type) {
    case 'renamed':
      return (
        <>
          {t('activity.renamed')}{' '}
          <span className="text-text">{t('activity.quote', { text: last.data.to })}</span>
        </>
      );
    case 'due_changed':
      return last.data.to?.dueDate ? (
        <>
          {t('activity.due_changed')} <DueText due={last.data.to} ctx={dateCtx} />
        </>
      ) : (
        t('activity.due_removed')
      );
    case 'assigned': {
      const to = last.data.to;
      if (to === null) return <>{t('activity.unassigned')}</>;
      if (to === entry.actorId) return t('activity.tookIt');
      const name = to === viewerId ? t('activity.toYou') : (person(to)?.name ?? t('someone'));
      return (
        <>
          {t('activity.assigned')} <span className="font-medium text-text">{name}</span>
        </>
      );
    }
    case 'subtask_added': {
      const titles = entry.entries.flatMap((e) =>
        e.type === 'subtask_added' ? [t('activity.quote', { text: e.data.title })] : [],
      );
      return (
        <>{t('activity.subtask_added', { count: titles.length, titles: list.format(titles) })}</>
      );
    }
    case 'attachment_added': {
      const files = entry.entries.flatMap((e) =>
        e.type === 'attachment_added' ? [e.data.filename] : [],
      );
      return (
        <>{t('activity.attachment_added', { count: files.length, files: list.format(files) })}</>
      );
    }
    case 'moved_parent':
      return <>{last.data.to === null ? t('activity.moved_top') : t('activity.moved_under')}</>;
    case 'description_edited':
      return <>{t('activity.description_edited')}</>;
    case 'created':
    case 'completed':
    case 'reopened':
    case 'restored':
      return <>{t(`activity.${last.type}`)}</>;
  }
}
