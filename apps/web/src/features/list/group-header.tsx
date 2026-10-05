import { GROUP_NAME_MAX } from '@rooster/core/schemas';
import { ChevronRight, Inbox, MoreHorizontal, Pencil, Plus, Rows3, Trash2 } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, memo, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { primaryKeys } from '../../keymap';
import { cn } from '../../lib/cn';
import { groupRowId, useListUi } from '../../state/list-store';
import { iconStrokeWidth } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { Menu, MenuItem, MenuPopover, MenuTrigger } from '../../ui/menu';
import { DropLine } from './drop-line';
import { GridCell, GridRow } from './grid';
import { GroupDeletePopover } from './group-delete-popover';
import { useListContext } from './list-context';
import type { GroupRow } from './model/rows';
import { placeCaret } from './title-input';

function GroupNameInput({ groupId, name }: { groupId: string; name: string }) {
  const { t } = useTranslation('list');
  const { controller } = useListContext();
  const editing = useListUi((s) => s.editing);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el || !editing) return;
    el.focus({ preventScroll: true });
    placeCaret(el, editing.caret);
  }, [editing?.seq]);

  const close = (commit: boolean) => {
    done.current = true;
    if (commit) controller.renameGroup(groupId, input.current?.value ?? '');
    controller.ui().navigate(groupRowId(groupId));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Escape') {
      // 02 §4: Esc cancels a rename.
      event.preventDefault();
      close(false);
    }
  };

  return (
    <input
      ref={input}
      data-list-input
      aria-label={t('group.nameLabel')}
      defaultValue={name}
      maxLength={GROUP_NAME_MAX}
      onKeyDown={onKeyDown}
      onBlur={() => {
        if (!done.current) {
          done.current = true;
          controller.renameGroup(groupId, input.current?.value ?? '');
          const store = controller.ui();
          if (store.editing?.rowId === groupRowId(groupId))
            store.set({ editing: null, mode: 'navigate' });
        }
      }}
      className="min-w-0 flex-1 bg-transparent p-0 text-group text-text outline-none"
    />
  );
}

export interface GroupHeaderProps {
  row: GroupRow;
}

/**
 * 03 §3.2: chevron · name · open count, with "+" and "⋯" on hover. Sticky while its group
 * is in view. The Inbox variant is tinted, has an icon and the triage hint, and cannot be
 * renamed, moved or deleted.
 */
