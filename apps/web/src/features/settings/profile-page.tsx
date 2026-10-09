import { formatRelative, formatTime } from '@rooster/core/dates';
import { type Locale, supportedLocales } from '@rooster/i18n/core';
import { useTranslation } from 'react-i18next';
import type { CurrentUser, ProfilePatch } from '../../data/types';
import { Avatar } from '../../ui/avatar';
import { InlineTextField } from '../../ui/inline-text-field';
import { SegmentedControl } from '../../ui/segmented-control';
import { SettingsSection } from './settings-section';
import { TimezoneSelect } from './timezone-select';

export interface ProfilePageProps {
  user: CurrentUser;
  onChange: (patch: ProfilePatch) => void;
  /** Switches the UI language at once (and stores it on the profile). */
  onLocaleChange: (locale: Locale) => void;
}

/** A fixed sample for the format previews, far from "today" so it never reads "Tomorrow". */
const sampleDate = '2026-10-12';
const sampleToday = '2026-01-01';
const sampleTime = '14:30';

/** FR-SET-1: name, language, timezone, week start, date and time format. Saved per field. */
export function ProfilePage({ user, onChange, onLocaleChange }: ProfilePageProps) {
  const { t } = useTranslation('settings');
  const { t: tc } = useTranslation();
  const datePreview = (dateFormat: CurrentUser['dateFormat']) =>
    formatRelative(
      { dueDate: sampleDate },
      { today: sampleToday, locale: 'en', dateFormat, timeFormat: user.timeFormat },
    );
  const timePreview = (timeFormat: CurrentUser['timeFormat']) =>
    formatTime(sampleTime, user.locale, timeFormat);

  return (
    <div className="flex flex-col gap-12">
      <SettingsSection title={t('profile.title')} isPageTitle>
        <div className="flex items-center gap-4">
          <Avatar
            id={user.id}
            name={user.name}
            src={user.image ?? undefined}
            size={40}
            decorative
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <InlineTextField
              label={t('profile.name')}
              value={user.name}
              maxLength={80}
              onCommit={(name) => onChange({ name })}
              textClassName="text-md font-medium"
            />
            <p className="truncate text-sm text-text-muted">{user.email}</p>
          </div>
        </div>
        <p className="text-sm text-text-muted">{t('profile.pictureNote')}</p>
      </SettingsSection>

      <SettingsSection title={t('profile.regionTitle')} description={t('profile.regionBody')}>
        <SegmentedControl
          label={tc('language.label')}
          options={supportedLocales.map((locale) => ({
            id: locale,
            label: tc(`language.${locale}`),
            lang: locale,
          }))}
          value={user.locale}
          onChange={onLocaleChange}
        />
        <TimezoneSelect
          value={user.timezone}
          onChange={(timezone) => onChange({ timezone })}
          description={t('profile.timezoneHint')}
          className="max-w-pane-min"
        />
        <SegmentedControl
          label={t('profile.weekStart')}
          options={[
            { id: '1', label: t('profile.monday') },
            { id: '0', label: t('profile.sunday') },
          ]}
          value={String(user.weekStart) as '0' | '1'}
          onChange={(value) => onChange({ weekStart: value === '0' ? 0 : 1 })}
        />
        <SegmentedControl
          label={t('profile.dateFormat')}
          description={user.locale === 'sv' ? t('profile.dateFormatSwedish') : undefined}
          options={[
            { id: 'MMM d', label: datePreview('MMM d') },
            { id: 'd MMM', label: datePreview('d MMM') },
          ]}
          value={user.dateFormat}
          onChange={(dateFormat) => onChange({ dateFormat })}
        />
        <SegmentedControl
          label={t('profile.timeFormat')}
          options={[
            { id: '24h', label: timePreview('24h') },
            { id: '12h', label: timePreview('12h') },
          ]}
          value={user.timeFormat}
          onChange={(timeFormat) => onChange({ timeFormat })}
        />
      </SettingsSection>
    </div>
  );
}
