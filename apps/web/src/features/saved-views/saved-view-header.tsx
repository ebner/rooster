import { isProjectView } from '@rooster/core/saved-views';
import type { Tag } from '@rooster/core/schemas';
import { Archive, ListChecks, MoreHorizontal, Printer, Trash2 } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { MenuSection } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import type { Org, OrgMember } from '../../data/types';
import { primaryKeys } from '../../keymap';
import { cn } from '../../lib/cn';
import { persistShowCompleted, useListStore } from '../../state/list-store';
import { Button } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { Menu, MenuItem, MenuPopover, MenuSeparator, MenuTrigger } from '../../ui/menu';
import { announce } from '../list/announcer';
import { printList, ShowCompletedToggle } from '../list/header-actions';
import { SyncStatus } from '../pwa/sync-status';
import { subscribeNameFocus, takeNameFocus } from './name-focus';
import { viewNameMax } from './query';
import { QueryChips } from './query-chips';
import type { ViewEditor } from './use-view-editor';

export interface ViewNameInputProps {
  name: string;
  /** Commits a non-empty, changed name. */
  onCommit: (name: string) => void;
  autoFocus?: boolean;
  /** A new view: Enter on the same name tries the create again (it failed, or was offline). */
  retry?: boolean;
  className?: string;
}

/**
 * The view's name, editable in place (B7: no dialog): Enter or blur saves, Esc restores. An
 * empty name is never saved; a new view is created by its first name.
 */
export function ViewNameInput({
  name,
  onCommit,
  autoFocus = false,
  retry = false,
  className,
}: ViewNameInputProps) {
  const { t } = useTranslation('views');
  const [value, setValue] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  const editing = useRef(false);
  const skipBlur = useRef(false);
  useEffect(() => {
    if (!editing.current) setValue(name);
  }, [name]);
  useEffect(() => {
    const focus = () => {
      if (!ref.current || !takeNameFocus()) return;
      ref.current.focus();
      ref.current.select();
    };
    focus();
    return subscribeNameFocus(focus);
  }, []);
  /** `explicit`: Enter. Only that retries a failed create with the same name, never a blur. */
  const commit = (explicit: boolean) => {
    editing.current = false;
    const next = value.trim();
    if (next === '' || (next === name && !(retry && explicit))) setValue(name);
    else onCommit(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit(true);
      // The blur that follows commits nothing more (the name is the committed one now).
      editing.current = false;
      skipBlur.current = true;
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      editing.current = false;
      setValue(name);
      requestAnimationFrame(() => ref.current?.blur());
    }
  };
  return (
    <input
      ref={ref}
      // biome-ignore lint/a11y/noAutofocus: "+ New view" opens to type its name (B7).
      autoFocus={autoFocus}
      data-testid="view-name"
      aria-label={t('saved.name.label')}
      placeholder={t('saved.name.placeholder')}
      maxLength={viewNameMax}
      value={value}
      onChange={(e) => {
        editing.current = true;
        setValue(e.target.value);
      }}
      onBlur={() => {
        if (skipBlur.current) skipBlur.current = false;
        else commit(false);
      }}
      onKeyDown={onKeyDown}
      className={cn(
        'min-w-0 flex-1 truncate rounded-xs bg-transparent px-1 -ms-1 text-lg text-text outline-none',
        'placeholder:font-normal placeholder:text-text-muted hover:bg-bg-subtle',
        'focus-visible:bg-bg-subtle focus-visible:outline-2 focus-visible:outline-border-focus',
        className,
      )}
    />
  );
}

/** "7 open · 12 done" (B3); screen readers hear whole words. */
export function ViewCounts({ counts }: { counts: { open: number; done: number } }) {
  const { t } = useTranslation('views');
  return (
    <span data-testid="view-counts" className="shrink-0 text-sm font-normal text-text-muted">
      <span aria-hidden className="tabular-nums">
        {t('saved.counts', counts)}
      </span>
      <span className="sr-only">{t('saved.countsLabel', counts)}</span>
    </span>
  );
}

/** Whether the header shows the open/done counts: a project view (exactly one tag). */
export function showsCounts(query: { tags: string[] }): boolean {
  return isProjectView(query);
}

export interface ViewMenuItemsProps {
  editor: ViewEditor;
  onDelete: () => void;
  /** Phones: no shortcut hints. */
  mobile?: boolean;
}

