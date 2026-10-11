import type { LucideIcon } from 'lucide-react';
import { Bell, BookOpen, CalendarDays, Database, Hand, Shield, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
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
  { id: 'calendar', icon: CalendarDays },
  { id: 'security', icon: Shield },
  { id: 'data', icon: Database },
];

export interface SettingsLayoutProps {
  active: SectionId;
  children: ReactNode;
}

/**
 * Settings with a left sub-nav on tablet and up. Phones drill in from `SettingsIndex` instead
 * and show only the section, with "‹ Settings" in the header.
 */
export function SettingsLayout({ active, children }: SettingsLayoutProps) {
  const { t } = useTranslation('settings');
  const { t: th } = useTranslation('help');
  return (
    <div className="flex flex-col tablet:flex-row tablet:items-start tablet:gap-12">
      {/* Pinned below the header while the section scrolls, like the guide's page list. */}
      <nav
        aria-label={t('nav.label')}
        className="shrink-0 max-tablet:hidden tablet:sticky tablet:top-(--space-16) tablet:w-max"
      >
        <ul className="flex flex-col gap-1">
          {settingsSections.map((section) => (
            <li key={section.id}>
              <SidebarItem
                icon={section.icon}
                label={t(`nav.${section.id}`)}
                href={paths.settings(section.id)}
                isActive={section.id === active}
              />
            </li>
          ))}
        </ul>
        {/* The user guide (ADR 0052 §2), below the sections. */}
        <div className="mt-4 border-t border-border pt-4">
          <SidebarItem icon={BookOpen} label={th('open')} href={paths.help} />
        </div>
        {/*
         * Sizes the column to its longest label set like the active item (medium weight), in
         * whatever language: nothing truncates, and the content does not shift between sections.
         */}
        <span aria-hidden className="invisible block h-0 overflow-hidden">
          {settingsSections.map((section) => (
            <span key={section.id} className={cn(sidebarItemClass, sidebarItemActiveClass)}>
              <span className="size-5 shrink-0" />
              <span className="whitespace-nowrap">{t(`nav.${section.id}`)}</span>
            </span>
          ))}
          <span className={cn(sidebarItemClass, sidebarItemActiveClass)}>
            <span className="size-5 shrink-0" />
            <span className="whitespace-nowrap">{th('open')}</span>
          </span>
        </span>
      </nav>
      <div className="min-w-0 max-w-pane-max flex-1">{children}</div>
    </div>
  );
}