export const GroupHeader = memo(function GroupHeader({ row }: GroupHeaderProps) {
  const { t } = useTranslation('list');
  const { controller } = useListContext();
  const { group, collapsed, count, first, id } = row;
  const inbox = group.kind === 'inbox';
  const selected = useListUi((s) => Boolean(s.selected[id]));
  const renaming = useListUi((s) => s.editing?.rowId === id);
  const dropInside = useListUi((s) => s.drop?.rowId === id && s.drop.edge === 'inside');
  const isSource = useListUi((s) => Boolean(s.dragging?.includes(id)));
  const deleteOpen = useListUi((s) => s.popover?.kind === 'groupDelete' && s.popover.rowId === id);
  const headerRef = useRef<HTMLDivElement | null>(null);

  const onRowClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest('button,input,[data-no-row-press]')) return;
    // A click on the name renames (02 §4); the Inbox name is not editable.
    if (target.closest('[data-focus-target]') && !inbox) controller.startRename(group.id);
    else controller.ui().select(id);
  };

  const canDelete = controller.canDeleteGroup(group.id);
  const nameText = group.name;

  return (
    <GridRow
      ref={headerRef}
      aria-level={1}
      aria-expanded={!collapsed}
      aria-selected={selected}
      data-row-id={id}
      data-testid="group-header"
      data-inbox={inbox || undefined}
      onClick={onRowClick}
      onFocus={(event) => {
        // Tabbing onto the title (or name) selects the row in Navigate.
        if (!(event.target as Element).matches('[data-focus-target]')) return;
        const store = controller.ui();
        if (store.cursor !== id && store.mode === 'navigate') store.select(id);
      }}
      className={cn(
        'sticky top-sheet-header z-(--z-sticky) shrink-0 bg-bg-app',
        !first && 'mt-6',
        isSource && 'opacity-40',
      )}
    >
      <GridCell
        className={cn(
          'group/header relative flex h-group items-center gap-1 ps-1 pe-1 max-tablet:h-group-mobile',
          inbox ? 'rounded-md bg-bg-inbox' : 'rounded-sm hover:bg-bg-subtle',
          selected && !inbox && 'bg-bg-selected hover:bg-bg-selected',
          dropInside &&
            'bg-bg-accent-subtle outline-1 -outline-offset-1 outline-drop-target-outline',
          'has-[[data-focus-target]:focus-visible]:outline-2 has-[[data-focus-target]:focus-visible]:-outline-offset-2 has-[[data-focus-target]:focus-visible]:outline-border-focus',
        )}
      >
        {selected && (
          <span
            aria-hidden
            className="absolute inset-y-1 start-0 w-0.5 rounded-full bg-selection-bar"
          />
        )}
        <DropLine rowId={id} />
        <IconButton
          icon={ChevronRight}
          size="sm"
          aria-label={t(collapsed ? 'group.expand' : 'group.collapse', { name: nameText })}
          onPress={(event) => controller.setCollapsed(group.id, !collapsed, event.altKey)}
          className={cn(
            'size-6 [&_svg]:transition-transform [&_svg]:duration-(--dur-fast)',
            !collapsed && '[&_svg]:rotate-90',
            inbox ? 'text-text-secondary hover:bg-transparent' : 'text-text-muted',
          )}
        />
        {inbox && (
          <Inbox
            className="size-4 shrink-0 text-text-secondary"
            strokeWidth={iconStrokeWidth}
            aria-hidden
          />
        )}
        <div className="flex min-w-0 flex-1 items-baseline gap-2 ps-1">
          {renaming ? (
            <GroupNameInput groupId={group.id} name={group.name} />
          ) : (
            <h2
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a header is a tab stop (02 §6).
              tabIndex={0}
              data-focus-target
              className={cn('min-w-0 truncate text-group outline-none', !inbox && 'cursor-text')}
            >
              {nameText}
            </h2>
          )}
          <span
            aria-hidden
            className={cn(
              'shrink-0 text-sm tabular-nums',
              inbox ? 'text-text-secondary' : 'text-text-muted',
            )}
          >
            {count}
          </span>
          <span className="sr-only">{t('group.count', { count })}</span>
          {inbox && (
            <span className="min-w-0 truncate text-sm text-text-secondary max-tablet:hidden">
              {t('group.inboxHint')}
            </span>
          )}
        </div>
        <div
          className={cn(
            'flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-(--dur-fast)',
            'group-hover/header:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100',
            deleteOpen && 'opacity-100',
          )}
        >
          <IconButton
            icon={Plus}
            size="sm"
            aria-label={t('group.addTaskTop', { name: nameText })}
            onPress={() => {
              if (collapsed) controller.setCollapsed(group.id, false);
              controller.newDraft(group.id, null);
            }}
          />
          {!inbox && (
            <MenuTrigger>
              <IconButton
                icon={MoreHorizontal}
                size="sm"
                aria-label={t('group.menu', { name: nameText })}
              />
              <MenuPopover placement="bottom end">
                <Menu aria-label={t('group.menu', { name: nameText })}>
                  <MenuItem
                    icon={Pencil}
                    shortcut={primaryKeys('renameGroup')}
                    onAction={() => controller.startRename(group.id)}
                  >
                    {t('group.rename')}
                  </MenuItem>
                  <MenuItem icon={Plus} onAction={() => controller.addGroupAfter(group.id)}>
                    {t('group.addBelow')}
                  </MenuItem>
                  <MenuItem icon={Rows3} onAction={() => controller.collapseOthers(group.id)}>
                    {t('group.collapseOthers')}
                  </MenuItem>
                  <MenuItem
                    icon={Trash2}
                    tone="danger"
                    isDisabled={!canDelete}
                    onAction={() => controller.requestDeleteGroup(group.id)}
                  >
                    {canDelete ? t('group.delete') : t('group.deleteLast')}
                  </MenuItem>
                </Menu>
              </MenuPopover>
            </MenuTrigger>
          )}
        </div>
      </GridCell>
      {deleteOpen && <GroupDeletePopover groupId={group.id} triggerRef={headerRef} />}
    </GridRow>
  );
});
