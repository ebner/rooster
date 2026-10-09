import { Copy, Link2, Mail } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Form } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import type { CreatedInvite, CreateInviteInput, OrgInvite, OrgRole } from '../../data/types';
import { type DisplayPrefs, formatDay } from '../../lib/format';
import { Banner } from '../../ui/banner';
import { Button, iconStrokeWidth } from '../../ui/button';
import { Chip } from '../../ui/chip';
import { IconButton } from '../../ui/icon-button';
import { Input, TextField } from '../../ui/input';
import { SegmentedControl } from '../../ui/segmented-control';
import { Select } from '../../ui/select';
import { toast } from '../../ui/toast';
import { SettingsSection } from '../settings/settings-section';

export type InviteDraft = DistributiveOmit<CreateInviteInput, 'orgId'>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface InvitesSectionProps {
  invites: readonly OrgInvite[];
  onCreate: (draft: InviteDraft) => Promise<CreatedInvite & { emailed?: boolean }>;
  /** The server sends invite emails (`/meta` features.email); otherwise every invite is a link. */
  emailEnabled?: boolean;
  onRevoke: (inviteId: string) => void;
  prefs: DisplayPrefs;
  now: number;
}

/** 7 days is the default lifetime (FR-ORG-3). */
const expiryChoices = ['1', '7', '14', '30'] as const;
type Expiry = (typeof expiryChoices)[number];

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Copies an invite URL and confirms with a toast (Phase 0 `toast()`). */
export async function copyInviteUrl(url: string, messages: { ok: string; failed: string }) {
  try {
    await navigator.clipboard.writeText(url);
    toast({ message: messages.ok });
  } catch {
    toast({ message: messages.failed, tone: 'danger' });
  }
}

/**
 * Email and link invites (FR-ORG-3). With SMTP the server emails an email invite (P7);
 * without it, or for a link invite, the user copies the link (AC-7.3).
 */
