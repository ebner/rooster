import type { Grant, GrantPatch, TokenCreate } from '@rooster/core/schemas';
import { AppWindow, Copy, KeyRound, Plus, SquareTerminal } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Input } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { type DisplayPrefs, formatTimeAgo } from '../../lib/format';
import { Banner } from '../../ui/banner';
import { Button, iconStrokeWidth } from '../../ui/button';
import { Chip } from '../../ui/chip';
import { inputVariants, TextField } from '../../ui/input';
import { SettingsSection } from '../settings/settings-section';
import { ConstraintEditor } from './constraint-editor';
import {
  ceilingForGrant,
  defaultTokenValue,
  type GrantIssue,
  type GrantOrgOption,
  type GrantValue,
  grantIssues,
  reconcileGrant,
  toGrantPatch,
  toTokenCreate,
  valueFromGrant,
} from './grant-model';
import { describeScopes, describeWhere, formatGrantDate } from './grant-summary';

/** A token just created: the secret is shown once (11 §3.2). */
export interface CreatedToken {
  token: string;
  grant: Grant;
}

export type ConnectedAppsMode =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'created'; created: CreatedToken }
  | { kind: 'editing'; id: string }
  | { kind: 'confirming'; id: string };

export interface ConnectedAppsSectionProps {
  /** Undefined while loading. */
  grants: readonly Grant[] | undefined;
  error?: unknown;
  orgs: readonly GrantOrgOption[];
  prefs: DisplayPrefs;
  now: number;
  /** Resolves with the new token, or rejects (the form stays open). */
  onCreateToken: (input: TokenCreate) => Promise<CreatedToken>;
  onUpdate: (id: string, patch: GrantPatch) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
  /** Kitchen sink: start in a given state. */
  initialMode?: ConnectedAppsMode | undefined;
  /** The section's anchor (`/settings/security#connected-apps`). */
  id?: string | undefined;
  /**
   * Server-confirmed orgs and groups (`useConfirmedGrantOrgs`) for the grant being edited:
   * only ids missing there are pruned before a save. Undefined: nothing is pruned.
   */
  confirmedOrgs?: readonly GrantOrgOption[] | undefined;
  /**
   * Confirms the edited grant's orgs and groups afresh; called right before pruning on save,
   * so a group created after the editor opened is never taken for deleted. Without it nothing
   * is pruned.
   */
  confirmOrgs?: (() => Promise<readonly GrantOrgOption[]>) | undefined;
  /** The grant being edited (or null), so the caller can confirm its orgs and groups. */
  onEditingChange?: ((grant: Grant | null) => void) | undefined;
}

const kindIcons = { pat: KeyRound, device: SquareTerminal, oauth: AppWindow } as const;

/**
 * Settings → Connected apps (FR-SET-3, 11 §3.2): every PAT, CLI device and (P9) OAuth app with
 * what it may do and where, editable in place and revocable. Online-only (hard rule 4).
 */
