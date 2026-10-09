import type { LucideIcon } from 'lucide-react';
import { Bell, Database, Hand, Shield, UserRound } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { paths, type SettingsSection as SectionId } from '../shell/paths';
import { SidebarItem, sidebarItemActiveClass, sidebarItemClass } from '../shell/sidebar-item';

interface SubNavEntry {
  id: SectionId;
  icon: LucideIcon;
}

/** Later phases append tags, import, tokens, … */
export const settingsSections: readonly SubNavEntry[] = [
  { id: 'profile', icon: UserRound },
  { id: 'behaviour', icon: Hand },
  { id: 'notifications', icon: Bell },
  { id: 'security', icon: Shield },
  { id: 'data', icon: Database },
];

export interface SettingsLayoutProps {
  active: SectionId;
  children: ReactNode;
}

/**
 * Settings with a left sub-nav on tablet and up; a horizontal strip on phones that scrolls
 * inside itself (like the view switcher), so the page never scrolls sideways.
 */
export function SettingsLayout({ active, children }: SettingsLayoutProps) {
  const { t } = useTranslation('settings');
  const strip = useRef<HTMLUListElement>(null);
  // Phones: a section past the strip's edge is scrolled into view, without moving the page.
  useLayoutEffect(() => {
    const list = strip.current;
    const item = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !item || list.scrollWidth <= list.clientWidth) return;
    const pad = Number.parseFloat(getComputedStyle(list).paddingInlineStart) || 0;
    const box = item.getBoundingClientRect();
    const start = box.left - list.getBoundingClientRect().left + list.scrollLeft - pad;
    const end = start + box.width + 2 * pad;
    if (start < list.scrollLeft) list.scrollLeft = start;
    else if (end > list.scrollLeft + list.clientWidth) list.scrollLeft = end - list.clientWidth;
  }, [active]);
  return (
    <div className="flex flex-col gap-8 tablet:flex-row tablet:gap-12">
      <nav aria-label={t('nav.label')} className="min-w-0 shrink-0 tablet:w-max">
        <ul
          ref={strip}
          className={cn(
            'flex gap-1 tablet:flex-col',
            // Edge to edge on phones, like a native scroller; the padding keeps the ends clear.
            'max-tablet:-mx-3 max-tablet:overflow-x-auto max-tablet:px-3 max-tablet:[scrollbar-width:none]',
          )}
        >
          {settingsSections.map((section) => (
            <li key={section.id} className="shrink-0">
              <SidebarItem
                icon={section.icon}
                label={t(`nav.${section.id}`)}
                href={paths.settings(section.id)}
                isActive={section.id === active}
              />
            </li>
          ))}
        </ul>
        {/*
         * Sizes the column to its longest label set like the active item (medium weight), in
         * whatever language: nothing truncates, and the content does not shift between sections.
         */}
        <span aria-hidden className="invisible hidden h-0 overflow-hidden tablet:block">
          {settingsSections.map((section) => (
            <span key={section.id} className={cn(sidebarItemClass, sidebarItemActiveClass)}>
              <span className="size-5 shrink-0" />
              <span className="whitespace-nowrap">{t(`nav.${section.id}`)}</span>
            </span>
          ))}
        </span>
      </nav>
      <div className="min-w-0 max-w-pane-max flex-1">{children}</div>
    </div>
  );
}
