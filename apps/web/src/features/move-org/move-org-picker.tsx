import type { Group, TaskMoveToOrgPreview } from '@rooster/core/schemas';
import { Check, ChevronLeft, Inbox, Layers } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Popover as AriaPopover, Dialog, type Placement } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { useMe } from '../../data/me';
import { useMoveTargetGroups, useMoveToOrgPreview } from '../../data/move-to-org';
import type { Org } from '../../data/types';
import { cn } from '../../lib/cn';
import { useSyncStore } from '../../state/sync-store';
import { Avatar } from '../../ui/avatar';
import { BottomSheet, SheetOption } from '../../ui/bottom-sheet';
import { Button, iconStrokeWidth } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { Kbd } from '../../ui/kbd';
import { overlayOffsetPx, popoverMotion, popoverSurface } from '../../ui/popover';
import { orgUrlSlug } from '../shell/paths';

/**
 * ADR 0072 §22: the "Move to organisation" picker. Step 1 lists the user's orgs (the current
 * one checked, not selectable), step 2 the chosen org's groups (digits 1–9, like Move to group),
 * and step 3 (only when the preview says `exposes`, §13) confirms inline what becomes visible.
 * A popover on desktop, a bottom sheet on phones; never a modal dialog of its own.
 */
export type MoveOrgStep =
  | { kind: 'orgs' }
  | { kind: 'groups'; org: Org }
  | { kind: 'confirm'; org: Org; groupId: string };

/** What the picker hands the caller: `ListController.moveToOrg` plus the pane's new URL. */
export interface MoveOrgTarget {
  orgId: string;
  orgName: string;
  orgSlug: string;
  groupId: string | null;
}

/**
 * `ready`: pick away. `loadingGroups`: step 2 waits for the groups. `checking`: a group was
 * picked and the preview is still on its way (the move waits for it). `offline` and `failed`:
 * the picker needs the preview (§21), so nothing can be picked.
 */
export type MoveOrgStatus = 'ready' | 'loadingGroups' | 'checking' | 'offline' | 'failed';

export interface MoveOrgViewProps {
  /** The user's orgs, in sidebar order. */
  orgs: readonly Org[];
  /** The tasks' org: checked, not selectable. */
  currentOrgId: string;
  step: MoveOrgStep;
  groups: readonly Group[] | undefined;
  preview: TaskMoveToOrgPreview | undefined;
  status: MoveOrgStatus;
  onPickOrg: (org: Org) => void;
  onPickGroup: (groupId: string) => void;
  onBack: () => void;
  onConfirm: () => void;
  /** Kitchen sink: static specimens don't take focus. */
  autoFocus?: boolean;
}

/** The step logic shared by the popover and the sheet, over the data layer's two queries. */
export function useMoveOrgFlow(
  ids: readonly string[],
  onMove: (target: MoveOrgTarget) => void,
): Omit<MoveOrgViewProps, 'orgs' | 'currentOrgId' | 'autoFocus'> {
  const [step, setStep] = useState<MoveOrgStep>({ kind: 'orgs' });
  /** A group picked before the preview arrived: the move goes ahead once it has. */
  const [waiting, setWaiting] = useState<string | null>(null);
  const org = step.kind === 'orgs' ? null : step.org;
  const groups = useMoveTargetGroups(org?.id ?? null);
  const preview = useMoveToOrgPreview(ids, org?.id ?? null);
  const online = useSyncStore((s) => s.online);
  const latest = useRef(onMove);
  latest.current = onMove;

  const decide = useCallback((target: Org, groupId: string, data: TaskMoveToOrgPreview) => {
    if (data.exposes) {
      setStep({ kind: 'confirm', org: target, groupId });
      return;
    }
    latest.current({
      orgId: target.id,
      orgName: target.name,
      orgSlug: orgUrlSlug(target),
      groupId,
    });
  }, []);

  useEffect(() => {
    if (waiting === null || !org || !preview.data) return;
    setWaiting(null);
    decide(org, waiting, preview.data);
  }, [waiting, org, preview.data, decide]);

  const status: MoveOrgStatus = !online
    ? 'offline'
    : org && preview.error
      ? 'failed'
      : waiting !== null
        ? 'checking'
        : step.kind === 'groups' && !groups.data
          ? groups.error
            ? 'failed'
            : 'loadingGroups'
          : 'ready';

  return {
    step,
    groups: groups.data,
    preview: preview.data,
    status,
    onPickOrg: (picked) => {
      setWaiting(null);
      setStep({ kind: 'groups', org: picked });
    },
    onPickGroup: (groupId) => {
      if (!org || status === 'offline' || status === 'failed') return;
      if (preview.data) decide(org, groupId, preview.data);
      else setWaiting(groupId);
    },
    onBack: () => {
      setWaiting(null);
      setStep((current) =>
        current.kind === 'confirm' ? { kind: 'groups', org: current.org } : { kind: 'orgs' },
      );
    },
    onConfirm: () => {
      if (step.kind !== 'confirm') return;
      latest.current({
        orgId: step.org.id,
        orgName: step.org.name,
        orgSlug: orgUrlSlug(step.org),
        groupId: step.groupId,
      });
    },
  };
}

