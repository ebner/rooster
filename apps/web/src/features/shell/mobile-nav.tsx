import { Bell, ListChecks, Search, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BottomNav, type BottomNavItem } from '../../ui/bottom-nav';
import { useInboxNav } from '../collab/inbox-nav';
import { openPalette, usePaletteStore } from '../palette/store';
import { paths } from './paths';

export type MobileNavTab = 'my' | 'search' | 'inbox' | 'settings';

export interface MobileNavProps {
  /** My tasks of the current (or first) org. */
  myTasksHref: string | null;
  active: MobileNavTab | null;
}

/**
 * The phone's bottom nav (02 §13.1, FR-PWA-5): My tasks · Search · Inbox · Settings. Search
 * opens the palette as a full-screen sheet, in search mode; Inbox carries the unread badge.
 */
export function MobileNav({ myTasksHref, active }: MobileNavProps) {
  const { t } = useTranslation('mobile');
  const searching = usePaletteStore((s) => s.open);
  const inbox = useInboxNav();
  const current = inbox.active ? 'inbox' : active;
  const items: BottomNavItem[] = [
    {
      id: 'my',
      label: t('nav.myTasks'),
      icon: ListChecks,
      href: myTasksHref ?? undefined,
      isDisabled: myTasksHref === null,
      isActive: current === 'my' && !searching,
    },
    {
      id: 'search',
      label: t('nav.search'),
      icon: Search,
      onPress: () => openPalette({ mode: 'search' }),
      isActive: current === 'search' || searching,
    },
    {
      id: 'inbox',
      label: t('nav.inbox'),
      icon: Bell,
      href: paths.inbox,
      isActive: current === 'inbox' && !searching,
      badge: inbox.unread,
      badgeLabel: inbox.unread ? t('nav.unread', { count: inbox.unread }) : undefined,
    },
    {
      id: 'settings',
      label: t('nav.settings'),
      icon: Settings,
      href: '/settings',
      isActive: current === 'settings' && !searching,
    },
  ];
  return <BottomNav label={t('nav.label')} items={items} />;
}
