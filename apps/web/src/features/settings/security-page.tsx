import { Monitor, Smartphone, Tablet } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { UserSession } from '../../data/types';
import { type DisplayPrefs, formatTimeAgo } from '../../lib/format';
import { Button, iconStrokeWidth } from '../../ui/button';
import { Chip } from '../../ui/chip';
import { SettingsSection } from './settings-section';
import { describeUserAgent } from './user-agent';

export interface SecurityPageProps {
  sessions: readonly UserSession[];
  onRevoke: (sessionId: string) => void;
  /** The session being revoked (spinner on its button). */
  pendingSessionId?: string | null | undefined;
  prefs: Pick<DisplayPrefs, 'locale'>;
  now: number;
  /** Settings → Connected apps (11 §3.2), below the sessions. */
  connectedApps?: ReactNode;
}

const deviceIcons = { desktop: Monitor, mobile: Smartphone, tablet: Tablet } as const;

/**
 * FR-AUTH-4 / FR-SET-3: active sessions (revoking signs that browser out on its next request),
 * then Connected apps.
 */
export function SecurityPage({
  sessions,
  onRevoke,
  pendingSessionId,
  prefs,
  now,
  connectedApps,
}: SecurityPageProps) {
  const { t } = useTranslation('settings');
  const ordered = [...sessions].sort(
    (a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.lastActiveAt - a.lastActiveAt,
  );
  return (
    <div className="flex flex-col gap-12">
      <SettingsSection title={t('security.sessionsTitle')} description={t('security.sessionsBody')}>
        <ul className="flex flex-col">
          {ordered.map((session) => {
            const device = describeUserAgent(session.userAgent);
            const Icon = deviceIcons[device.kind];
            const name =
              device.browser && device.os
                ? t('security.browserOnOs', { browser: device.browser, os: device.os })
                : (device.browser ?? device.os ?? t('security.unknownDevice'));
            const lastActive = session.isCurrent
              ? t('security.activeNow')
              : t('security.lastActive', {
                  when: formatTimeAgo(
                    session.lastActiveAt,
                    now,
                    prefs.locale,
                    t('security.justNow'),
                  ),
                });
            return (
              <li
                key={session.id}
                className="flex items-center gap-3 border-b border-border py-3 last:border-b-0"
              >
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-muted text-text-secondary">
                  <Icon className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">{name}</span>
                    {session.isCurrent && <Chip color="green">{t('security.thisDevice')}</Chip>}
                  </span>
                  <span className="truncate text-sm text-text-muted">
                    {[session.ipAddress, lastActive].filter(Boolean).join(' · ')}
                  </span>
                </div>
                {!session.isCurrent && (
                  <Button
                    variant="ghost"
                    size="sm"
                    isLoading={pendingSessionId === session.id}
                    onPress={() => onRevoke(session.id)}
                    aria-label={t('security.revokeNamed', { name })}
                  >
                    {t('security.revoke')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </SettingsSection>
      {connectedApps}
    </div>
  );
}