/** The group a move lands in without a pick (ADR 0072 §6): the first normal group. */
export function defaultGroupId(groups: readonly Group[] | undefined): string | undefined {
  return (groups?.find((g) => g.kind === 'normal') ?? groups?.[0])?.id;
}

/** "3 comments and 2 files": what the move shares (§13). */
export function useExposedItems(preview: TaskMoveToOrgPreview | undefined): string {
  const { t, i18n } = useTranslation('list');
  if (!preview) return '';
  const parts = [
    ...(preview.comments > 0 ? [t('moveToOrg.comments', { count: preview.comments })] : []),
    ...(preview.attachments > 0 ? [t('moveToOrg.files', { count: preview.attachments })] : []),
  ];
  return new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(parts);
}

// ---------------------------------------------------------------------------------------------
// Desktop: one popover, its content swapped per step
// ---------------------------------------------------------------------------------------------

interface PickerItem {
  id: string;
  label: string;
  leading: ReactNode;
  disabled?: boolean;
  checked?: boolean;
}

function orgAvatar(org: Org) {
  return (
    <Avatar
      id={org.id}
      name={org.name}
      emoji={org.avatarEmoji}
      color={org.color}
      shape="square"
      size={20}
      decorative
    />
  );
}

function groupIcon(group: Group, size: 'sm' | 'lg') {
  const Icon = group.kind === 'inbox' ? Inbox : size === 'lg' ? Layers : null;
  const cls = size === 'lg' ? 'size-5' : 'size-4';
  return Icon ? (
    <Icon
      className={cn(cls, 'shrink-0 text-text-secondary')}
      strokeWidth={iconStrokeWidth}
      aria-hidden
    />
  ) : (
    <span className={cn(cls, 'shrink-0')} aria-hidden />
  );
}

/**
 * A filterable combobox over a listbox, as in Move to group: ↑/↓ and Enter, digits 1–9 while
 * the filter is empty, and Backspace in the empty filter steps back.
 */
