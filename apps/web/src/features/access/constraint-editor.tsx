import type { GrantScope } from '@rooster/core/grants';
import { type ReactNode, useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { DisplayPrefs } from '../../lib/format';
import { Banner } from '../../ui/banner';
import { Select } from '../../ui/select';
import { ChoiceGroup, FormCheckbox } from './controls';
import {
  EXPIRY_DAY_CHOICES,
  type ExpiryChoice,
  type GrantCeiling,
  type GrantIssue,
  type GrantOrgOption,
  type GrantValue,
  grantIssues,
  hasWriteScope,
  offeredScopes,
  type ReadMode,
  readMode,
  scopeState,
  setAllOrgs,
  setExpiry,
  setOrgIncluded,
  setReadGroups,
  setReadMode,
  setWriteGroups,
  setWriteMode,
  toggleScope,
  type WriteMode,
  withinCeiling,
  writeMode,
  writesNothing,
} from './grant-model';
import { formatGrantDate, scopeKeys } from './grant-summary';
import { GrantSummary } from './grant-summary-view';
import { GroupPicker } from './group-picker';

export interface ConstraintEditorProps {
  value: GrantValue;
  onChange: (value: GrantValue) => void;
  /** The user's orgs in sidebar order, each with its groups (Inbox first). */
  orgs: readonly GrantOrgOption[];
  /**
   * Nothing beyond this can be chosen: the requested scopes on `/device`, the current grant
   * when narrowing an OAuth grant (11 §3.1–3.2). Scopes outside it are not offered.
   */
  ceiling?: GrantCeiling | undefined;
  /** Scopes a client adds on step-up (P9), marked "New". */
  newScopes?: readonly GrantScope[] | undefined;
  /** Editing: the grant's current expiry, offered as "Keep". Undefined hides "Keep". */
  currentExpiresAt?: number | null | undefined;
  /** Hides the expiry select. */
  hideExpiry?: boolean | undefined;
  /** Offers "This session only" (the OAuth consent screen, 11 §2.4). */
  offerSessionOnly?: boolean | undefined;
  /** Offers the `admin` capability: instance admins only (ADR 0041/0042). */
  offerAdmin?: boolean | undefined;
  /**
   * The consent pages (`/oauth/consent`, `/device`): deleting is not one capability among
   * others but its own "Allow deleting tasks" checkbox below them, shown only when the client
   * asked for it (ADR 0041/0042 §4).
   */
  deleteCheckbox?: boolean | undefined;
  prefs: DisplayPrefs;
  now: number;
  /** Extra fields above the capabilities, e.g. a token name. */
  children?: ReactNode;
  'data-testid'?: string;
}

/**
 * The consent and constraint editor (11 §3.1): what a credential may do (scopes), where (orgs
 * and groups), and for how long, with a live summary. Shared by `/device`, new tokens, editing
 * in Settings → Connected apps and (P9) the OAuth consent screen. Not a modal (hard rule 9).
 */
export function ConstraintEditor({
  value,
  onChange,
  orgs,
  ceiling,
  newScopes,
  currentExpiresAt,
  hideExpiry = false,
  offerSessionOnly = false,
  offerAdmin = false,
  deleteCheckbox = false,
  prefs,
  now,
  children,
  'data-testid': testId,
}: ConstraintEditorProps) {
  const { t } = useTranslation('settings');
  const scopesId = useId();
  const whereId = useId();
  const can = (next: GrantValue) => withinCeiling(next, ceiling);
  const issues = grantIssues(value);
  const writes = hasWriteScope(value.scopes);
  const list = value.constraints.orgs;
  const allOrgs = list === 'all';
  const allOrgsAllowed = can(setAllOrgs(value, orgs, true));
  const offered = offeredScopes(ceiling, { admin: offerAdmin });
  const listed = deleteCheckbox ? offered.filter((scope) => scope !== 'tasks:delete') : offered;
  const deleteOffered = deleteCheckbox && offered.includes('tasks:delete');
  const deleteState = scopeState(value.scopes, 'tasks:delete');

  return (
    <div className="flex flex-col gap-6" {...(testId ? { 'data-testid': testId } : {})}>
      {children}

      <fieldset aria-labelledby={scopesId} className="flex flex-col gap-2">
        <legend id={scopesId} className="mb-1 text-base font-medium">
          {t('access.editor.capabilities')}
        </legend>
        {listed.map((scope) => {
          const state = scopeState(value.scopes, scope);
          const key = scopeKeys[scope];
          const next = toggleScope(value, scope, state === 'off', orgs);
          return (
            <FormCheckbox
              key={scope}
              isSelected={state !== 'off'}
              isDisabled={state === 'implied' || !can(next)}
              onChange={(on) => onChange(toggleScope(value, scope, on, orgs))}
              description={t(`access.scope.${key}.description`)}
              data-testid={`scope-${scope}`}
              aside={
                <>
                  {state === 'implied' && (
                    <span className="text-xs text-text-muted">{t('access.editor.included')}</span>
                  )}
                  {newScopes?.includes(scope) && (
                    <span className="rounded-xs bg-bg-accent-subtle px-1.5 text-xs font-medium text-text">
                      {t('access.editor.new')}
                    </span>
                  )}
                </>
              }
            >
              {t(`access.scope.${key}.label`)}
            </FormCheckbox>
          );
        })}
        {issues.some((i) => i.kind === 'noScopes') && (
          <IssueText>{t('access.issue.noScopes')}</IssueText>
        )}
      </fieldset>

      {deleteOffered && (
        <div className="rounded-md border border-border px-3 py-1.5">
          <FormCheckbox
            isSelected={deleteState !== 'off'}
            isDisabled={!can(toggleScope(value, 'tasks:delete', deleteState === 'off', orgs))}
            onChange={(on) => onChange(toggleScope(value, 'tasks:delete', on, orgs))}
            description={t('access.editor.allowDeleteHint')}
            data-testid="allow-delete"
            aside={
              newScopes?.includes('tasks:delete') && (
                <span className="rounded-xs bg-bg-accent-subtle px-1.5 text-xs font-medium text-text">
                  {t('access.editor.new')}
                </span>
              )
            }
          >
            {t('access.editor.allowDelete')}
          </FormCheckbox>
        </div>
      )}

      <fieldset aria-labelledby={whereId} className="flex flex-col gap-3">
        <legend id={whereId} className="mb-1 text-base font-medium">
          {t('access.editor.where')}
        </legend>
        <p className="mb-1 text-sm text-text-muted">{t('access.editor.whereHint')}</p>
        <FormCheckbox
          isSelected={allOrgs}
          isDisabled={!allOrgs && !allOrgsAllowed}
          onChange={(on) => onChange(setAllOrgs(value, orgs, on))}
          description={t('access.editor.allOrgsHint')}
          data-testid="all-orgs"
        >
          {t('access.editor.allOrgs')}
        </FormCheckbox>
        {!allOrgs && (
          <ul className="flex flex-col gap-3">
            {orgs.map((org) => {
              const grant = list.find((o) => o.orgId === org.id);
              const included = grant !== undefined;
              return (
                <li key={org.id} className="flex flex-col gap-3" data-testid={`org-${org.id}`}>
                  <FormCheckbox
                    isSelected={included}
                    isDisabled={!included && !can(setOrgIncluded(value, orgs, org.id, true))}
                    onChange={(on) => onChange(setOrgIncluded(value, orgs, org.id, on))}
                  >
                    {org.name}
                  </FormCheckbox>
                  {grant && (
                    <OrgControls
                      org={org}
                      value={value}
                      orgs={orgs}
                      writes={writes}
                      issues={issues}
                      can={can}
                      onChange={onChange}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {issues.some((i) => i.kind === 'noOrgs') && (
          <IssueText>{t('access.issue.noOrgs')}</IssueText>
        )}
        {writesNothing(value) && <Banner tone="warning">{t('access.editor.writesNothing')}</Banner>}
      </fieldset>

      {!hideExpiry && (
        <ExpirySelect
          narrowOnly={Boolean(ceiling?.constraints)}
          offerSessionOnly={offerSessionOnly}
          value={value.expiry}
          onChange={(expiry) => onChange(setExpiry(value, expiry))}
          currentExpiresAt={currentExpiresAt}
          prefs={prefs}
          now={now}
        />
      )}

      <GrantSummary value={value} orgs={orgs} locale={prefs.locale} />
    </div>
  );
}

function IssueText({ children }: { children: ReactNode }) {
  return <p className="text-sm text-text-danger">{children}</p>;
}

function OrgControls({
  org,
  value,
  orgs,
  writes,
  issues,
  can,
  onChange,
}: {
  org: GrantOrgOption;
  value: GrantValue;
  orgs: readonly GrantOrgOption[];
  writes: boolean;
  issues: readonly GrantIssue[];
  can: (next: GrantValue) => boolean;
  onChange: (value: GrantValue) => void;
}) {
  const { t } = useTranslation('settings');
  const list = value.constraints.orgs;
  const grant = list === 'all' ? undefined : list.find((o) => o.orgId === org.id);
  if (!grant) return null;
  const read = readMode(grant.read);
  const write = writeMode(grant.write);
  const readGroups = grant.read === 'all' ? [] : grant.read.groups;
  const writeGroups = grant.write === 'all' || grant.write === 'none' ? [] : grant.write.groups;
  // Changing everything needs reading everything (`withWriteImpliesRead`).
  const readNeeded = writes && write === 'all';
  const hasIssue = (kind: GrantIssue['kind']) =>
    issues.some((i) => i.kind === kind && 'orgId' in i && i.orgId === org.id);

  const blocked = (
    selected: readonly string[],
    apply: (groups: string[]) => GrantValue,
  ): string[] =>
    (org.groups ?? [])
      .filter((g) => !selected.includes(g.id) && !can(apply([...selected, g.id])))
      .map((g) => g.id);

  const readOptions: { id: ReadMode; label: string }[] = [
    { id: 'all', label: t('access.editor.everything') },
    { id: 'groups', label: t('access.editor.onlyGroups') },
  ];
  const writeOptions: { id: WriteMode; label: string }[] = [
    { id: 'none', label: t('access.editor.nothing') },
    { id: 'all', label: t('access.editor.everything') },
    { id: 'groups', label: t('access.editor.onlyGroups') },
  ];

  return (
    <div className="ms-2 flex flex-col gap-3 border-s border-border ps-4">
      <div className="flex flex-col gap-2">
        <ChoiceGroup
          label={t('access.editor.read')}
          value={read}
          options={readOptions.map((o) => ({
            ...o,
            isDisabled:
              o.id !== read && (readNeeded || !can(setReadMode(value, orgs, org.id, o.id))),
          }))}
          onChange={(mode) => onChange(setReadMode(value, orgs, org.id, mode))}
          data-testid={`read-${org.id}`}
        />
        {readNeeded && (
          <p className="text-sm text-text-muted">{t('access.editor.readAllForWrite')}</p>
        )}
        {read === 'groups' && (
          <div className="flex flex-col gap-1.5">
            <GroupPicker
              label={t('access.editor.readGroups', { org: org.name })}
              groups={org.groups}
              selected={readGroups}
              disabledIds={blocked(readGroups, (g) => setReadGroups(value, orgs, org.id, g))}
              onChange={(groups) => onChange(setReadGroups(value, orgs, org.id, groups))}
              data-testid={`read-groups-${org.id}`}
            />
            {hasIssue('noReadGroups') && <IssueText>{t('access.issue.noGroups')}</IssueText>}
          </div>
        )}
      </div>
      {writes && (
        <div className="flex flex-col gap-2">
          <ChoiceGroup
            label={t('access.editor.write')}
            value={write}
            options={writeOptions.map((o) => ({
              ...o,
              isDisabled: o.id !== write && !can(setWriteMode(value, orgs, org.id, o.id)),
            }))}
            onChange={(mode) => onChange(setWriteMode(value, orgs, org.id, mode))}
            data-testid={`write-${org.id}`}
          />
          {write === 'groups' && (
            <div className="flex flex-col gap-1.5">
              <GroupPicker
                label={t('access.editor.writeGroups', { org: org.name })}
                groups={org.groups}
                selected={writeGroups}
                disabledIds={blocked(writeGroups, (g) => setWriteGroups(value, orgs, org.id, g))}
                onChange={(groups) => onChange(setWriteGroups(value, orgs, org.id, groups))}
                data-testid={`write-groups-${org.id}`}
              />
              {hasIssue('noWriteGroups') && <IssueText>{t('access.issue.noGroups')}</IssueText>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function ExpirySelect({
  narrowOnly,
  offerSessionOnly,
  value,
  onChange,
  currentExpiresAt,
  prefs,
  now,
}: {
  /** Narrowing an app's grant: no expiry later than the current one (the server refuses it). */
  narrowOnly: boolean;
  offerSessionOnly: boolean;
  value: ExpiryChoice;
  onChange: (value: ExpiryChoice) => void;
  currentExpiresAt: number | null | undefined;
  prefs: DisplayPrefs;
  now: number;
}) {
  const { t } = useTranslation('settings');
  type Key = 'keep' | 'never' | 'session' | `${(typeof EXPIRY_DAY_CHOICES)[number]}`;
  const options: { id: Key; label: string }[] = [
    ...(offerSessionOnly ? [{ id: 'session' as const, label: t('access.expiry.session') }] : []),
    ...(currentExpiresAt !== undefined
      ? [
          {
            id: 'keep' as const,
            label:
              currentExpiresAt === null
                ? t('access.expiry.keepNever')
                : t('access.expiry.keep', { date: formatGrantDate(currentExpiresAt, prefs, now) }),
          },
        ]
      : []),
    ...EXPIRY_DAY_CHOICES.filter(
      (days) => !narrowOnly || !currentExpiresAt || now + days * DAY_MS <= currentExpiresAt,
    ).map((days) => ({
      id: `${days}` as Key,
      label: days === 365 ? t('access.expiry.year') : t('access.expiry.days', { count: days }),
    })),
    ...(narrowOnly && currentExpiresAt
      ? []
      : [{ id: 'never' as const, label: t('access.expiry.never') }]),
  ];
  return (
    <Select<Key>
      label={t('access.expiry.label')}
      options={options}
      value={String(value) as Key}
      onChange={(key) =>
        onChange(
          key === 'keep' || key === 'never' || key === 'session'
            ? key
            : (Number(key) as ExpiryChoice),
        )
      }
      className="tablet:max-w-date-popover"
    />
  );
}
