import type { Grant } from '@rooster/core/schemas';
import { createFileRoute, useLocation } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, useDisplayPrefs, useMe, useRevokeSession, useSessions } from '../../data';
import {
  useConfirmedGrantOrgs,
  useCreateToken,
  useGrantOrgs,
  useGrants,
  useRevokeGrant,
  useUpdateGrant,
} from '../../data/grants';
import {
  useAllowIdentity,
  useLinkedIdentities,
  useRemovedIdentities,
  useUnlinkIdentity,
} from '../../data/identities';
import { ConnectedAppsSection } from '../../features/access/connected-apps';
import { LinkedIdentitiesSection } from '../../features/settings/linked-identities';
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
      linkedIdentities={<LinkedIdentities now={now} />}
      connectedApps={<ConnectedApps now={now} />}
    />
  );
}

function LinkedIdentities({ now }: { now: number }) {
  const { t } = useTranslation('settings');
  const prefs = useDisplayPrefs();
  const identities = useLinkedIdentities();
  const unlink = useUnlinkIdentity();
  const removed = useRemovedIdentities();
  const allow = useAllowIdentity();
  return (
    <LinkedIdentitiesSection
      identities={identities.data}
      error={identities.error}
      removed={removed.data}
      removedError={removed.error}
      onAllow={async (id) => {
        try {
          await allow.mutateAsync({ id });
          toast({ message: t('security.identities.removed.allowed') });
          return true;
        } catch {
          toast({ message: t('error.saveFailed'), tone: 'danger' });
          return false;
        }
      }}
      prefs={prefs}
      now={now}
      onUnlink={async (id) => {
        try {
          await unlink.mutateAsync({ id });
          toast({ message: t('security.identities.unlinked') });
          return 'unlinked';
        } catch (error) {
          if (error instanceof ApiError && error.code === 'last_identity') return 'lastIdentity';
          toast({ message: t('error.saveFailed'), tone: 'danger' });
          return 'failed';
        }
      }}
    />
  );
}

function ConnectedApps({ now }: { now: number }) {
  const { t } = useTranslation('settings');
  // `#grant-<id>`: the `device_connected` notice links to the grant it names (11 §9.4).
  const hash = useLocation({ select: (location) => location.hash });
  const focusGrantId = hash.startsWith('grant-') ? hash.slice('grant-'.length) : null;
  const prefs = useDisplayPrefs();
  const me = useMe();
  const grants = useGrants();
  const orgs = useGrantOrgs();
  const createToken = useCreateToken();
  const updateGrant = useUpdateGrant();
  const revokeGrant = useRevokeGrant();
  // The grant being edited: its orgs and groups are confirmed against the server before any
  // stale id is pruned (never the optimistic list cache).
  const [editing, setEditing] = useState<Grant | null>(null);
  const confirmIds =
    editing === null
      ? null
      : editing.constraints.orgs === 'all'
        ? []
        : editing.constraints.orgs.map((org) => org.orgId);
  const confirmed = useConfirmedGrantOrgs(confirmIds);
  const failed = (message: string) => (error: unknown) => {
    toast({ message, tone: 'danger' });
    throw error;
  };
  return (
    <ConnectedAppsSection
      grants={grants.data}
      error={grants.error}
      orgs={orgs}
      confirmedOrgs={editing ? confirmed.orgs : undefined}
      confirmOrgs={confirmed.confirm}
      onEditingChange={setEditing}
      isAdmin={me.data?.user.isAdmin === true}
      focusGrantId={focusGrantId}
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
