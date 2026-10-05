import { useTranslation } from 'react-i18next';
import type { AdminUser } from '../../data/types';
import { type DisplayPrefs, formatDay } from '../../lib/format';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { Chip } from '../../ui/chip';
import { SettingsSection } from '../settings/settings-section';

export interface UsersSectionProps {
  users: readonly AdminUser[];
  currentUserId: string;
  onSetDisabled: (userId: string, disabled: boolean) => void;
  prefs: DisplayPrefs;
  now: number;
}

/** FR-AUTH-8: list users and disable them (which revokes their sessions). */
export function UsersSection({
  users,
  currentUserId,
  onSetDisabled,
  prefs,
  now,
}: UsersSectionProps) {
  const { t } = useTranslation('admin');
  return (
    <SettingsSection
      title={t('users.title')}
      description={t('users.count', { count: users.length })}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-text-muted">
              <th scope="col" className="py-2 pe-3 text-start font-medium">
                {t('users.user')}
              </th>
              <th scope="col" className="hidden py-2 pe-3 text-start font-medium tablet:table-cell">
                {t('users.created')}
              </th>
              <th scope="col" className="py-2 pe-3 text-start font-medium">
                {t('users.status')}
              </th>
              <th scope="col" className="py-2 text-end font-medium">
                <span className="sr-only">{t('users.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const disabled = user.disabledAt !== null;
              const isSelf = user.id === currentUserId;
              return (
                <tr key={user.id} className="border-b border-border last:border-b-0">
                  <td className="py-3 pe-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar
                        id={user.id}
                        name={user.name}
                        src={user.image ?? undefined}
                        size={32}
                        decorative
                      />
                      <div className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium">{user.name}</span>
                          {user.isAdmin && <Chip color="purple">{t('users.admin')}</Chip>}
                        </span>
                        <span className="truncate text-text-muted">{user.email}</span>
                      </div>
                    </div>
                  </td>
                  <td className="hidden py-3 pe-3 text-text-secondary tabular-nums tablet:table-cell">
                    {formatDay(user.createdAt, prefs, now)}
                  </td>
                  <td className="py-3 pe-3">
                    <Chip color={disabled ? 'red' : 'green'}>
                      {disabled ? t('users.disabled') : t('users.active')}
                    </Chip>
                  </td>
                  <td className="py-3 text-end">
                    {!isSelf && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={
                          disabled
                            ? t('users.enableNamed', { name: user.name })
                            : t('users.disableNamed', { name: user.name })
                        }
                        onPress={() => onSetDisabled(user.id, !disabled)}
                      >
                        {disabled ? t('users.enable') : t('users.disable')}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SettingsSection>
  );
}