/** The view's ⋯ items: Show completed, Print, then Archive and Delete (B10, 02 §10.2). */
export function ViewMenuItems({ editor, onDelete, mobile = false }: ViewMenuItemsProps) {
  const { t } = useTranslation('views');
  const { t: tList } = useTranslation('list');
  const showCompleted = useListStore((s) => s.showCompleted);
  const keys = (id: Parameters<typeof primaryKeys>[0]) =>
    mobile || primaryKeys(id) === '' ? {} : { shortcut: primaryKeys(id) };
  return (
    <>
      <MenuSection
        selectionMode="multiple"
        shouldCloseOnSelect
        selectedKeys={showCompleted ? ['showCompleted'] : []}
        onSelectionChange={(selected) => {
          const next = selected === 'all' || selected.has('showCompleted');
          useListStore.getState().set({ showCompleted: next });
          persistShowCompleted(next);
          announce(tList(next ? 'header.completedShown' : 'header.completedHidden'));
        }}
        className="flex flex-col"
      >
        <MenuItem
          id="showCompleted"
          icon={ListChecks}
          data-testid="view-menu-showCompleted"
          {...keys('toggleCompleted')}
        >
          {tList('header.showCompleted')}
        </MenuItem>
      </MenuSection>
      <MenuItem
        id="print"
        icon={Printer}
        data-testid="view-menu-print"
        onAction={printList}
        {...keys('printList')}
      >
        {tList('header.print')}
      </MenuItem>
      {!editor.isNew && (
        <>
          <MenuSeparator />
          <MenuItem
            id="archive"
            icon={Archive}
            data-testid="view-menu-archive"
            onAction={editor.archive}
          >
            {t('saved.menu.archive')}
          </MenuItem>
          <MenuItem
            id="delete"
            icon={Trash2}
            tone="danger"
            data-testid="view-menu-delete"
            onAction={onDelete}
          >
            {t('saved.menu.delete')}
          </MenuItem>
        </>
      )}
    </>
  );
}

/** "Delete “Juniper”? Its tasks and tags stay." inline, under the header (no modal, 02 §1). */
export function DeleteViewConfirm({
  name,
  onConfirm,
  onCancel,
}: {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('views');
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => confirm.current?.focus(), []);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would imply a form; this is an inline question.
    <div
      role="group"
      aria-label={t('saved.confirmDelete.text', { name })}
      data-testid="view-delete-confirm"
      className="flex flex-wrap items-center gap-2 rounded-sm border border-border bg-bg-subtle px-3 py-2 text-sm"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <span className="min-w-0 flex-1 text-text">{t('saved.confirmDelete.text', { name })}</span>
      <Button ref={confirm} variant="danger" size="sm" onPress={onConfirm}>
        {t('saved.confirmDelete.confirm')}
      </Button>
      <Button variant="ghost" size="sm" onPress={onCancel}>
        {t('saved.confirmDelete.cancel')}
      </Button>
    </div>
  );
}

export interface SavedViewHeaderProps {
  org: Org;
  userId: string;
  editor: ViewEditor;
  tags: readonly Tag[];
  members: readonly OrgMember[];
  /** "7 open · 12 done" for a project view (`ViewCounts`); null otherwise. */
  counts: ReactNode;
  confirmingDelete: boolean;
  setConfirmingDelete: (on: boolean) => void;
}

/**
 * A view's header on tablets and desktops (B7, 02 §10.2): the name, editable in place, with
 * the org and a project view's counts, then the query as chips, Private/Shared, and the B13
 * note on shared views. The first line sticks like every list header; the chips scroll.
 */
export function SavedViewHeader({
  org,
  userId,
  editor,
  tags,
  members,
  counts,
  confirmingDelete,
  setConfirmingDelete,
}: SavedViewHeaderProps) {
  const { t } = useTranslation('views');
  const { draft } = editor;
  return (
    <>
      <header className="sticky top-0 z-(--z-sticky) bg-bg-app">
        <div className="mx-auto flex h-sheet-header w-full max-w-list-max items-center gap-2 px-3 tablet:px-6 desktop:px-8">
          <h1 className="flex min-w-0 flex-1 items-baseline gap-2 text-lg">
            <ViewNameInput
              name={draft.name}
              onCommit={editor.setName}
              autoFocus={editor.isNew}
              retry={editor.isNew}
              className="max-w-fit field-sizing-content"
            />
            <span className="shrink-0 truncate text-sm font-normal tracking-normal text-text-muted">
              {org.name}
            </span>
            {counts}
          </h1>
          <SyncStatus className="max-tablet:hidden" />
          <ShowCompletedToggle />
          <MenuTrigger>
            <IconButton
              icon={MoreHorizontal}
              size="sm"
              aria-label={t('saved.menu.label')}
              data-testid="view-menu"
            />
            <MenuPopover placement="bottom end">
              <Menu aria-label={t('saved.menu.label')}>
                <ViewMenuItems editor={editor} onDelete={() => setConfirmingDelete(true)} />
              </Menu>
            </MenuPopover>
          </MenuTrigger>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-list-max flex-col gap-2 px-3 pt-1 pb-2 tablet:px-6 desktop:px-8">
        <QueryChips
          query={draft.query}
          shared={draft.shared}
          isPersonal={org.isPersonal}
          tags={tags}
          members={members}
          meId={userId}
          onQuery={editor.setQuery}
          onShared={editor.setShared}
          canUnshare={editor.canUnshare}
          onCreateTag={editor.createTag}
        />
        {draft.shared && !org.isPersonal && (
          <p data-testid="view-shared-note" className="text-xs text-text-muted">
            {t('saved.sharedNote', { org: org.name })}
          </p>
        )}
        {confirmingDelete && (
          <DeleteViewConfirm
            name={draft.name}
            onConfirm={() => {
              setConfirmingDelete(false);
              editor.remove();
            }}
            onCancel={() => setConfirmingDelete(false)}
          />
        )}
      </div>
    </>
  );
}
