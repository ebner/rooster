import { ChevronLeft, MoreHorizontal, Plus } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link as AriaLink } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import type { CreateOrgInput, Org } from '../../data/types';
import { cn } from '../../lib/cn';
import { Avatar } from '../../ui/avatar';
import { BottomSheet, SheetOption } from '../../ui/bottom-sheet';
import { iconStrokeWidth } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { LogoMark } from '../../ui/logo';
import { Menu, MenuPopover, MenuTrigger } from '../../ui/menu';
import { SyncStatus } from '../pwa/sync-status';
import { CreateOrgForm } from './create-org-form';
import { type OrgSlide, OrgSwitcher } from './org-switcher';
import { nextColor } from './sidebar';

export interface ViewTab {
  id: string;
  label: string;
  href: string;
  isActive: boolean;
}

export interface MobileHeaderProps {
  /** The screen's heading (visually replaced by the org switcher on list screens). */
  title: string;
  /** Muted context after the title, e.g. the org name. */
  context?: string | undefined;
  /** Shows the org switcher on the left (02 §13.1); otherwise the title. */
  org?: Org | null | undefined;
  onOpenOrgs?: (() => void) | undefined;
  /** The user's orgs in sidebar order: a sideways swipe on the switcher moves between them. */
  orgs?: readonly Org[] | undefined;
  onSwitchOrg?: ((org: Org) => void) | undefined;
  /** Press-and-slide on the switcher (ADR 0063). */
  orgSlide?: OrgSlide | undefined;
  /** Icon actions before the ⋯ menu. */
  actions?: ReactNode;
  /** The ⋯ menu's items (`MenuItem`s). */
  menu?: ReactNode;
  /** The view switcher under the header; appended to as views arrive (P5, P6). */
  views?: readonly ViewTab[] | undefined;
  /** Kitchen sink: not sticky. */
  isStatic?: boolean;
  /** Kitchen sink: a fixed sync state instead of the live pill. */
  syncPill?: ReactNode;
  /**
   * A drilled-in screen (Settings → a section): "‹ {label}" back to `href` replaces the mark,
   * the title is centred, and it takes focus when the screen opens.
   */
  back?: { href: string; label: string } | undefined;
}

/**
 * The phone header (02 §13.1, 56 px + the safe area): the org switcher (avatar, name, ▾) on
 * the left, nothing in the centre, and the sync pill and ⋯ on the right; the view switcher
 * sticks underneath it.
 */
export function MobileHeader({
  title,
  context,
  org,
  onOpenOrgs,
  orgs,
  onSwitchOrg,
  orgSlide,
  actions,
  menu,
  views,
  isStatic = false,
  syncPill,
  back,
}: MobileHeaderProps) {
  const { t } = useTranslation('mobile');
  const heading = useRef<HTMLHeadingElement>(null);
  // Drilling in moves focus to the screen's title, as a page load would (02 §15).
  const backHref = back?.href;
  useEffect(() => {
    if (backHref && !isStatic) heading.current?.focus({ preventScroll: true });
  }, [backHref, isStatic, title]);
  const trailing = (
    <>
      {syncPill ?? <SyncStatus />}
      {actions}
      {menu && (
        <MenuTrigger>
          <IconButton icon={MoreHorizontal} aria-label={t('header.more')} size="lg" />
          <MenuPopover placement="bottom end" className="min-w-48">
            <Menu aria-label={t('header.more')}>{menu}</Menu>
          </MenuPopover>
        </MenuTrigger>
      )}
    </>
  );
  return (
    <header
      data-testid="mobile-header"
      className={cn('z-(--z-sticky) bg-bg-app pt-safe', !isStatic && 'sticky top-0')}
    >
      {back ? (
        // Equal-width sides keep the title centred on the screen.
        <div className="flex h-sheet-header items-center gap-1 ps-1 pe-1">
          <div className="flex min-w-0 flex-1 basis-0">
            <AriaLink
              href={back.href}
              aria-label={t('header.backTo', { title: back.label })}
              data-testid="header-back"
              className={cn(
                'flex h-hit-touch min-w-0 cursor-default items-center gap-0.5 rounded-sm pe-2 text-base text-text-secondary',
                'transition-colors duration-(--dur-fast) pressed:bg-bg-muted',
                'outline-none focus-ring:outline-2 focus-ring:outline-border-focus',
              )}
            >
              <ChevronLeft className="size-6 shrink-0" strokeWidth={iconStrokeWidth} aria-hidden />
              <span className="truncate">{back.label}</span>
            </AriaLink>
          </div>
          <h1 ref={heading} tabIndex={-1} className="min-w-0 truncate text-lg outline-none">
            {title}
          </h1>
          <div className="flex flex-1 basis-0 items-center justify-end gap-1">{trailing}</div>
        </div>
      ) : (
        <div className="flex h-sheet-header items-center gap-1 ps-2 pe-1">
          {/* 03 §2.10: the mark heads every phone screen; the title or org switcher names it. */}
          <LogoMark size={28} className="mx-1" />
          {org ? (
            <>
              <h1 className="sr-only">{context ? `${title} · ${context}` : title}</h1>
              <OrgSwitcher
                org={org}
                orgs={orgs ?? [org]}
                onOpen={onOpenOrgs}
                onSwitch={onSwitchOrg}
                slide={orgSlide}
              />
            </>
          ) : (
            <h1 className="min-w-0 truncate px-2 text-lg">{title}</h1>
          )}
          <span className="flex-1" />
          {trailing}
        </div>
      )}
      {views && views.length > 0 && <ViewSwitcher views={views} />}
    </header>
  );
}

