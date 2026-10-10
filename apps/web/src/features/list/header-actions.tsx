import type { ExportFormat } from '@rooster/core/schemas';
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  ListChecks,
  MoreHorizontal,
  Plus,
  Printer,
} from 'lucide-react';
import { Fragment, useEffect } from 'react';
import { MenuSection, ToggleButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { exportUrl } from '../../data/export';
import { primaryKeys, type ShortcutId } from '../../keymap';
import { cn } from '../../lib/cn';
import { persistShowCompleted, useListStore } from '../../state/list-store';
import { useSyncStore } from '../../state/sync-store';
import { buttonVariants, iconStrokeWidth } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { Menu, MenuItem, MenuPopover, MenuSeparator, MenuTrigger } from '../../ui/menu';
import { Tooltip } from '../../ui/tooltip';
import { runShortcut, useKeymapHandlers } from '../../use-keymap';

function setShowCompleted(next: boolean): void {
  useListStore.getState().set({ showCompleted: next });
  persistShowCompleted(next);
}

/** The header's "Show completed" toggle (02 §3.6; also Shift+H). */
export function ShowCompletedToggle() {
  const { t } = useTranslation('list');
  const showCompleted = useListStore((s) => s.showCompleted);
  return (
    <Tooltip content={t('header.showCompleted')} shortcut={primaryKeys('toggleCompleted')}>
      <ToggleButton
        isSelected={showCompleted}
        onChange={setShowCompleted}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          'data-selected:bg-bg-muted data-selected:text-text',
        )}
      >
        <ListChecks className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
        <span className="max-tablet:sr-only">{t('header.showCompleted')}</span>
      </ToggleButton>
    </Tooltip>
  );
}

/**
 * Which list the header ⋯ menu belongs to: My tasks has groups; the smart views have
 * sections derived from dates (no groups to add or fold); Everyone's tasks lists open tasks
 * only (02 §11), so it has no "Show completed" either.
 */
export type ListMenuView = 'my' | 'smart' | 'everyone';

export type ListMenuItemId =
  | 'addGroup'
  | 'showCompleted'
  | 'collapseAll'
  | 'expandAll'
  | 'exportJson'
  | 'exportMarkdown'
  | 'print';

/** The ⋯ menu's items for a view, in menu order (02 §2). */
export function listMenuItemIds(view: ListMenuView): ListMenuItemId[] {
  const groups = view === 'my';
  const ids: ListMenuItemId[] = [];
  if (groups) ids.push('addGroup');
  if (view !== 'everyone') ids.push('showCompleted');
  if (groups) ids.push('collapseAll', 'expandAll');
  ids.push('exportJson', 'exportMarkdown', 'print');
  return ids;
}

/** Print the list (02 §2); `styles/print.css` lays it out. */
export function printList(): void {
  window.print();
}

/** A same-origin download: the export answers with `Content-Disposition: attachment`. */
function download(href: string): void {
  const link = document.createElement('a');
  link.href = href;
  link.download = '';
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * The tasks screen while it is mounted: prints lay out the list only (`data-print="list"` on
 * <html>, read by `styles/print.css`), and Mod+P prints it.
 */
export function useListPrint(): void {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.print = 'list';
    return () => {
      delete root.dataset.print;
    };
  }, []);
  useKeymapHandlers({ printList: () => printList() });
}

const commandOf: Partial<Record<ListMenuItemId, ShortcutId>> = {
  addGroup: 'addGroupAtEnd',
  collapseAll: 'collapseAllGroups',
  expandAll: 'expandAllGroups',
  print: 'printList',
};

const exportFormat: Partial<Record<ListMenuItemId, ExportFormat>> = {
  exportJson: 'json',
  exportMarkdown: 'markdown',
};

export interface ListMenuItemsProps {
  orgId: string;
  view: ListMenuView;
  /** Phones: no shortcut hints. */
  mobile?: boolean;
}

/**
 * The list's ⋯ menu items (02 §2): Add group, Show completed, Collapse all, Expand all,
 * Export and Print. The desktop header and the phone header's ⋯ (02 §13.1) both render them;
 * list commands run through the keymap registry, so the menu, the keys and the palette share
 * one implementation (04 §5.3).
 */
export function ListMenuItems({ orgId, view, mobile = false }: ListMenuItemsProps) {
  const { t } = useTranslation('list');
  const { t: ts } = useTranslation('settings');
  const showCompleted = useListStore((s) => s.showCompleted);
  const online = useSyncStore((s) => s.online);
  const ids = listMenuItemIds(view);
  const shortcut = (id: ShortcutId) => {
    const keys = primaryKeys(id);
    return mobile || keys === '' ? {} : { shortcut: keys };
  };
  const icons = {
    addGroup: Plus,
    collapseAll: ChevronsDownUp,
    expandAll: ChevronsUpDown,
    exportJson: Download,
    exportMarkdown: Download,
    print: Printer,
  } as const;
  const labels = {
    addGroup: t('group.add'),
    collapseAll: t('header.collapseAll'),
    expandAll: t('header.expandAll'),
    exportJson: ts('data.format.json'),
    exportMarkdown: ts('data.format.markdown'),
    print: t('header.print'),
  } as const;

  return (
    <>
      {ids.map((id, index) => {
        const separator =
          (id === 'exportJson' || id === 'print') && index > 0 ? (
            <MenuSeparator key={`sep-${id}`} />
          ) : null;
        if (id === 'showCompleted') {
          // A checkable item: screen readers hear "Show completed, checked".
          return (
            <MenuSection
              key={id}
              selectionMode="multiple"
              shouldCloseOnSelect
              selectedKeys={showCompleted ? [id] : []}
              onSelectionChange={(keys) => {
                setShowCompleted(keys === 'all' || keys.has(id));
              }}
              className="flex flex-col"
            >
              <MenuItem
                id={id}
                icon={ListChecks}
                data-testid="list-menu-showCompleted"
                {...shortcut('toggleCompleted')}
              >
                {t('header.showCompleted')}
              </MenuItem>
            </MenuSection>
          );
        }
        const format = exportFormat[id];
        const command = commandOf[id];
        return (
          <Fragment key={id}>
            {separator}
            <MenuItem
              id={id}
              icon={icons[id]}
              data-testid={`list-menu-${id}`}
              {...(format ? { isDisabled: !online } : {})}
              {...(command ? shortcut(command) : {})}
              onAction={() => {
                if (format) download(exportUrl(orgId, format));
                else if (id === 'print') printList();
                else if (command) runShortcut(command);
              }}
            >
              {labels[id]}
            </MenuItem>
          </Fragment>
        );
      })}
    </>
  );
}

/** The desktop and tablet header's ⋯ (02 §2). */
export function ListHeaderMenu({ orgId, view }: { orgId: string; view: ListMenuView }) {
  const { t } = useTranslation('list');
  return (
    <MenuTrigger>
      <IconButton
        icon={MoreHorizontal}
        size="sm"
        aria-label={t('header.menu')}
        data-testid="list-menu"
      />
      <MenuPopover placement="bottom end">
        <Menu aria-label={t('header.menu')}>
          <ListMenuItems orgId={orgId} view={view} />
        </Menu>
      </MenuPopover>
    </MenuTrigger>
  );
}
