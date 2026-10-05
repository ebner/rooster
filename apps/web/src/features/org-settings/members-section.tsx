import { UserMinus } from 'lucide-react';
import { useState } from 'react';
import { Popover as AriaPopover, Dialog, DialogTrigger, Heading } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import type { Org, OrgMember, OrgRole } from '../../data/types';
import { cn } from '../../lib/cn';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { Chip } from '../../ui/chip';
import { overlayOffsetPx, popoverMotion, popoverSurface } from '../../ui/popover';
import { Select } from '../../ui/select';
import { SettingsSection } from '../settings/settings-section';

export interface MembersSectionProps {
  org: Org;
  members: readonly OrgMember[];
  currentUserId: string;
  onChangeRole: (userId: string, role: OrgRole) => void;
  onRemove: (userId: string) => Promise<void> | void;
}

const roles: readonly OrgRole[] = ['owner', 'member'];

/** Members table: role changes and removal for owners; the last owner is protected (FR-ORG-5). */
export function MembersSection({
  org,
  members,
  currentUserId,
  onChangeRole,
  onRemove,
}: MembersSectionProps) {
  const { t } = useTranslation('settings');
  const canManage = org.role === 'owner' && !org.isPersonal;
  const owners = members.filter((m) => m.role === 'owner').length;
  const roleOptions = roles.map((id) => ({ id, label: t(`org.role.${id}`) }));
  const selfIsSoleOwner =
    owners === 1 && members.some((m) => m.userId === currentUserId && m.role === 'owner');

  return (
    <SettingsSection
      id="members"
      title={t('org.members.title')}
      description={t('org.members.count', { count: members.length })}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-start text-xs font-medium text-text-muted">
              <th scope="col" className="py-2 pe-3 text-start font-medium">
                {t('org.members.member')}
              </th>
              <th scope="col" className="w-label-col py-2 pe-3 text-start font-medium">
                {t('org.members.role')}
              </th>
              <th scope="col" className="py-2 text-end font-medium">
                <span className="sr-only">{t('org.members.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const isSelf = member.userId === currentUserId;
              const isLastOwner = member.role === 'owner' && owners === 1;
              return (
                <tr key={member.userId} className="border-b border-border last:border-b-0">
                  <td className="py-3 pe-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar
                        id={member.userId}
                        name={member.name}
                        src={member.image ?? undefined}
                        size={32}
                        decorative
                      />
                      <div className="flex min-w-0 flex-col">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium text-text">{member.name}</span>
                          {isSelf && <Chip>{t('org.members.you')}</Chip>}
                        </span>
                        <span className="truncate text-text-muted">{member.email}</span>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 pe-3">
                    {canManage ? (
                      <Select
                        label={t('org.members.roleFor', { name: member.name })}
                        hideLabel
                        options={roleOptions}
                        value={member.role}
                        isDisabled={isLastOwner}
                        onChange={(role) => onChangeRole(member.userId, role)}
                        className="w-label-col"
                      />
                    ) : (
                      <span className="text-text-secondary">{t(`org.role.${member.role}`)}</span>
                    )}
                  </td>
                  <td className="py-3 text-end">
                    {canManage && !isSelf && !isLastOwner && (
                      <RemoveMemberButton
                        member={member}
                        orgName={org.name}
                        onConfirm={() => onRemove(member.userId)}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canManage && selfIsSoleOwner && (
        <p className="text-sm text-text-muted">{t('org.members.lastOwner')}</p>
      )}
    </SettingsSection>
  );
}

interface RemoveMemberButtonProps {
  member: OrgMember;
  orgName: string;
  onConfirm: () => Promise<void> | void;
}

/** An anchored destructive confirmation (no modal, 02 §1). */
function RemoveMemberButton({ member, orgName, onConfirm }: RemoveMemberButtonProps) {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="sm"
        icon={UserMinus}
        aria-label={t('org.members.removeNamed', { name: member.name })}
      >
        <span className="max-tablet:sr-only">{t('org.members.remove')}</span>
      </Button>
      <AriaPopover
        offset={overlayOffsetPx}
        placement="bottom end"
        className={cn(popoverSurface, popoverMotion, 'bg-bg-danger-subtle')}
      >
        <Dialog className="flex w-date-popover max-w-full flex-col gap-3 p-3 text-start outline-none">
          <Heading slot="title" className="text-sm font-semibold text-text-danger">
            {t('org.members.removeTitle', { name: member.name, org: orgName })}
          </Heading>
          <p className="text-sm text-text-danger">{t('org.members.removeBody')}</p>
          <div className="flex justify-end gap-2">
            <Button
              variant="danger"
              size="sm"
              isLoading={pending}
              onPress={async () => {
                setPending(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } finally {
                  setPending(false);
                }
              }}
            >
              {t('org.members.removeConfirm')}
            </Button>
          </div>
        </Dialog>
      </AriaPopover>
    </DialogTrigger>
  );
}
