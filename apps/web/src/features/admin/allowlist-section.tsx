import { AtSign, Globe, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Form } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { errorCode } from '../../data/errors';
import type { AllowlistEntry, AllowlistKind } from '../../data/types';
import { type DisplayPrefs, formatDay } from '../../lib/format';
import { Button, iconStrokeWidth } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { TextField } from '../../ui/input';
import { SettingsSection } from '../settings/settings-section';

/** Classifies admin input: an address with "@" is an email, anything else a domain. */
export function parseAllowlistInput(raw: string): { kind: AllowlistKind; value: string } | null {
  const value = raw.trim().toLowerCase().replace(/^@/, '');
  if (!value) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { kind: 'email', value };
  if (/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) return { kind: 'domain', value };
  return null;
}

export interface AllowlistSectionProps {
  entries: readonly AllowlistEntry[];
  onAdd: (entry: { kind: AllowlistKind; value: string }) => Promise<void>;
  onRemove: (id: string) => void;
  prefs: DisplayPrefs;
  now: number;
}

/** FR-AUTH-8: who may sign in, besides env entries and invitations. */
export function AllowlistSection({ entries, onAdd, onRemove, prefs, now }: AllowlistSectionProps) {
  const { t } = useTranslation('admin');
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseAllowlistInput(input);
    if (!parsed) {
      setError(t('allowlist.invalid'));
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await onAdd(parsed);
      setInput('');
    } catch (failure) {
      setError(
        errorCode(failure) === 'conflict' ? t('allowlist.duplicate') : t('allowlist.addFailed'),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <SettingsSection title={t('allowlist.title')} description={t('allowlist.description')}>
      <Form onSubmit={submit} className="flex items-start gap-2">
        <TextField
          label={t('allowlist.inputLabel')}
          hideLabel
          placeholder={t('allowlist.placeholder')}
          value={input}
          onChange={(value) => {
            setInput(value);
            setError(undefined);
          }}
          errorMessage={error}
          className="min-w-0 flex-1"
        />
        <Button type="submit" icon={Plus} isLoading={pending} isDisabled={!input.trim()}>
          {t('allowlist.add')}
        </Button>
      </Form>
      {entries.length === 0 ? (
        <p className="text-sm text-text-muted">{t('allowlist.empty')}</p>
      ) : (
        <ul className="flex flex-col">
          {entries.map((entry) => {
            const Icon = entry.kind === 'email' ? AtSign : Globe;
            return (
              <li
                key={entry.id}
                className="flex items-center gap-3 border-b border-border py-2 last:border-b-0"
              >
                <Icon
                  className="size-4 shrink-0 text-text-secondary"
                  strokeWidth={iconStrokeWidth}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="sr-only">{t(`allowlist.kind.${entry.kind}`)}: </span>
                  {entry.value}
                </span>
                <span className="hidden text-sm text-text-muted tablet:inline">
                  {t('allowlist.added', { date: formatDay(entry.createdAt, prefs, now) })}
                </span>
                <IconButton
                  icon={Trash2}
                  aria-label={t('allowlist.remove', { value: entry.value })}
                  onPress={() => onRemove(entry.id)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </SettingsSection>
  );
}