/**
 * The view switcher (02 §13.1): a horizontally scrollable segmented control of the org's
 * views. P4 has My tasks; Today, 7 days, Overdue, No date (P5) and Everyone (P6) append.
 */
export function ViewSwitcher({ views }: { views: readonly ViewTab[] }) {
  const { t } = useTranslation('mobile');
  return (
    <nav aria-label={t('views.label')} className="flex h-view-switcher items-center px-3">
      <div className="-mx-1 flex max-w-full gap-1 overflow-x-auto px-1 [scrollbar-width:none]">
        {views.map((view) => (
          <AriaLink
            key={view.id}
            href={view.href}
            {...(view.isActive ? { 'aria-current': 'page' as const } : {})}
            className={cn(
              'relative inline-flex h-control shrink-0 cursor-default items-center rounded-full px-4 text-sm font-medium whitespace-nowrap',
              // 44 px touch target (02 §15) around the 32 px segment.
              'after:absolute after:inset-x-0 after:-inset-y-1.5',
              'transition-colors duration-(--dur-fast) ease-standard',
              'outline-offset-2 focus-ring:outline-2 focus-ring:outline-border-focus',
              view.isActive ? 'bg-bg-muted text-text' : 'text-text-secondary pressed:bg-bg-subtle',
            )}
          >
            {view.label}
          </AriaLink>
        ))}
      </div>
    </nav>
  );
}

export interface OrgSwitcherSheetProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  orgs: readonly Org[];
  activeOrgId?: string | undefined;
  /** Press-and-slide: the org under the finger (ADR 0063). */
  highlightedOrgId?: string | null | undefined;
  onSelect: (org: Org) => void;
  /** Resolve to close the sheet; throw to show the error in the form. */
  onCreateOrg: (input: CreateOrgInput) => Promise<void> | void;
  isStatic?: boolean;
  /** Kitchen sink: open on the create form. */
  defaultCreating?: boolean;
}

/** The header's org switcher (02 §13.1): the user's orgs in sidebar order, and "Create org". */
export function OrgSwitcherSheet({
  isOpen,
  onOpenChange,
  orgs,
  activeOrgId,
  highlightedOrgId,
  onSelect,
  onCreateOrg,
  isStatic = false,
  defaultCreating = false,
}: OrgSwitcherSheetProps) {
  const { t } = useTranslation('mobile');
  const { t: ts } = useTranslation('shell');
  const [creating, setCreating] = useState(defaultCreating);
  useEffect(() => {
    if (!isOpen) setCreating(defaultCreating);
  }, [isOpen, defaultCreating]);
  return (
    <BottomSheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('org.title')}
      isStatic={isStatic}
    >
      {creating ? (
        <div className="px-2 pb-2">
          <CreateOrgForm
            defaultColor={nextColor(orgs.length)}
            autoFocus={false}
            onCancel={() => setCreating(false)}
            onSubmit={async (input) => {
              await onCreateOrg(input);
              onOpenChange(false);
            }}
          />
        </div>
      ) : (
        <div className="flex flex-col" data-testid="org-sheet">
          {orgs.map((org) => (
            <SheetOption
              key={org.id}
              leading={
                <Avatar
                  id={org.id}
                  name={org.name}
                  emoji={org.avatarEmoji}
                  color={org.color}
                  shape="square"
                  size={24}
                  decorative
                />
              }
              label={org.name}
              data-org-option={org.id}
              className={cn(org.id === highlightedOrgId && 'bg-bg-muted')}
              checked={org.id === activeOrgId}
              aria-pressed={org.id === activeOrgId}
              onPress={() => {
                onSelect(org);
                onOpenChange(false);
              }}
            />
          ))}
          <SheetOption icon={Plus} label={ts('sidebar.newOrg')} onPress={() => setCreating(true)} />
        </div>
      )}
    </BottomSheet>
  );
}
