import { isLocale } from '@rooster/i18n/core';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DisplayPrefs } from '../../lib/format';
import { Group, Section } from '../dev-ui/layout';
import { LinkedIdentitiesSection } from '../settings/linked-identities';
import { ConnectedAppsSection, NewTokenForm } from './connected-apps';
import { ConsentPage, type ConsentPageState } from './consent-page';
import { ConstraintEditor } from './constraint-editor';
import { DevicePage, type DevicePageState } from './device-page';
import {
  fixtureConsentRequests,
  fixtureGrantOrgs,
  fixtureGrants,
  fixtureGroupIds,
  fixtureIdentities,
  fixtureUserCode,
} from './fixtures';
import { ceilingForGrant, defaultTokenValue, type GrantValue, valueFromGrant } from './grant-model';

const noop = async () => undefined;

/**
 * Kitchen-sink entries for agent access (P8 WP 8.2, P9 WP 9.3/9.6): the editor, `/device`,
 * the OAuth consent screen, Connected apps and the linked sign-in identities.
 */
export function AccessKitchenSection() {
  const { t, i18n } = useTranslation('settings');
  const locale = isLocale(i18n.language) ? i18n.language : 'en';
  const prefs: DisplayPrefs = {
    locale,
    timezone: 'Europe/Stockholm',
    dateFormat: locale === 'sv' ? 'd MMM' : 'MMM d',
    timeFormat: locale === 'sv' ? '24h' : '12h',
  };
  const now = useMemo(() => Date.now(), []);
  const grants = useMemo(() => fixtureGrants(now), [now]);
  const oauth = grants.find((g) => g.kind === 'oauth');
  const orgs = fixtureGrantOrgs;

  const [free, setFree] = useState<GrantValue>(() => ({
    ...defaultTokenValue(orgs),
    scopes: ['tasks:write'],
    constraints: {
      orgs: [
        { orgId: orgs[0]?.id ?? '', read: 'all', write: 'none' },
        { orgId: orgs[1]?.id ?? '', read: 'all', write: { groups: [fixtureGroupIds.companyPrio] } },
      ],
    },
  }));
  const [narrow, setNarrow] = useState<GrantValue>(() =>
    oauth ? valueFromGrant(oauth) : defaultTokenValue(orgs),
  );
  const [phone, setPhone] = useState<GrantValue>(() => defaultTokenValue(orgs));

  const request = {
    userCode: fixtureUserCode,
    clientId: 'rooster-cli',
    clientName: 'rooster CLI',
    requestedScopes: [
      'tasks:delete',
      'comments:write',
      'groups:write',
      'tasks:assign',
      'notifications:read',
    ] as const,
    expiresAt: now + 10 * 60 * 1000,
  };
  const deviceStates: [string, DevicePageState][] = [
    [t('access.dev.deviceEnter'), { kind: 'enter' }],
    [t('access.dev.deviceExpired'), { kind: 'enter', code: fixtureUserCode, error: 'expired' }],
    [
      t('access.dev.deviceRequest'),
      { kind: 'request', request: { ...request, requestedScopes: [...request.requestedScopes] } },
    ],
    [t('access.dev.deviceApproved'), { kind: 'approved', clientName: request.clientName }],
    [t('access.dev.deviceDenied'), { kind: 'denied', clientName: request.clientName }],
  ];
  const created = grants[1];
  const consent = useMemo(() => fixtureConsentRequests(now), [now]);
  const consentStates: [string, ConsentPageState][] = [
    [t('access.dev.consentVerified'), { kind: 'request', request: consent.verified }],
    [t('access.dev.consentDynamic'), { kind: 'request', request: consent.dynamic }],
    [t('access.dev.consentLoopback'), { kind: 'request', request: consent.loopback }],
    [t('access.dev.consentStepUp'), { kind: 'request', request: consent.stepUp }],
    [t('access.dev.consentInvalid'), { kind: 'invalid' }],
    [t('access.dev.consentFailed'), { kind: 'failed' }],
    [t('access.dev.consentLoading'), { kind: 'loading' }],
    [
      t('access.dev.consentLeaving'),
      { kind: 'leaving', accepted: true, clientName: consent.verified.client.name },
    ],
  ];
  const identities = useMemo(() => fixtureIdentities(now), [now]);
  const unlinked = async () => 'unlinked' as const;

  return (
    <Section id="access" title={t('access.dev.section')}>
      <Group title={t('access.dev.editor')} className="block">
        <div className="max-w-pane">
          <ConstraintEditor value={free} onChange={setFree} orgs={orgs} prefs={prefs} now={now} />
        </div>
      </Group>
      <Group title={t('access.dev.narrowOnly')} className="block">
        <div className="max-w-pane">
          {oauth && (
            <ConstraintEditor
              value={narrow}
              onChange={setNarrow}
              orgs={orgs}
              ceiling={ceilingForGrant(oauth)}
              newScopes={['tasks:write']}
              currentExpiresAt={oauth.expiresAt}
              prefs={prefs}
              now={now}
            />
          )}
        </div>
      </Group>
      <Group title={t('access.dev.phone')} className="block">
        <div className="max-w-pane-min rounded-lg border border-border bg-bg-app p-3">
          <ConstraintEditor value={phone} onChange={setPhone} orgs={orgs} prefs={prefs} now={now} />
        </div>
      </Group>
      <Group title={t('access.dev.device')} className="grid gap-6 desktop:grid-cols-2">
        {deviceStates.map(([label, state]) => (
          <figure key={label} className="flex flex-col gap-2">
            <DevicePage
              state={state}
              account="jannik@example.com"
              orgs={orgs}
              prefs={prefs}
              now={now}
              onSubmitCode={() => undefined}
              onApprove={noop}
              onDeny={noop}
              homeHref="#access"
              embedded
            />
            <figcaption className="text-xs text-text-muted">{label}</figcaption>
          </figure>
        ))}
      </Group>
      <Group title={t('access.dev.deviceAdmin')} className="block">
        <div className="max-w-pane">
          <DevicePage
            state={{
              kind: 'request',
              request: { ...request, requestedScopes: ['tasks:write', 'admin'] },
            }}
            account="jannik@example.com"
            isAdmin
            orgs={orgs}
            prefs={prefs}
            now={now}
            onSubmitCode={() => undefined}
            onApprove={noop}
            onDeny={noop}
            homeHref="#access"
            embedded
          />
        </div>
      </Group>
      <Group title={t('access.dev.consent')} className="grid gap-6 desktop:grid-cols-2">
        {consentStates.map(([label, state]) => (
          <figure key={label} className="flex flex-col gap-2">
            <ConsentPage
              state={state}
              account="jannik@example.com"
              orgs={orgs}
              prefs={prefs}
              now={now}
              onAllow={noop}
              onDeny={noop}
              onRetry={() => undefined}
              homeHref="#access"
              embedded
            />
            <figcaption className="text-xs text-text-muted">{label}</figcaption>
          </figure>
        ))}
      </Group>
      <Group title={t('access.dev.newTokenAdmin')} className="block">
        <div className="max-w-pane-max">
          <NewTokenForm
            orgs={orgs}
            offerAdmin
            prefs={prefs}
            now={now}
            onCancel={() => undefined}
            onCreate={noop}
          />
        </div>
      </Group>
      <Group title={t('access.dev.identities')} className="grid gap-6 desktop:grid-cols-3">
        <div className="max-w-pane-max">
          <LinkedIdentitiesSection
            identities={identities}
            prefs={prefs}
            now={now}
            onUnlink={unlinked}
          />
        </div>
        <figure className="flex max-w-pane-max flex-col gap-2">
          <LinkedIdentitiesSection
            identities={identities.slice(0, 1)}
            prefs={prefs}
            now={now}
            onUnlink={async () => 'lastIdentity' as const}
          />
          <figcaption className="text-xs text-text-muted">
            {t('access.dev.identitiesLast')}
          </figcaption>
        </figure>
        <figure className="flex max-w-pane-max flex-col gap-2">
          <LinkedIdentitiesSection
            identities={identities}
            prefs={prefs}
            now={now}
            onUnlink={unlinked}
            initialConfirmingId={identities[1]?.id}
          />
          <figcaption className="text-xs text-text-muted">
            {t('access.dev.identitiesConfirm')}
          </figcaption>
        </figure>
      </Group>
      <Group title={t('access.dev.apps')} className="block">
        <div className="max-w-pane-max">
          <ConnectedAppsSection
            id="dev-connected-apps"
            grants={grants}
            orgs={orgs}
            prefs={prefs}
            now={now}
            onCreateToken={async () => {
              throw new Error('kitchen sink');
            }}
            onUpdate={noop}
            onRevoke={noop}
          />
        </div>
      </Group>
      <Group title={t('access.dev.tokenCreated')} className="block">
        <div className="max-w-pane-max">
          {created && (
            <ConnectedAppsSection
              id="dev-token-created"
              grants={grants.slice(0, 2)}
              orgs={orgs}
              prefs={prefs}
              now={now}
              initialMode={{
                kind: 'created',
                created: { token: 'rooster_pat_ab12Xk9fQ2mLr7TzW4vHsN8cJd3Pe6Yb', grant: created },
              }}
              onCreateToken={async () => {
                throw new Error('kitchen sink');
              }}
              onUpdate={noop}
              onRevoke={noop}
            />
          )}
        </div>
      </Group>
      <Group title={t('access.dev.empty')} className="block">
        <div className="max-w-pane-max">
          <ConnectedAppsSection
            id="dev-apps-empty"
            grants={[]}
            orgs={orgs}
            prefs={prefs}
            now={now}
            onCreateToken={async () => {
              throw new Error('kitchen sink');
            }}
            onUpdate={noop}
            onRevoke={noop}
          />
        </div>
      </Group>
    </Section>
  );
}
