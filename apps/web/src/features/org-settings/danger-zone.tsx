import { LogOut, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Form } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import type { Org } from '../../data/types';
import { Banner } from '../../ui/banner';
import { Button } from '../../ui/button';
import { TextField } from '../../ui/input';
import { SettingsSection } from '../settings/settings-section';

export interface DangerZoneProps {
  org: Org;
  /** The current user is the org's only owner (cannot leave, FR-ORG-5). */
  isSoleOwner: boolean;
  onDelete: (confirmName: string) => Promise<void>;
  onLeave: () => Promise<void>;
  /** Kitchen sink: start with the confirmation open. */
  defaultExpanded?: 'delete' | 'leave' | null;
}

/**
 * Delete (owners; type the name to confirm, FR-ORG-4) and leave. The confirmation
 * expands inline under the button rather than in a modal.
 */
export function DangerZone({
  org,
  isSoleOwner,
  onDelete,
  onLeave,
  defaultExpanded = null,
}: DangerZoneProps) {
  const { t } = useTranslation('settings');
  const [expanded, setExpanded] = useState<'delete' | 'leave' | null>(defaultExpanded);
  // Only a user's own click moves focus into the confirmation (not a preset state).
  const [userOpened, setUserOpened] = useState(false);
  const toggle = (panel: 'delete' | 'leave') => {
    setUserOpened(true);
    setExpanded(expanded === panel ? null : panel);
  };

  if (org.isPersonal) {
    return (
      <SettingsSection title={t('org.danger.title')} tone="danger">
        <p className="text-sm text-text-secondary">{t('org.danger.personal')}</p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={t('org.danger.title')} tone="danger">
      <div className="flex flex-col rounded-lg border border-border-danger">
        <DangerRow
          title={t('org.danger.leaveTitle')}
          body={isSoleOwner ? t('org.danger.leaveSoleOwner') : t('org.danger.leaveBody')}
          action={
            <Button
              icon={LogOut}
              isDisabled={isSoleOwner}
              aria-expanded={expanded === 'leave'}
              onPress={() => toggle('leave')}
            >
              {t('org.danger.leave')}
            </Button>
          }
        >
          {expanded === 'leave' && (
            <ConfirmLeave orgName={org.name} onCancel={() => setExpanded(null)} onLeave={onLeave} />
          )}
        </DangerRow>
        {org.role === 'owner' && (
          <DangerRow
            title={t('org.danger.deleteTitle')}
            body={t('org.danger.deleteBody')}
            action={
              <Button
                icon={Trash2}
                aria-expanded={expanded === 'delete'}
                onPress={() => toggle('delete')}
                className="text-text-danger"
              >
                {t('org.danger.delete')}
              </Button>
            }
          >
            {expanded === 'delete' && (
              <ConfirmDelete
                autoFocus={userOpened}
                orgName={org.name}
                onCancel={() => setExpanded(null)}
                onDelete={onDelete}
              />
            )}
          </DangerRow>
        )}
      </div>
    </SettingsSection>
  );
}

function DangerRow({
  title,
  body,
  action,
  children,
}: {
  title: string;
  body: string;
  action: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-border p-4 last:border-b-0">
      <div className="flex flex-col gap-3 tablet:flex-row tablet:items-center tablet:justify-between">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-sm text-text-secondary">{body}</p>
        </div>
        <div className="shrink-0">{action}</div>
      </div>
      {children}
    </div>
  );
}

function ConfirmDelete({
  autoFocus,
  orgName,
  onCancel,
  onDelete,
}: {
  autoFocus: boolean;
  orgName: string;
  onCancel: () => void;
  onDelete: (confirmName: string) => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const matches = value.trim() === orgName;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await onDelete(value.trim());
    } catch {
      setError(t('org.danger.deleteFailed'));
      setPending(false);
    }
  };

  return (
    <Form onSubmit={submit} className="flex flex-col gap-3 rounded-md bg-bg-subtle p-4">
      <TextField
        label={t('org.danger.confirmLabel', { name: orgName })}
        value={value}
        onChange={setValue}
        autoFocus={autoFocus}
        autoComplete="off"
      />
      {error && (
        <Banner tone="danger" role="alert">
          {error}
        </Banner>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={onCancel}>
          {t('org.danger.cancel')}
        </Button>
        <Button
          type="submit"
          variant="danger"
          icon={Trash2}
          isDisabled={!matches}
          isLoading={pending}
        >
          {t('org.danger.deleteConfirm')}
        </Button>
      </div>
    </Form>
  );
}

function ConfirmLeave({
  orgName,
  onCancel,
  onLeave,
}: {
  orgName: string;
  onCancel: () => void;
  onLeave: () => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [pending, setPending] = useState(false);
  return (
    <div className="flex flex-col gap-3 rounded-md bg-bg-subtle p-4">
      <p className="text-sm text-text-secondary">
        {t('org.danger.leaveConfirmBody', { name: orgName })}
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={onCancel}>
          {t('org.danger.cancel')}
        </Button>
        <Button
          variant="danger"
          icon={LogOut}
          isLoading={pending}
          onPress={async () => {
            setPending(true);
            try {
              await onLeave();
            } finally {
              setPending(false);
            }
          }}
        >
          {t('org.danger.leaveConfirm')}
        </Button>
      </div>
    </div>
  );
}
