import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDisplayPrefs, useRevokeSession, useSessions } from '../../data';
import { SecurityPage } from '../../features/settings/security-page';
import { toast } from '../../ui/toast';

export const Route = createFileRoute('/_app/settings/security')({
  component: SecurityRoute,
});

function SecurityRoute() {
  const { t } = useTranslation('settings');
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const prefs = useDisplayPrefs();
  const [pending, setPending] = useState<string | null>(null);
  return (
    <SecurityPage
      sessions={sessions.data ?? []}
      prefs={prefs}
      now={Date.now()}
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
    />
  );
}
