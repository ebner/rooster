import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/button';
import { SettingsSection } from '../settings/settings-section';

export interface PushKeysSectionProps {
  onRegenerate: () => Promise<void>;
  /** Kitchen sink: start with the confirmation open. */
  defaultExpanded?: boolean;
  'data-force'?: string;
}

/**
 * Admin → Push keys (08 key rotation): replaces the VAPID keys. Every device loses its
 * subscription, so the confirmation expands inline (no modal, 02 §1), like the danger zone.
 */
export function PushKeysSection({
  onRegenerate,
  defaultExpanded = false,
  'data-force': force,
}: PushKeysSectionProps) {
  const { t } = useTranslation('admin');
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const forced = force ? { 'data-force': force } : {};

  const confirm = async () => {
    setPending(true);
    setError(false);
    try {
      await onRegenerate();
      setExpanded(false);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <SettingsSection title={t('pushKeys.title')} description={t('pushKeys.description')}>
      <div className="flex flex-col gap-4 rounded-lg border border-border-danger p-4">
        <div className="flex flex-col gap-3 tablet:flex-row tablet:items-center tablet:justify-between">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-sm font-semibold">{t('pushKeys.regenerateTitle')}</p>
            <p className="text-sm text-text-secondary">{t('pushKeys.regenerateBody')}</p>
          </div>
          <div className="shrink-0">
            <Button
              icon={KeyRound}
              aria-expanded={expanded}
              onPress={() => {
                setExpanded(!expanded);
                setError(false);
              }}
              className="text-text-danger"
              {...forced}
            >
              {t('pushKeys.regenerate')}
            </Button>
          </div>
        </div>
        {expanded && (
          <div
            className="flex flex-col gap-3 rounded-md bg-bg-subtle p-4"
            data-testid="push-keys-confirm"
          >
            <p className="text-sm text-text-secondary">{t('pushKeys.confirmBody')}</p>
            {error && (
              <Banner tone="danger" role="alert">
                {t('pushKeys.failed')}
              </Banner>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onPress={() => setExpanded(false)}>
                {t('pushKeys.cancel')}
              </Button>
              <Button variant="danger" icon={KeyRound} isLoading={pending} onPress={confirm}>
                {t('pushKeys.confirm')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
