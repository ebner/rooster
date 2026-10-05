import { ListChecks, Search, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BottomNav, type BottomNavItem } from '../../ui/bottom-nav';
import { openPalette, usePaletteStore } from '../palette/store';

export type MobileNavTab = 'my' | 'search' | 'settings';

export interface MobileNavProps {
  /** My tasks of the current (or first) org. */
  myTasksHref: string | null;
  active: MobileNavTab | null;
}

/**
 * The phone's bottom nav (02 §13.1, FR-PWA-5): My tasks · Search · Settings. Search opens the
 * palette as a full-screen sheet, in search mode; the Inbox tab is added in P6.
 */
export function MobileNav({ myTasksHref, active }: MobileNavProps) {
  const { t } = useTranslation('mobile');
  const searching = usePaletteStore((s) => s.open);
  const items: BottomNavItem[] = [
    {
      id: 'my',
      label: t('nav.myTasks'),
      icon: ListChecks,
      href: myTasksHref ?? undefined,
      isDisabled: myTasksHref === null,
      isActive: active === 'my' && !searching,
    },
    {
      id: 'search',
      label: t('nav.search'),
      icon: Search,
      onPress: () => openPalette({ mode: 'search' }),
      isActive: active === 'search' || searching,
    },
    {
      id: 'settings',
      label: t('nav.settings'),
      icon: Settings,
      href: '/settings',
      isActive: active === 'settings' && !searching,
    },
  ];
  return <BottomNav label={t('nav.label')} items={items} />;
}
