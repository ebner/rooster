import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDisplayPrefs, useRevokeSession, useSessions } from '../../data';
import {
  useCreateToken,
  useGrantOrgs,
  useGrants,
  useRevokeGrant,
  useUpdateGrant,
} from '../../data/grants';
import { ConnectedAppsSection } from '../../features/access/connected-apps';
import { SecurityPage } from '../../features/settings/security-page';
import { toast } from '../../ui/toast';

/**
 * Settings → Security (FR-SET-3): signed-in devices, then Connected apps
 * (`/settings/security#connected-apps`, 11 §3.2). Online-only.
 */
export const Route = createFileRoute('/_app/settings/security')({
  component: SecurityRoute,
});

function SecurityRoute() {
  const { t } = useTranslation('settings');
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const prefs = useDisplayPrefs();
  const [pending, setPending] = useState<string | null>(null);
  const now = Date.now();
  return (
    <SecurityPage
      sessions={sessions.data ?? []}
      prefs={prefs}
      now={now}
      pendingSessionId={pending}
      onRevoke={async (sessionId) => {
        setPending(sessionId);
        try {
          await revoke.mutateAsync({ sessionId });
          toast({ message: t('security.revoked') });
        } catch {
          toast({ message: t('error.saveFailed'), tone: 'danger' });
        } finally {
          setPending(null);
        }
      }}
      connectedApps={<ConnectedApps now={now} />}
    />
  );
}

function ConnectedApps({ now }: { now: number }) {
  const { t } = useTranslation('settings');
  const prefs = useDisplayPrefs();
  const grants = useGrants();
  const orgs = useGrantOrgs();
  const createToken = useCreateToken();
  const updateGrant = useUpdateGrant();
  const revokeGrant = useRevokeGrant();
  const failed = (message: string) => (error: unknown) => {
    toast({ message, tone: 'danger' });
    throw error;
  };
  return (
    <ConnectedAppsSection
      grants={grants.data}
      error={grants.error}
      orgs={orgs}
      prefs={prefs}
      now={now}
      onCreateToken={(input) =>
        createToken.mutateAsync(input).catch(failed(t('access.apps.createFailed')))
      }
      onUpdate={(id, patch) =>
        updateGrant
          .mutateAsync({ id, patch })
          .then(() => {
            toast({ message: t('access.apps.saved'), durationMs: 2500 });
          })
          .catch(failed(t('error.saveFailed')))
      }
      onRevoke={(id) =>
        revokeGrant
          .mutateAsync({ id })
          .then(() => {
            toast({ message: t('access.apps.revoked') });
          })
          .catch(failed(t('error.saveFailed')))
      }
    />
  );
}
