import { useTranslation } from 'react-i18next';
import type { Org, OrgPatch } from '../../data/types';
import { Avatar } from '../../ui/avatar';
import { Banner } from '../../ui/banner';
import { ColorPicker } from '../../ui/color-picker';
import { EmojiPicker } from '../../ui/emoji-picker';
import { InlineTextField } from '../../ui/inline-text-field';
import { SettingsSection } from '../settings/settings-section';
import { orgNameMaxLength } from '../shell/create-org-form';
import { orgUrlSlug, paths } from '../shell/paths';

export interface GeneralSectionProps {
  org: Org;
  onUpdate: (patch: OrgPatch) => void;
}

/** Name, icon and colour, edited in place (FR-SET-4). Personal orgs keep their name (06 §2.2). */
export function GeneralSection({ org, onUpdate }: GeneralSectionProps) {
  const { t } = useTranslation('settings');
  const canEdit = org.role === 'owner';
  return (
    <SettingsSection title={t('org.general.title')}>
      {org.isPersonal && <Banner tone="info">{t('org.general.personalNote')}</Banner>}
      <div className="flex items-center gap-4">
        <Avatar
          id={org.id}
          name={org.name}
          emoji={org.avatarEmoji}
          color={org.color}
          shape="square"
          size={40}
          decorative
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {canEdit && !org.isPersonal ? (
            <InlineTextField
              label={t('org.general.name')}
              value={org.name}
              maxLength={orgNameMaxLength}
              onCommit={(name) => onUpdate({ name })}
              textClassName="text-xl"
            />
          ) : (
            <p className="truncate text-xl">{org.name}</p>
          )}
          <p className="truncate font-mono text-xs text-text-muted">
            {paths.orgView(orgUrlSlug(org), 'my')}
          </p>
        </div>
      </div>
      {!canEdit && <p className="text-sm text-text-muted">{t('org.general.ownersOnly')}</p>}
      <EmojiPicker
        label={t('org.general.icon')}
        value={org.avatarEmoji}
        name={org.name}
        isDisabled={!canEdit}
        onChange={(avatarEmoji) => onUpdate({ avatarEmoji })}
      />
      <ColorPicker
        label={t('org.general.color')}
        value={org.color ?? 'gray'}
        isDisabled={!canEdit}
        onChange={(color) => onUpdate({ color })}
      />
    </SettingsSection>
  );
}