export function InvitesSection({
  invites,
  onCreate,
  emailEnabled = false,
  onRevoke,
  prefs,
  now,
}: InvitesSectionProps) {
  const { t } = useTranslation('settings');
  const copyMessages = { ok: t('org.invites.copied'), failed: t('org.invites.copyFailed') };
  return (
    <SettingsSection
      id="invites"
      title={t('org.invites.title')}
      description={emailEnabled ? t('org.invites.descriptionEmail') : t('org.invites.description')}
    >
      <CreateInviteForm onCreate={onCreate} copyMessages={copyMessages} />
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t('org.invites.open')}</h3>
        {invites.length === 0 ? (
          <p className="text-sm text-text-muted">{t('org.invites.none')}</p>
        ) : (
          <ul className="flex flex-col">
            {invites.map((invite) => (
              <li
                key={invite.id}
                className="flex items-center gap-3 border-b border-border py-3 last:border-b-0"
              >
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-muted text-text-secondary">
                  {invite.kind === 'email' ? (
                    <Mail className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
                  ) : (
                    <Link2 className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
                  )}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate text-sm font-medium">
                      {invite.kind === 'email' ? invite.email : t('org.invites.link')}
                    </span>
                    <Chip>{t(`org.role.${invite.role}`)}</Chip>
                  </span>
                  <span className="truncate text-sm text-text-muted">
                    {[
                      invite.kind === 'link'
                        ? invite.multiUse
                          ? t('org.invites.multiUseCount', { count: invite.uses })
                          : t('org.invites.singleUse')
                        : null,
                      t('org.invites.expires', { date: formatDay(invite.expiresAt, prefs, now) }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                {invite.url && (
                  <IconButton
                    icon={Copy}
                    aria-label={t('org.invites.copy')}
                    onPress={() => {
                      if (invite.url) void copyInviteUrl(invite.url, copyMessages);
                    }}
                  />
                )}
                <Button variant="ghost" size="sm" onPress={() => onRevoke(invite.id)}>
                  {t('org.invites.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}

interface CreateInviteFormProps {
  onCreate: InvitesSectionProps['onCreate'];
  copyMessages: { ok: string; failed: string };
}

function CreateInviteForm({ onCreate, copyMessages }: CreateInviteFormProps) {
  const { t } = useTranslation('settings');
  const [kind, setKind] = useState<'email' | 'link'>('email');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('member');
  const [use, setUse] = useState<'single' | 'multi'>('single');
  const [expiry, setExpiry] = useState<Expiry>('7');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [created, setCreated] = useState<{
    url: string;
    email: string | null;
    emailed: boolean;
  } | null>(null);
  const emailInvalid = kind === 'email' && email.trim() !== '' && !emailPattern.test(email.trim());

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || (kind === 'email' && (!email.trim() || emailInvalid))) return;
    setPending(true);
    setError(undefined);
    try {
      const expiresInDays = Number(expiry);
      const draft: InviteDraft =
        kind === 'email'
          ? { kind, email: email.trim(), role, expiresInDays }
          : { kind, role, multiUse: use === 'multi', expiresInDays };
      const result = await onCreate(draft);
      const invitee = kind === 'email' ? email.trim() : null;
      const emailed = invitee !== null && result.emailed === true;
      setCreated({ url: result.url, email: invitee, emailed });
      if (emailed) toast({ message: t('org.invites.sent', { email: invitee }) });
      setEmail('');
    } catch {
      setError(t('org.invites.createFailed'));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <Form onSubmit={submit} className="flex flex-col gap-4">
        <SegmentedControl
          label={t('org.invites.kind')}
          options={[
            { id: 'email', label: t('org.invites.kindEmail') },
            { id: 'link', label: t('org.invites.kindLink') },
          ]}
          value={kind}
          onChange={(next) => {
            setKind(next);
            setCreated(null);
          }}
        />
        <div className="flex flex-col gap-4 tablet:flex-row tablet:flex-wrap tablet:items-start">
          {kind === 'email' && (
            <TextField
              label={t('org.invites.email')}
              type="email"
              placeholder={t('org.invites.emailPlaceholder')}
              value={email}
              onChange={setEmail}
              errorMessage={emailInvalid ? t('org.invites.emailInvalid') : undefined}
              className="min-w-0 flex-1"
            />
          )}
          <Select
            label={t('org.invites.role')}
            options={[
              { id: 'member', label: t('org.role.member') },
              { id: 'owner', label: t('org.role.owner') },
            ]}
            value={role}
            onChange={setRole}
            className="tablet:w-label-col"
          />
          {kind === 'link' && (
            <SegmentedControl
              label={t('org.invites.uses')}
              options={[
                { id: 'single', label: t('org.invites.useOnce') },
                { id: 'multi', label: t('org.invites.useMany') },
              ]}
              value={use}
              onChange={setUse}
            />
          )}
          <Select
            label={t('org.invites.expiresIn')}
            options={expiryChoices.map((id) => ({
              id,
              label: t('org.invites.days', { count: Number(id) }),
            }))}
            value={expiry}
            onChange={setExpiry}
            className="tablet:w-label-col"
          />
        </div>
        {error && (
          <Banner tone="danger" role="alert">
            {error}
          </Banner>
        )}
        <div>
          <Button
            type="submit"
            variant="primary"
            icon={kind === 'email' ? Mail : Link2}
            isLoading={pending}
            isDisabled={kind === 'email' && (!email.trim() || emailInvalid)}
          >
            {kind === 'email' ? t('org.invites.createEmail') : t('org.invites.createLink')}
          </Button>
        </div>
      </Form>
      {created && (
        <div className="flex flex-col gap-2" role="status">
          <p className="text-sm text-text-secondary">
            {created.email
              ? created.emailed
                ? t('org.invites.sentNote', { email: created.email })
                : t('org.invites.createdEmail', { email: created.email })
              : t('org.invites.createdLink')}
          </p>
          <div className="flex gap-2">
            <Input
              aria-label={t('org.invites.url')}
              value={created.url}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
              className="font-mono text-sm"
            />
            <Button icon={Copy} onPress={() => void copyInviteUrl(created.url, copyMessages)}>
              {t('org.invites.copy')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
