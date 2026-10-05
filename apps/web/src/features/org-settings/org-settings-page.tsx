import { useTranslation } from 'react-i18next';
import type { CreatedInvite, Org, OrgInvite, OrgMember, OrgPatch, OrgRole } from '../../data/types';
import type { DisplayPrefs } from '../../lib/format';
import { SettingsSection } from '../settings/settings-section';
import { DangerZone } from './danger-zone';
import { GeneralSection } from './general-section';
import { type InviteDraft, InvitesSection } from './invites-section';
import { MembersSection } from './members-section';

export interface OrgSettingsPageProps {
  org: Org;
  currentUserId: string;
  members: readonly OrgMember[];
  invites: readonly OrgInvite[];
  prefs: DisplayPrefs;
  now: number;
  onUpdateOrg: (patch: OrgPatch) => void;
  onChangeRole: (userId: string, role: OrgRole) => void;
  onRemoveMember: (userId: string) => Promise<void> | void;
  onCreateInvite: (draft: InviteDraft) => Promise<CreatedInvite>;
  onRevokeInvite: (inviteId: string) => void;
  onDeleteOrg: (confirmName: string) => Promise<void>;
  onLeaveOrg: () => Promise<void>;
}

/** FR-SET-4: General, Members, Invites (owners of shared orgs) and the danger zone. */
export function OrgSettingsPage({
  org,
  currentUserId,
  members,
  invites,
  prefs,
  now,
  onUpdateOrg,
  onChangeRole,
  onRemoveMember,
  onCreateInvite,
  onRevokeInvite,
  onDeleteOrg,
  onLeaveOrg,
}: OrgSettingsPageProps) {
  const { t } = useTranslation('settings');
  const isOwner = org.role === 'owner';
  const isSoleOwner = isOwner && members.filter((m) => m.role === 'owner').length <= 1;
  return (
    <div className="flex max-w-pane-max flex-col gap-12">
      <GeneralSection org={org} onUpdate={onUpdateOrg} />
      {!org.isPersonal && (
        <MembersSection
          org={org}
          members={members}
          currentUserId={currentUserId}
          onChangeRole={onChangeRole}
          onRemove={onRemoveMember}
        />
      )}
      {org.isPersonal ? (
        <SettingsSection id="invites" title={t('org.invites.title')}>
          <p className="text-sm text-text-secondary" data-testid="personal-invites-note">
            {t('org.invites.personal')}
          </p>
        </SettingsSection>
      ) : (
        isOwner && (
          <InvitesSection
            invites={invites}
            onCreate={onCreateInvite}
            onRevoke={onRevokeInvite}
            prefs={prefs}
            now={now}
          />
        )
      )}
      <DangerZone org={org} isSoleOwner={isSoleOwner} onDelete={onDeleteOrg} onLeave={onLeaveOrg} />
    </div>
  );
}
