import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  errorCode,
  useCreateInvite,
  useDeleteOrg,
  useDisplayPrefs,
  useMe,
  useOrg,
  useOrgInvites,
  useOrgMembers,
  useRemoveMember,
  useRevokeInvite,
  useServerFeatures,
  useUpdateMemberRole,
  useUpdateOrg,
} from '../../data';
import { useDeleteTag, useMergeTag, useTags, useUpdateTag } from '../../data/tags';
import { OrgSettingsPage } from '../../features/org-settings/org-settings-page';
import { ViewBody, ViewHeader } from '../../features/shell/app-shell';
import { OrgNotFound } from '../../features/shell/org-not-found';
import { TagsSection } from '../../features/tags/tags-section';
import { toast } from '../../ui/toast';

export const Route = createFileRoute('/_app/o/$orgSlug/settings')({
  component: OrgSettingsRoute,
});

function OrgSettingsRoute() {
  const { t } = useTranslation('settings');
  const { orgSlug } = Route.useParams();
  const navigate = useNavigate();
  const me = useMe();
  const org = useOrg(orgSlug);
  const orgId = org.data?.id;
  const members = useOrgMembers(orgId);
  const invites = useOrgInvites(orgId);
  const prefs = useDisplayPrefs();
  const updateOrg = useUpdateOrg();
  const updateRole = useUpdateMemberRole();
  const removeMember = useRemoveMember();
  const createInvite = useCreateInvite();
  const features = useServerFeatures();
  const revokeInvite = useRevokeInvite();
  const deleteOrg = useDeleteOrg();
  const tags = useTags(orgId);
  const updateTag = useUpdateTag(orgId ?? '');
  const mergeTag = useMergeTag(orgId ?? '');
  const deleteTag = useDeleteTag(orgId ?? '');
  const { t: tTags } = useTranslation('tags');

  if (org.data === null) return <OrgNotFound />;
  if (!org.data || !orgId || !me.data) return null;
  const current = org.data;
  const userId = me.data.user.id;

  const fail = (error: unknown) =>
    toast({
      message:
        errorCode(error) === 'last_owner' ? t('org.members.lastOwnerError') : t('error.saveFailed'),
      tone: 'danger',
    });

  return (
    <>
      <ViewHeader title={t('org.title')} context={current.name} />
      <ViewBody>
        <OrgSettingsPage
          org={current}
          currentUserId={userId}
          members={members.data ?? []}
          invites={invites.data ?? []}
          prefs={prefs}
          now={Date.now()}
          onUpdateOrg={(patch) => updateOrg.mutateAsync({ orgId, patch }).catch(fail)}
          onChangeRole={(memberId, role) =>
            updateRole.mutateAsync({ orgId, userId: memberId, role }).catch(fail)
          }
          onRemoveMember={async (memberId) => {
            const name = members.data?.find((m) => m.userId === memberId)?.name ?? '';
            try {
              await removeMember.mutateAsync({ orgId, userId: memberId });
              toast({ message: t('org.members.removed', { name }) });
            } catch (error) {
              fail(error);
            }
          }}
          onCreateInvite={(draft) => createInvite.mutateAsync({ ...draft, orgId })}
          inviteEmailEnabled={features.data?.email === true}
          onRevokeInvite={(inviteId) =>
            revokeInvite
              .mutateAsync({ orgId, inviteId })
              .then(() => toast({ message: t('org.invites.revoked') }))
              .catch(fail)
          }
          onDeleteOrg={async (confirmName) => {
            await deleteOrg.mutateAsync({ orgId, confirmName });
            toast({ message: t('org.danger.deleted', { name: current.name }) });
            await navigate({ to: '/o/$orgSlug/my', params: { orgSlug: 'personal' } });
          }}
          tagsSection={
            <TagsSection
              tags={tags.data ?? []}
              onRename={(id, name) =>
                updateTag
                  .mutateAsync({ id, patch: { name } })
                  .then(() => toast({ message: tTags('settings.renamed') }))
                  .catch((error) =>
                    toast({
                      message:
                        errorCode(error) === 'tag_name_taken'
                          ? tTags('settings.nameTaken')
                          : t('error.saveFailed'),
                      tone: 'danger',
                    }),
                  )
              }
              onRecolor={(id, color) => updateTag.mutateAsync({ id, patch: { color } }).catch(fail)}
              onMerge={async (id, intoId) => {
                const into = tags.data?.find((tag) => tag.id === intoId)?.name ?? '';
                try {
                  await mergeTag.mutateAsync({ id, intoId });
                  toast({ message: tTags('settings.merged', { name: into }) });
                } catch (error) {
                  fail(error);
                }
              }}
              onDelete={async (id) => {
                const name = tags.data?.find((tag) => tag.id === id)?.name ?? '';
                try {
                  await deleteTag.mutateAsync(id);
                  toast({ message: tTags('settings.deleted', { name }) });
                } catch (error) {
                  fail(error);
                }
              }}
            />
          }
          onLeaveOrg={async () => {
            try {
              await removeMember.mutateAsync({ orgId, userId });
              toast({ message: t('org.danger.left', { name: current.name }) });
              await navigate({ to: '/o/$orgSlug/my', params: { orgSlug: 'personal' } });
            } catch (error) {
              fail(error);
            }
          }}
        />
      </ViewBody>
    </>
  );
}
