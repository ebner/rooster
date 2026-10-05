import type { Backup } from '@rooster/core/schemas';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type DisplayPrefs, formatDay } from '../../lib/format';
import { Button, iconStrokeWidth } from '../../ui/button';
import { Chip } from '../../ui/chip';
import { SettingsSection } from '../settings/settings-section';

export interface BackupsSectionProps {
  backups: readonly Backup[];
  /** Resolve to refresh; throw to show the failure. */
  onBackUpNow: () => unknown;
  isBackingUp?: boolean;
  downloadUrl: (name: string) => string;
  prefs: DisplayPrefs;
  now: number;
}

const units = ['B', 'KB', 'MB', 'GB'] as const;

/** 1 decimal below 10, whole numbers above (1.4 MB, 312 KB). */
export function formatBytes(bytes: number): { value: string; unit: string } {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return {
    value: value < 10 && unit > 0 ? value.toFixed(1) : String(Math.round(value)),
    unit: units[unit] as string,
  };
}

/** WP 2.9: the instance's database snapshots, with "Back up now" and downloads (06 §2.10). */
export function BackupsSection({
  backups,
  onBackUpNow,
  isBackingUp = false,
  downloadUrl,
  prefs,
  now,
}: BackupsSectionProps) {
  const { t } = useTranslation('admin');
  return (
    <SettingsSection title={t('backups.title')} description={t('backups.description')}>
      <div className="flex flex-col gap-4">
        <div>
          <Button size="sm" onPress={onBackUpNow} isLoading={isBackingUp}>
            {t('backups.backUpNow')}
          </Button>
        </div>
        {backups.length === 0 ? (
          <p className="text-sm text-text-muted">{t('backups.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-text-muted">
                  <th scope="col" className="py-2 pe-3 text-start font-medium">
                    {t('backups.createdAt')}
                  </th>
                  <th scope="col" className="py-2 pe-3 text-start font-medium">
                    {t('backups.kind')}
                  </th>
                  <th scope="col" className="py-2 pe-3 text-end font-medium">
                    {t('backups.size')}
                  </th>
                  <th scope="col" className="py-2 text-end font-medium">
                    <span className="sr-only">{t('backups.name')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {backups.map((backup) => (
                  <tr key={backup.name} className="border-b border-border last:border-b-0">
                    <td className="py-2.5 pe-3 tabular-nums">
                      <span className="block">{formatDay(backup.createdAt, prefs, now)}</span>
                      <span className="block truncate font-mono text-xs text-text-muted">
                        {backup.name}
                      </span>
                    </td>
                    <td className="py-2.5 pe-3">
                      <Chip color={backup.kind === 'manual' ? 'blue' : 'gray'}>
                        {t(`backups.kinds.${backup.kind}`)}
                      </Chip>
                    </td>
                    <td className="py-2.5 pe-3 text-end tabular-nums text-text-secondary">
                      {t('backups.bytes', formatBytes(backup.size))}
                    </td>
                    <td className="py-2.5 text-end">
                      <a
                        href={downloadUrl(backup.name)}
                        download={backup.name}
                        aria-label={t('backups.download', { name: backup.name })}
                        className="inline-flex size-control-sm items-center justify-center rounded-sm text-text-secondary hover:bg-bg-subtle hover:text-text"
                      >
                        <Download className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
