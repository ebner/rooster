import type { LucideIcon } from 'lucide-react';
import { Database, Hand, Shield, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { paths, type SettingsSection as SectionId } from '../shell/paths';
import { SidebarItem } from '../shell/sidebar-item';

interface SubNavEntry {
  id: SectionId;
  icon: LucideIcon;
}

/** Later phases append notifications, tags, import, tokens, … */
export const settingsSections: readonly SubNavEntry[] = [
  { id: 'profile', icon: UserRound },
  { id: 'behaviour', icon: Hand },
  { id: 'security', icon: Shield },
  { id: 'data', icon: Database },
];

export interface SettingsLayoutProps {
  active: SectionId;
  children: ReactNode;
}

/** Settings with a left sub-nav on tablet and up; a horizontal strip on phones. */
export function SettingsLayout({ active, children }: SettingsLayoutProps) {
  const { t } = useTranslation('settings');
  return (
    <div className="flex flex-col gap-8 tablet:flex-row tablet:gap-12">
      <nav aria-label={t('nav.label')} className="shrink-0 tablet:w-label-col">
        <ul className="flex gap-1 tablet:flex-col">
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
      </nav>
      <div className="min-w-0 max-w-pane-max flex-1">{children}</div>
    </div>
  );
}
