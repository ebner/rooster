import { isLocale, type Locale, supportedLocales } from '@rooster/i18n';
import { ChevronsUpDown, Languages, LogOut, Settings, ShieldCheck } from 'lucide-react';
import { Button as AriaButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import type { CurrentUser } from '../../data/types';
import { cn } from '../../lib/cn';
import { Avatar } from '../../ui/avatar';
import { iconStrokeWidth } from '../../ui/button';
import {
  Menu,
  MenuItem,
  MenuPopover,
  MenuSeparator,
  MenuTrigger,
  SubmenuTrigger,
} from '../../ui/menu';
import { Tooltip } from '../../ui/tooltip';
import { paths } from './paths';
import { sidebarItemClass } from './sidebar-item';

export interface UserMenuProps {
  user: Pick<CurrentUser, 'id' | 'name' | 'email' | 'image' | 'isAdmin'>;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  onSignOut: () => void;
  rail?: boolean;
  /** Kitchen sink: render the menu open. */
  defaultOpen?: boolean;
}

/** The account menu at the bottom of the sidebar (02 §2): settings, language, admin, sign out. */
export function UserMenu({
  user,
  locale,
  onLocaleChange,
  onSignOut,
  rail = false,
  defaultOpen,
}: UserMenuProps) {
  const { t } = useTranslation('shell');
  const { t: tc } = useTranslation();
  const trigger = (
    <AriaButton
      aria-label={t('user.menu', { name: user.name })}
      className={cn(sidebarItemClass, 'h-control-lg gap-2', rail && 'justify-center px-0')}
    >
      <Avatar id={user.id} name={user.name} src={user.image ?? undefined} size={24} decorative />
      {!rail && (
        <>
          <span className="min-w-0 flex-1 truncate text-start font-medium text-text">
            {user.name}
          </span>
          <ChevronsUpDown
            className="size-4 shrink-0 text-text-secondary"
            strokeWidth={iconStrokeWidth}
            aria-hidden
          />
        </>
      )}
    </AriaButton>
  );
  return (
    <MenuTrigger {...(defaultOpen ? { defaultOpen } : {})}>
      {rail ? (
        <Tooltip content={user.name} placement="end">
          {trigger}
        </Tooltip>
      ) : (
        trigger
      )}
      <MenuPopover placement={rail ? 'end bottom' : 'top start'}>
        <Menu
          aria-label={t('user.menu', { name: user.name })}
          onAction={(key) => {
            if (key === 'signOut') onSignOut();
          }}
        >
          <MenuItem id="settings" icon={Settings} href={paths.settings('profile')}>
            {t('user.settings')}
          </MenuItem>
          <SubmenuTrigger>
            <MenuItem id="language" icon={Languages}>
              {tc('language.label')}
            </MenuItem>
            <MenuPopover placement="end top">
              <Menu
                aria-label={tc('language.label')}
                selectionMode="single"
                selectedKeys={[locale]}
                onSelectionChange={(keys) => {
                  if (keys === 'all') return;
                  const [next] = [...keys];
                  if (isLocale(next) && next !== locale) onLocaleChange(next);
                }}
              >
                {supportedLocales.map((l) => (
                  <MenuItem key={l} id={l} lang={l}>
                    {tc(`language.${l}`)}
                  </MenuItem>
                ))}
              </Menu>
            </MenuPopover>
          </SubmenuTrigger>
          {user.isAdmin && (
            <MenuItem id="admin" icon={ShieldCheck} href={paths.admin}>
              {t('user.admin')}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem id="signOut" icon={LogOut}>
            {t('user.signOut')}
          </MenuItem>
        </Menu>
      </MenuPopover>
    </MenuTrigger>
  );
}