export function ConnectedAppsSection({
  grants,
  error,
  orgs,
  prefs,
  now,
  onCreateToken,
  onUpdate,
  onRevoke,
  initialMode,
  id = 'connected-apps',
  confirmedOrgs,
  confirmOrgs,
  onEditingChange,
}: ConnectedAppsSectionProps) {
  const { t } = useTranslation('settings');
  const [mode, setMode] = useState<ConnectedAppsMode>(initialMode ?? { kind: 'idle' });
  const editingId = mode.kind === 'editing' ? mode.id : null;
  const editingGrant = grants?.find((g) => g.id === editingId) ?? null;
  useEffect(() => {
    onEditingChange?.(editingGrant);
  }, [editingGrant, onEditingChange]);
  const idle = () => setMode({ kind: 'idle' });
  const ordered = [...(grants ?? [])].sort(
    (a, b) => Number(b.current) - Number(a.current) || b.createdAt - a.createdAt,
  );

  return (
    <SettingsSection
      id={id}
      title={t('access.apps.title')}
      description={t('access.apps.body')}
      actions={
        mode.kind !== 'creating' && (
          <Button icon={Plus} onPress={() => setMode({ kind: 'creating' })} data-testid="new-token">
            {t('access.apps.newToken')}
          </Button>
        )
      }
    >
      {mode.kind === 'creating' && (
        <NewTokenForm
          orgs={orgs}
          prefs={prefs}
          now={now}
          onCancel={idle}
          onCreate={async (input) => {
            const created = await onCreateToken(input);
            setMode({ kind: 'created', created });
          }}
        />
      )}
      {mode.kind === 'created' && (
        <TokenReveal created={mode.created} onDone={idle} autoFocus={mode !== initialMode} />
      )}
      {error ? (
        <Banner tone="danger" role="alert">
          {t('access.apps.loadFailed')}
        </Banner>
      ) : grants && ordered.length === 0 ? (
        <p className="text-sm text-text-muted">{t('access.apps.empty')}</p>
      ) : (
        <ul className="flex flex-col" data-testid="connected-apps">
          {ordered.map((grant) => (
            <GrantRow
              key={grant.id}
              grant={grant}
              orgs={orgs}
              prefs={prefs}
              now={now}
              mode={mode}
              setMode={setMode}
              onUpdate={onUpdate}
              onRevoke={onRevoke}
              confirmedOrgs={confirmedOrgs}
              confirmOrgs={confirmOrgs}
            />
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

function GrantRow({
  grant,
  orgs,
  prefs,
  now,
  mode,
  setMode,
  onUpdate,
  onRevoke,
  confirmedOrgs,
  confirmOrgs,
}: {
  grant: Grant;
  orgs: readonly GrantOrgOption[];
  confirmedOrgs: readonly GrantOrgOption[] | undefined;
  confirmOrgs: (() => Promise<readonly GrantOrgOption[]>) | undefined;
  prefs: DisplayPrefs;
  now: number;
  mode: ConnectedAppsMode;
  setMode: (mode: ConnectedAppsMode) => void;
  onUpdate: (id: string, patch: GrantPatch) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [pending, setPending] = useState(false);
  const Icon = kindIcons[grant.kind];
  const editing = mode.kind === 'editing' && mode.id === grant.id;
  const confirming = mode.kind === 'confirming' && mode.id === grant.id;
  const expired = grant.expiresAt !== null && grant.expiresAt <= now;
  const meta = [
    t('access.apps.created', { date: formatGrantDate(grant.createdAt, prefs, now) }),
    grant.lastUsedAt === null
      ? t('access.apps.neverUsed')
      : grant.lastUsedIp
        ? t('access.apps.lastUsedFrom', {
            when: formatTimeAgo(grant.lastUsedAt, now, prefs.locale, t('security.justNow')),
            ip: grant.lastUsedIp,
          })
        : t('access.apps.lastUsed', {
            when: formatTimeAgo(grant.lastUsedAt, now, prefs.locale, t('security.justNow')),
          }),
    grant.expiresAt === null
      ? t('access.apps.neverExpires')
      : expired
        ? t('access.apps.expiredOn', { date: formatGrantDate(grant.expiresAt, prefs, now) })
        : t('access.apps.expires', { date: formatGrantDate(grant.expiresAt, prefs, now) }),
  ];

  return (
    <li
      className="flex flex-col gap-3 border-b border-border py-3 last:border-b-0"
      data-testid={`grant-${grant.id}`}
    >
      <div className="flex flex-col gap-3 tablet:flex-row tablet:items-start">
        <div className="flex min-w-0 flex-1 gap-3">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-muted text-text-secondary">
            <Icon className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">{grant.label}</span>
              <Chip>{t(`access.kind.${grant.kind}`)}</Chip>
              {grant.current && <Chip color="green">{t('security.thisDevice')}</Chip>}
              {expired && <Chip color="red">{t('access.apps.expired')}</Chip>}
              {grant.tokenPrefix && (
                <span className="font-mono text-xs text-text-muted">{grant.tokenPrefix}…</span>
              )}
            </span>
            <span className="text-sm text-text-secondary">
              {describeScopes(grant.scopes, t, prefs.locale)}
            </span>
            <span className="text-sm text-text-secondary">
              {describeWhere(grant, orgs, t, prefs.locale)}
            </span>
            <span className="text-sm text-text-muted">{meta.join(' · ')}</span>
          </div>
        </div>
        {!editing && !confirming && (
          <div className="flex shrink-0 gap-1">
            <Button
              variant="ghost"
              size="sm"
              onPress={() => setMode({ kind: 'editing', id: grant.id })}
              aria-label={t('access.apps.editNamed', { name: grant.label })}
            >
              {t('access.apps.edit')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onPress={() => setMode({ kind: 'confirming', id: grant.id })}
              aria-label={t('access.apps.revokeNamed', { name: grant.label })}
            >
              {t('access.apps.revoke')}
            </Button>
          </div>
        )}
      </div>
      {confirming && (
        <InlinePanel onEscape={() => setMode({ kind: 'idle' })}>
          <fieldset
            aria-label={t('access.apps.revokeNamed', { name: grant.label })}
            className="flex flex-col gap-3 rounded-md bg-bg-danger-subtle px-3 py-3 tablet:flex-row tablet:items-center"
          >
            <p className="flex-1 text-sm text-text-danger">
              {grant.current
                ? t('access.apps.revokeCurrent', { name: grant.label })
                : t('access.apps.revokeConfirm', { name: grant.label })}
            </p>
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="sm"
                isLoading={pending}
                autoFocus
                onPress={async () => {
                  setPending(true);
                  try {
                    await onRevoke(grant.id);
                    setMode({ kind: 'idle' });
                  } catch {
                    // The caller reports the failure; the confirm stays open to retry.
                  } finally {
                    setPending(false);
                  }
                }}
                data-testid="confirm-revoke"
              >
                {t('access.apps.revoke')}
              </Button>
              <Button size="sm" onPress={() => setMode({ kind: 'idle' })}>
                {t('access.cancel')}
              </Button>
            </div>
          </fieldset>
        </InlinePanel>
      )}
      {editing && (
        <EditGrant
          grant={grant}
          orgs={orgs}
          confirmedOrgs={confirmedOrgs}
          confirmOrgs={confirmOrgs}
          prefs={prefs}
          now={now}
          onCancel={() => setMode({ kind: 'idle' })}
          onSave={async (patch) => {
            await onUpdate(grant.id, patch);
            setMode({ kind: 'idle' });
          }}
        />
      )}
    </li>
  );
}

/** Escape closes an inline panel (02 §1: no modals, but the same way out). */
function InlinePanel({ children, onEscape }: { children: ReactNode; onEscape: () => void }) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.stopPropagation();
      onEscape();
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape bubbles up from the panel's controls
    <div onKeyDown={onKeyDown}>{children}</div>
  );
}

function EditGrant({
  grant,
  orgs,
  confirmedOrgs,
  confirmOrgs,
  prefs,
  now,
  onCancel,
  onSave,
}: {
  grant: Grant;
  orgs: readonly GrantOrgOption[];
  confirmedOrgs: readonly GrantOrgOption[] | undefined;
  confirmOrgs: (() => Promise<readonly GrantOrgOption[]>) | undefined;
  prefs: DisplayPrefs;
  now: number;
  onCancel: () => void;
  onSave: (patch: GrantPatch) => Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [edited, setEdited] = useState<GrantValue>(() => valueFromGrant(grant));
  // Orgs left and groups deleted since the grant was made would fail any save (422). Only
  // what the server confirms missing is dropped, and only from what is sent: the edits keep
  // every id, so a removal never outlives data that shows the group exists.
  // The note: what the latest confirmation misses that this tab does not show either (a group
  // created a moment ago is in the picker before the confirmation catches up).
  const { value, stale } = reconcileGrant(edited, knownOrgs(confirmedOrgs ?? [], orgs));
  const [label, setLabel] = useState(grant.label);
  const [pending, setPending] = useState(false);
  const [saveIssue, setSaveIssue] = useState<GrantIssue | null>(null);
  const blocked = grantIssues(value).length > 0 || label.trim() === '';
  return (
    <InlinePanel onEscape={onCancel}>
      <form
        className="flex flex-col gap-6 rounded-md border border-border bg-bg-elevated p-4"
        aria-label={t('access.apps.editNamed', { name: grant.label })}
        onSubmit={async (event) => {
          event.preventDefault();
          if (blocked) return;
          setPending(true);
          setSaveIssue(null);
          try {
            // Re-confirm right before pruning: fetch fresh, prune what is confirmed missing,
            // send. Without a confirmation nothing is pruned (the server answers).
            const fresh = confirmOrgs ? await confirmOrgs() : [];
            const toSend = reconcileGrant(edited, fresh).value;
            const [issue] = grantIssues(toSend);
            if (issue) {
              setSaveIssue(issue);
              return;
            }
            await onSave(toGrantPatch(toSend, Date.now(), label));
          } catch {
            // The caller reports the failure; the form keeps the edits.
          } finally {
            setPending(false);
          }
        }}
        data-testid="edit-grant"
      >
        {grant.kind === 'oauth' && <Banner>{t('access.apps.narrowOnly')}</Banner>}
        {(stale.orgs > 0 || stale.groups > 0) && (
          <Banner tone="warning" role="status">
            {[
              stale.groups > 0 ? t('access.apps.staleGroups', { count: stale.groups }) : null,
              stale.orgs > 0 ? t('access.apps.staleOrgs', { count: stale.orgs }) : null,
            ]
              .filter(Boolean)
              .join(' ')}
          </Banner>
        )}
        <ConstraintEditor
          value={edited}
          onChange={setEdited}
          orgs={orgs}
          ceiling={ceilingForGrant(grant)}
          currentExpiresAt={grant.expiresAt}
          prefs={prefs}
          now={now}
        >
          <TextField
            label={t('access.apps.name')}
            value={label}
            onChange={setLabel}
            maxLength={100}
            isRequired
            autoFocus
          />
        </ConstraintEditor>
        {saveIssue && (
          <p role="alert" className="text-sm text-text-danger">
            {t(
              saveIssue.kind === 'noScopes'
                ? 'access.issue.noScopes'
                : saveIssue.kind === 'noOrgs'
                  ? 'access.issue.noOrgs'
                  : 'access.issue.noGroups',
            )}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" isLoading={pending} isDisabled={blocked}>
            {t('access.apps.save')}
          </Button>
          <Button onPress={onCancel}>{t('access.cancel')}</Button>
        </div>
      </form>
    </InlinePanel>
  );
}

export function NewTokenForm({
  orgs,
  prefs,
  now,
  onCancel,
  onCreate,
  initialValue,
}: {
  orgs: readonly GrantOrgOption[];
  prefs: DisplayPrefs;
  now: number;
  onCancel: () => void;
  onCreate: (input: TokenCreate) => Promise<void>;
  initialValue?: GrantValue | undefined;
}) {
  const { t } = useTranslation('settings');
  const [value, setValue] = useState<GrantValue>(() => initialValue ?? defaultTokenValue(orgs));
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const blocked = grantIssues(value).length > 0 || name.trim() === '';
  return (
    <InlinePanel onEscape={onCancel}>
      <form
        className="flex flex-col gap-6 rounded-md border border-border bg-bg-elevated p-4"
        aria-label={t('access.apps.newToken')}
        onSubmit={async (event) => {
          event.preventDefault();
          if (blocked) return;
          setPending(true);
          try {
            await onCreate(toTokenCreate(value, name));
          } catch {
            // The caller reports the failure; the form keeps what was typed.
          } finally {
            setPending(false);
          }
        }}
        data-testid="new-token-form"
      >
        <ConstraintEditor value={value} onChange={setValue} orgs={orgs} prefs={prefs} now={now}>
          <TextField
            label={t('access.apps.name')}
            description={t('access.apps.nameHint')}
            value={name}
            onChange={setName}
            maxLength={100}
            isRequired
            autoFocus
          />
        </ConstraintEditor>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" isLoading={pending} isDisabled={blocked}>
            {t('access.apps.create')}
          </Button>
          <Button onPress={onCancel}>{t('access.cancel')}</Button>
        </div>
      </form>
    </InlinePanel>
  );
}

/** The new token, once: copy it now, it is never shown again. */
export function TokenReveal({
  created,
  onDone,
  autoFocus = true,
}: {
  created: CreatedToken;
  onDone: () => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation('settings');
  const [copied, setCopied] = useState(false);
  const fieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    fieldRef.current?.focus();
    fieldRef.current?.select();
  }, [autoFocus]);
  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border bg-bg-elevated p-4"
      data-testid="token-reveal"
    >
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">
          {t('access.reveal.title', { name: created.grant.label })}
        </p>
        <Banner tone="warning">{t('access.reveal.once')}</Banner>
      </div>
      <div className="flex flex-col gap-2 tablet:flex-row">
        <Input
          ref={fieldRef}
          readOnly
          value={created.token}
          aria-label={t('access.reveal.label')}
          className={cn(inputVariants(), 'font-mono')}
          onFocus={(event) => event.currentTarget.select()}
          data-testid="token-value"
        />
        <Button
          icon={Copy}
          onPress={async () => {
            try {
              await navigator.clipboard.writeText(created.token);
              setCopied(true);
            } catch {
              fieldRef.current?.select();
            }
          }}
        >
          {copied ? t('access.reveal.copied') : t('access.reveal.copy')}
        </Button>
      </div>
      <div>
        <Button variant="primary" onPress={onDone}>
          {t('access.reveal.done')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The confirmed orgs, each with the groups either source knows: for the note only, so a group
 * this tab already shows is never announced as deleted while the confirmation catches up.
 */
function knownOrgs(
  confirmed: readonly GrantOrgOption[],
  cached: readonly GrantOrgOption[],
): GrantOrgOption[] {
  return confirmed.map((org) => {
    const local = cached.find((c) => c.id === org.id)?.groups;
    if (!org.groups || !local) return org;
    const ids = new Set(org.groups.map((g) => g.id));
    return { ...org, groups: [...org.groups, ...local.filter((g) => !ids.has(g.id))] };
  });
}