function PickerList({
  id,
  items,
  label,
  filterLabel,
  placeholder,
  defaultId,
  disabled,
  autoFocus,
  onPick,
  onBack,
}: {
  id: string;
  items: readonly PickerItem[];
  label: string;
  filterLabel: string;
  placeholder: string;
  defaultId?: string | undefined;
  disabled: boolean;
  autoFocus: boolean;
  onPick: (id: string) => void;
  onBack?: (() => void) | undefined;
}) {
  const { t } = useTranslation('list');
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return q === '' ? items : items.filter((i) => i.label.toLocaleLowerCase().includes(q));
  }, [items, query]);
  const enabled = filtered.filter((i) => !i.disabled);
  const active =
    enabled.find((i) => i.id === activeId) ?? enabled.find((i) => i.id === defaultId) ?? enabled[0];

  const pick = (item: PickerItem | undefined) => {
    if (!item || item.disabled || disabled) return;
    onPick(item.id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (enabled.length === 0) return;
      const index = active ? enabled.indexOf(active) : -1;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveId(enabled[(index + step + enabled.length) % enabled.length]?.id ?? null);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(active);
    } else if (query === '' && /^[1-9]$/.test(event.key) && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      pick(filtered[Number(event.key) - 1]);
    } else if (event.key === 'Backspace' && query === '' && onBack) {
      event.preventDefault();
      onBack();
    }
  };

  return (
    <>
      <input
        // biome-ignore lint/a11y/noAutofocus: the popover's step opens on its filter, as Move to group
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded
        aria-controls={id}
        aria-activedescendant={active ? `${id}-${active.id}` : undefined}
        aria-label={filterLabel}
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveId(null);
        }}
        onKeyDown={onKeyDown}
        className="h-control rounded-sm bg-bg-subtle px-2 text-sm text-text outline-none placeholder:text-text-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-border-focus"
      />
      <div
        id={id}
        role="listbox"
        aria-label={label}
        aria-disabled={disabled || undefined}
        className="mt-1 flex max-h-80 flex-col overflow-y-auto"
      >
        {filtered.length === 0 && items.length > 0 && (
          <p className="px-2 py-1.5 text-sm text-text-muted">{t('moveToOrg.empty')}</p>
        )}
        {filtered.map((item, index) => {
          const off = item.disabled || disabled;
          return (
            <div
              key={item.id}
              id={`${id}-${item.id}`}
              role="option"
              tabIndex={-1}
              aria-selected={item === active}
              aria-disabled={off || undefined}
              data-option-id={item.id}
              onPointerMove={() => !off && setActiveId(item.id)}
              onClick={() => pick(item)}
              onKeyDown={() => undefined}
              className={cn(
                'flex h-control cursor-default items-center gap-2 rounded-sm px-2 text-sm text-text',
                item === active && !disabled && 'bg-bg-muted',
                off && 'text-text-muted',
              )}
            >
              {item.leading}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.checked ? (
                <Check
                  className="size-4 shrink-0 text-text-secondary"
                  strokeWidth={iconStrokeWidth}
                  aria-label={t('moveToOrg.current')}
                />
              ) : (
                query === '' && index < 9 && !off && <Kbd shortcut={String(index + 1)} />
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function StatusLine({ status, className }: { status: MoveOrgStatus; className?: string }) {
  const { t } = useTranslation('list');
  if (status === 'ready') return null;
  const alert = status === 'offline' || status === 'failed';
  const text =
    status === 'offline'
      ? t('moveToOrg.offline')
      : status === 'failed'
        ? t('moveToOrg.failed')
        : status === 'checking'
          ? t('moveToOrg.checking')
          : t('moveToOrg.loadingGroups');
  return (
    <p
      role={alert ? 'alert' : 'status'}
      aria-busy={!alert || undefined}
      data-testid="move-org-status"
      data-status={status}
      className={cn('px-2 py-1.5 text-sm text-text-secondary', className)}
    >
      {text}
    </p>
  );
}

/** Step 3 (§13): "3 comments and 2 files by other people will be visible to members of X". */
export function MoveOrgConfirm({
  org,
  preview,
  onBack,
  onConfirm,
  size = 'sm',
  autoFocus = true,
}: {
  org: Org;
  preview: TaskMoveToOrgPreview | undefined;
  onBack: () => void;
  onConfirm: () => void;
  size?: 'sm' | 'lg';
  autoFocus?: boolean;
}) {
  const { t } = useTranslation('list');
  const items = useExposedItems(preview);
  return (
    <section
      aria-labelledby="move-org-confirm-title"
      className="flex flex-col gap-3"
      data-testid="move-org-confirm"
    >
      <h3 id="move-org-confirm-title" className="text-sm font-semibold text-text">
        {t('moveToOrg.confirmTitle', { org: org.name })}
      </h3>
      <p className="text-sm text-text-secondary">
        {t('moveToOrg.exposes', { items, org: org.name })}
      </p>
      <div className="flex justify-end gap-2">
        <Button size={size} variant="ghost" onPress={onBack}>
          {t('moveToOrg.confirmBack')}
        </Button>
        <Button
          size={size}
          variant="primary"
          onPress={onConfirm}
          autoFocus={autoFocus}
          data-testid="move-org-confirm-move"
        >
          {t('moveToOrg.confirm')}
        </Button>
      </div>
    </section>
  );
}

function orgItems(orgs: readonly Org[], currentOrgId: string): PickerItem[] {
  return orgs.map((org) => ({
    id: org.id,
    label: org.name,
    leading: orgAvatar(org),
    disabled: org.id === currentOrgId,
    checked: org.id === currentOrgId,
  }));
}

/** The popover's content for one step (pure; the kitchen sink renders each step). */
export function MoveOrgPanel({
  orgs,
  currentOrgId,
  step,
  groups,
  preview,
  status,
  onPickOrg,
  onPickGroup,
  onBack,
  onConfirm,
  autoFocus = true,
}: MoveOrgViewProps) {
  const { t } = useTranslation('list');
  const blocked = status === 'offline' || status === 'failed';
  if (step.kind === 'confirm') {
    return (
      <div className="p-2">
        <MoveOrgConfirm
          org={step.org}
          preview={preview}
          onBack={onBack}
          onConfirm={onConfirm}
          autoFocus={autoFocus}
        />
      </div>
    );
  }
  if (step.kind === 'orgs') {
    return (
      <div className="flex flex-col" data-testid="move-org-orgs">
        <PickerList
          key="orgs"
          id="move-org-orgs"
          items={orgItems(orgs, currentOrgId)}
          label={t('moveToOrg.orgs')}
          filterLabel={t('moveToOrg.filterOrgs')}
          placeholder={t('moveToOrg.placeholderOrgs')}
          disabled={status === 'offline'}
          autoFocus={autoFocus}
          onPick={(id) => {
            const org = orgs.find((o) => o.id === id);
            if (org) onPickOrg(org);
          }}
        />
        <StatusLine status={status === 'offline' ? status : 'ready'} />
      </div>
    );
  }
  const items: PickerItem[] = (groups ?? []).map((g) => ({
    id: g.id,
    label: g.name,
    leading: groupIcon(g, 'sm'),
  }));
  return (
    <div className="flex flex-col" data-testid="move-org-groups">
      <div className="mb-1 flex items-center gap-1">
        <IconButton
          icon={ChevronLeft}
          size="sm"
          aria-label={t('moveToOrg.back')}
          onPress={onBack}
          data-testid="move-org-back"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">
          {t('moveToOrg.groups', { org: step.org.name })}
        </span>
      </div>
      <PickerList
        key={`groups:${step.org.id}`}
        id="move-org-groups"
        items={items}
        label={t('moveToOrg.groups', { org: step.org.name })}
        filterLabel={t('moveToOrg.filterGroups')}
        placeholder={t('moveToOrg.placeholderGroups', { org: step.org.name })}
        defaultId={defaultGroupId(groups)}
        disabled={blocked || status === 'checking'}
        autoFocus={autoFocus}
        onPick={onPickGroup}
        onBack={onBack}
      />
      <StatusLine status={status} />
    </div>
  );
}

export interface MoveOrgPopoverProps {
  anchor: Element;
  ids: readonly string[];
  /** The tasks' org. */
  sourceOrgId: string;
  placement?: Placement;
  onMove: (target: MoveOrgTarget) => void;
  onClose: () => void;
}

/** The desktop picker: anchored to the pane's ⋯, the bulk bar or the cursor row. */
export function MoveOrgPopover({
  anchor,
  ids,
  sourceOrgId,
  placement = 'bottom start',
  onMove,
  onClose,
}: MoveOrgPopoverProps) {
  const { t } = useTranslation('list');
  const orgs = useMe().data?.orgs ?? [];
  const triggerRef = useRef<Element>(anchor);
  triggerRef.current = anchor;
  const flow = useMoveOrgFlow(ids, (target) => {
    onClose();
    onMove(target);
  });
  return (
    <AriaPopover
      triggerRef={triggerRef}
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      placement={placement}
      offset={overlayOffsetPx}
      className={cn(popoverSurface, popoverMotion, 'w-date-popover bg-bg-elevated')}
    >
      <Dialog
        aria-label={t('moveToOrg.title')}
        className="flex flex-col outline-none"
        data-testid="move-org-popover"
      >
        <MoveOrgPanel orgs={orgs} currentOrgId={sourceOrgId} {...flow} />
      </Dialog>
    </AriaPopover>
  );
}

// ---------------------------------------------------------------------------------------------
// Phones: the same steps as 48 px sheet rows
// ---------------------------------------------------------------------------------------------

/** The sheet's content for one step (pure; the kitchen sink renders each step). */
export function MoveOrgSheetBody({
  orgs,
  currentOrgId,
  step,
  groups,
  preview,
  status,
  onPickOrg,
  onPickGroup,
  onBack,
  onConfirm,
  autoFocus = true,
}: MoveOrgViewProps) {
  const { t } = useTranslation('list');
  if (step.kind === 'confirm') {
    return (
      <div className="px-3 pt-1 pb-2">
        <MoveOrgConfirm
          org={step.org}
          preview={preview}
          onBack={onBack}
          onConfirm={onConfirm}
          size="lg"
          autoFocus={autoFocus}
        />
      </div>
    );
  }
  const blocked = status === 'offline' || status === 'failed';
  if (step.kind === 'orgs') {
    return (
      <div className="flex flex-col" data-testid="move-org-orgs">
        <StatusLine status={status === 'offline' ? status : 'ready'} className="px-3" />
        {orgs.map((org) => (
          <SheetOption
            key={org.id}
            leading={orgAvatar(org)}
            label={org.name}
            data-option-id={org.id}
            checked={org.id === currentOrgId}
            aria-pressed={org.id === currentOrgId}
            isDisabled={org.id === currentOrgId || status === 'offline'}
            onPress={() => onPickOrg(org)}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col" data-testid="move-org-groups">
      <SheetOption
        icon={ChevronLeft}
        label={t('moveToOrg.back')}
        onPress={onBack}
        data-testid="move-org-back"
      />
      <p className="px-3 pt-2 pb-1 text-sm font-semibold text-text-secondary">
        {t('moveToOrg.groups', { org: step.org.name })}
      </p>
      <StatusLine status={status} className="px-3" />
      {(groups ?? []).map((group) => (
        <SheetOption
          key={group.id}
          leading={groupIcon(group, 'lg')}
          label={group.name}
          data-option-id={group.id}
          isDisabled={blocked || status === 'checking'}
          onPress={() => onPickGroup(group.id)}
        />
      ))}
    </div>
  );
}

export interface MoveOrgSheetProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  ids: readonly string[];
  sourceOrgId: string;
  /** The task the sheet acts on (or "3 tasks"). */
  subject?: ReactNode;
  onMove: (target: MoveOrgTarget) => void;
}

/** The phone picker (02 §13.4): a bottom sheet over the task sheet or selection mode. */
export function MoveOrgSheet({
  isOpen,
  onOpenChange,
  ids,
  sourceOrgId,
  subject,
  onMove,
}: MoveOrgSheetProps) {
  const { t } = useTranslation('list');
  return (
    <BottomSheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('moveToOrg.title')}
      description={subject}
    >
      <SheetFlow
        ids={ids}
        sourceOrgId={sourceOrgId}
        onMove={(target) => {
          onOpenChange(false);
          onMove(target);
        }}
      />
    </BottomSheet>
  );
}

/** Mounted with the open sheet, so every open starts at the orgs. */
function SheetFlow({
  ids,
  sourceOrgId,
  onMove,
}: {
  ids: readonly string[];
  sourceOrgId: string;
  onMove: (target: MoveOrgTarget) => void;
}) {
  const orgs = useMe().data?.orgs ?? [];
  const flow = useMoveOrgFlow(ids, onMove);
  return (
    <div data-testid="move-org-sheet">
      <MoveOrgSheetBody orgs={orgs} currentOrgId={sourceOrgId} {...flow} />
    </div>
  );
}
