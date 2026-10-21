import { isNarrowing } from '@rooster/core/grants';
import { getI18n } from 'react-i18next';
import { describe, expect, test } from 'vitest';
import { fixtureIds } from '../shell/fixtures';
import { fixtureGrantOrgs, fixtureGrants, fixtureGroupIds as g } from './fixtures';
import {
  ceilingForGrant,
  defaultDeviceValue,
  defaultTokenValue,
  formatUserCode,
  type GrantValue,
  grantIssues,
  normalizeConstraints,
  normalizeUserCode,
  offeredScopes,
  reconcileGrant,
  scopeState,
  setAllOrgs,
  setOrgIncluded,
  setReadGroups,
  setReadMode,
  setWriteGroups,
  setWriteMode,
  toDeviceApprove,
  toGrantPatch,
  toggleScope,
  tokenScopes,
  toTokenCreate,
  valueFromGrant,
  withinCeiling,
  withWriteImpliesRead,
  writesNothing,
} from './grant-model';
import { describeScopes, describeWhere, formatGrantDate } from './grant-summary';

const orgs = fixtureGrantOrgs;
const personal = fixtureIds.personalOrg;
const acme = fixtureIds.companyOrg;
const t = getI18n().getFixedT('en', 'settings');

describe('grant model', () => {
  test('a new token reads every current org (not future ones), writes nowhere, 90 days', () => {
    const value = defaultTokenValue(orgs);
    expect(toTokenCreate(value, '  Backup  ')).toEqual({
      name: 'Backup',
      scopes: ['tasks:read'],
      constraints: {
        orgs: [
          { orgId: personal, read: 'all', write: 'none' },
          { orgId: acme, read: 'all', write: 'none' },
        ],
      },
      expiresInDays: 90,
      audience: 'api',
    });
  });

  test('Phase 12: an MCP token says so and never carries admin (11 §9.7)', () => {
    const value = { ...defaultTokenValue(orgs), scopes: ['tasks:write', 'admin'] as const };
    const body = toTokenCreate({ ...value, scopes: [...value.scopes] }, 'Agent', 'mcp');
    expect(body.audience).toBe('mcp');
    expect(body.scopes).toEqual(['tasks:write']);
    expect(toTokenCreate({ ...value, scopes: [...value.scopes] }, 'Ops').scopes).toEqual([
      'tasks:write',
      'admin',
    ]);
    expect(tokenScopes(['admin'], 'mcp')).toEqual([]);
  });

  test('the device default is what the CLI asked for, everywhere, never expiring, delete unticked', () => {
    const value = defaultDeviceValue(['tasks:read', 'tasks:write', 'tasks:delete']);
    expect(toDeviceApprove(value, { decisionNonce: 'n' })).toEqual({
      decisionNonce: 'n',
      scopes: ['tasks:write'],
      constraints: { orgs: 'all' },
    });
    // 11 §9.3: never pre-ticked, for any client; asking for delete alone still starts writing.
    expect(defaultDeviceValue(['tasks:delete']).scopes).toEqual(['tasks:write']);
    expect(defaultDeviceValue(['tasks:read', 'admin'], { isAdmin: true }).scopes).toEqual([
      'tasks:read',
    ]);
    expect(defaultDeviceValue([]).scopes).toEqual(['tasks:read']);
  });

  test('implied scopes show as implied; unticking keeps what the scope implied', () => {
    let value = defaultTokenValue(orgs);
    value = toggleScope(value, 'tasks:delete', true, orgs);
    expect(value.scopes).toEqual(['tasks:delete']);
    expect(scopeState(value.scopes, 'tasks:read')).toBe('implied');
    expect(scopeState(value.scopes, 'tasks:write')).toBe('implied');
    expect(scopeState(value.scopes, 'tasks:delete')).toBe('on');
    expect(scopeState(value.scopes, 'comments:write')).toBe('off');
    value = toggleScope(value, 'tasks:delete', false, orgs);
    expect(value.scopes).toEqual(['tasks:write']);
  });

  test('the first write scope starts writing in the personal Inbox (11 §3.1)', () => {
    const value = toggleScope(defaultTokenValue(orgs), 'tasks:write', true, orgs);
    expect(value.constraints).toEqual({
      orgs: [
        { orgId: personal, read: 'all', write: { groups: [g.personalInbox] } },
        { orgId: acme, read: 'all', write: 'none' },
      ],
    });
    expect(writesNothing(value)).toBe(false);
    // Without a personal org in the grant it stays "nowhere", with a warning.
    const acmeOnly = setOrgIncluded(defaultTokenValue(orgs), orgs, personal, false);
    const writing = toggleScope(acmeOnly, 'tasks:write', true, orgs);
    expect(writesNothing(writing)).toBe(true);
  });

  test('org toggles keep the sidebar order; "all" expands to every org with full access', () => {
    let value = setAllOrgs(defaultDeviceValue(['tasks:write']), orgs, false);
    expect(value.constraints).toEqual({
      orgs: [
        { orgId: personal, read: 'all', write: 'all' },
        { orgId: acme, read: 'all', write: 'all' },
      ],
    });
    value = setOrgIncluded(value, orgs, personal, false);
    value = setOrgIncluded(value, orgs, personal, true);
    expect(value.constraints.orgs !== 'all' && value.constraints.orgs.map((o) => o.orgId)).toEqual([
      personal,
      acme,
    ]);
    expect(setAllOrgs(value, orgs, true).constraints).toEqual({ orgs: 'all' });
  });

  test('written groups are readable; unpicking a readable group stops writing there', () => {
    let value: GrantValue = { ...defaultTokenValue(orgs), scopes: ['tasks:write'] };
    value = setWriteMode(value, orgs, acme, 'groups');
    expect(grantIssues(value)).toEqual([{ kind: 'noWriteGroups', orgId: acme }]);
    value = setWriteGroups(value, orgs, acme, [g.companyPrio]);
    value = setReadMode(value, orgs, acme, 'groups');
    expect(value.constraints.orgs !== 'all' && value.constraints.orgs[1]).toEqual({
      orgId: acme,
      read: { groups: [g.companyPrio] },
      write: { groups: [g.companyPrio] },
    });
    value = setWriteGroups(value, orgs, acme, [g.companyPrio, g.companyToday]);
    value = setReadGroups(value, orgs, acme, [g.companyToday]);
    expect(value.constraints.orgs !== 'all' && value.constraints.orgs[1]).toEqual({
      orgId: acme,
      read: { groups: [g.companyToday] },
      write: { groups: [g.companyToday] },
    });
    value = setReadGroups(value, orgs, acme, []);
    expect(grantIssues(value)).toEqual([
      { kind: 'noReadGroups', orgId: acme },
      { kind: 'noWriteGroups', orgId: acme },
    ]);
    expect(setReadMode(value, orgs, acme, 'all').constraints).not.toEqual(value.constraints);
  });

  test('issues: no scopes, no orgs', () => {
    let value = toggleScope(defaultTokenValue(orgs), 'tasks:read', false, orgs);
    value = setOrgIncluded(setOrgIncluded(value, orgs, personal, false), orgs, acme, false);
    expect(grantIssues(value)).toEqual([{ kind: 'noScopes' }, { kind: 'noOrgs' }]);
  });

  test('without a write scope, write is sent as "none"', () => {
    const value: GrantValue = {
      scopes: ['tasks:read'],
      constraints: { orgs: [{ orgId: acme, read: 'all', write: 'all' }] },
      expiry: 'never',
    };
    expect(normalizeConstraints(value)).toEqual({
      orgs: [{ orgId: acme, read: 'all', write: 'none' }],
    });
    expect(toTokenCreate(value, 'x')).not.toHaveProperty('expiresInDays');
  });

  test('patches: keep leaves the expiry out, never clears it, days set it', () => {
    const grant = fixtureGrants(0)[1];
    if (!grant) throw new Error('fixture');
    const value = valueFromGrant(grant);
    expect(toGrantPatch(value, 1000)).not.toHaveProperty('expiresAt');
    expect(toGrantPatch({ ...value, expiry: 'never' }, 1000).expiresAt).toBeNull();
    expect(toGrantPatch({ ...value, expiry: 7 }, 1000, ' Renamed ')).toMatchObject({
      expiresAt: 1000 + 7 * 86_400_000,
      label: 'Renamed',
    });
  });

  test('narrow-only: OAuth grants may only shrink (isNarrowing); tokens change freely', () => {
    const [device, pat, oauth] = fixtureGrants(0);
    if (!device || !pat || !oauth) throw new Error('fixture');
    expect(ceilingForGrant(pat)).toBeUndefined();
    const ceiling = ceilingForGrant(oauth);
    const value = valueFromGrant(oauth);
    expect(withinCeiling(value, ceiling)).toBe(true);
    expect(offeredScopes(ceiling)).toEqual(['tasks:read', 'tasks:write']);
    expect(withinCeiling(toggleScope(value, 'tasks:delete', true, orgs), ceiling)).toBe(false);
    expect(withinCeiling(setOrgIncluded(value, orgs, acme, true), ceiling)).toBe(false);
    expect(withinCeiling(setAllOrgs(value, orgs, true), ceiling)).toBe(false);
    expect(withinCeiling(setWriteMode(value, orgs, personal, 'all'), ceiling)).toBe(false);
    const narrower = setWriteMode(value, orgs, personal, 'none');
    expect(withinCeiling(narrower, ceiling)).toBe(true);
    expect(isNarrowing(oauth.constraints, normalizeConstraints(narrower))).toBe(true);
    expect(
      withinCeiling(
        setReadGroups(value, orgs, personal, [g.personalInbox, g.personalErrands]),
        ceiling,
      ),
    ).toBe(false);
    expect(withinCeiling(defaultDeviceValue(['tasks:read']), { scopes: ['tasks:read'] })).toBe(
      true,
    );
    expect(withinCeiling(value, undefined)).toBe(true);
  });

  test('P2: stale ids (an org left, deleted groups) are reconciled away before a save', () => {
    const value: GrantValue = {
      scopes: ['tasks:write'],
      constraints: {
        orgs: [
          { orgId: 'left-org', read: 'all', write: 'all' },
          {
            orgId: acme,
            read: { groups: [g.companyPrio, 'deleted-1', 'deleted-2'] },
            write: { groups: ['deleted-1'] },
          },
          { orgId: personal, read: { groups: ['deleted-3'] }, write: 'none' },
        ],
      },
      expiry: 'keep',
    };
    const { value: next, stale } = reconcileGrant(value, orgs);
    expect(stale).toEqual({ orgs: 1, groups: 3 });
    // Personal read only a deleted group: it reached nothing and leaves the grant.
    expect(next.constraints).toEqual({
      orgs: [{ orgId: acme, read: { groups: [g.companyPrio] }, write: 'none' }],
    });
    expect(grantIssues(next)).toEqual([]);
    // A rename now sends only ids that exist (the server answered 422 before).
    expect(toGrantPatch(next, 0, 'Renamed').constraints).toEqual(next.constraints);
    // Nothing stale: the same value; orgs or groups not loaded yet: not judged.
    const clean = reconcileGrant(next, orgs);
    expect(clean.value).toBe(next);
    expect(reconcileGrant(value, []).value).toBe(value);
    const loading = orgs.map((org) => ({ ...org, groups: undefined }));
    expect(reconcileGrant(value, loading).stale).toEqual({ orgs: 1, groups: 0 });
  });

  test('P2: changing everything implies reading everything', () => {
    let value: GrantValue = { ...defaultTokenValue(orgs), scopes: ['tasks:write'] };
    value = setReadMode(value, orgs, acme, 'groups');
    value = setReadGroups(value, orgs, acme, [g.companyPrio]);
    value = setWriteMode(value, orgs, acme, 'all');
    expect(value.constraints.orgs !== 'all' && value.constraints.orgs[1]).toEqual({
      orgId: acme,
      read: 'all',
      write: 'all',
    });
    // Limiting the read again is refused while it changes everything.
    expect(setReadMode(value, orgs, acme, 'groups').constraints).toEqual(value.constraints);
    // A stored grant with the combination is repaired on edit and on send.
    const stored = {
      scopes: ['tasks:write' as const],
      constraints: {
        orgs: [{ orgId: acme, read: { groups: [g.companyPrio] }, write: 'all' as const }],
      },
    };
    expect(valueFromGrant(stored).constraints).toEqual({
      orgs: [{ orgId: acme, read: 'all', write: 'all' }],
    });
    expect(normalizeConstraints(stored)).toEqual({
      orgs: [{ orgId: acme, read: 'all', write: 'all' }],
    });
    expect(describeWhere(stored, orgs, t, 'en')).toBe(
      'Can read everything in Acme; can add and change tasks anywhere in Acme.',
    );
    // Without a write scope it writes nothing, so a limited read stays.
    const readOnly = { ...stored, scopes: ['tasks:read' as const], expiry: 'keep' as const };
    expect(withWriteImpliesRead(readOnly)).toBe(readOnly);
    // Gaining a write scope with a stored "all" write applies the rule too.
    const gained = toggleScope(readOnly, 'tasks:write', true, orgs);
    expect(gained.constraints.orgs !== 'all' && gained.constraints.orgs[0]?.read).toBe('all');
  });

  test('user codes normalise like better-auth and print as ABCD-EFGH', () => {
    expect(normalizeUserCode(' wdjb-mjht ')).toBe('WDJBMJHT');
    expect(formatUserCode('wdjbmjht')).toBe('WDJB-MJHT');
    expect(formatUserCode('ABC')).toBe('ABC');
  });
});

describe('grant summary', () => {
  test('the example sentence of 11 §3.1', () => {
    const grant = fixtureGrants(0)[1];
    if (!grant) throw new Error('fixture');
    expect(describeWhere(grant, orgs, t, 'en')).toBe(
      'Can read everything in Personal and Acme; can add and change tasks only in Acme › Prio.',
    );
    expect(describeScopes(grant.scopes, t, 'en')).toBe('Add and change tasks');
  });

  test('all orgs, read only, limited reads, loading groups and unknown ids', () => {
    expect(
      describeWhere({ scopes: ['tasks:read'], constraints: { orgs: 'all' } }, orgs, t, 'en'),
    ).toBe('Can read everything in all your organisations, including ones you join later.');
    expect(
      describeWhere({ scopes: ['comments:write'], constraints: { orgs: 'all' } }, orgs, t, 'en'),
    ).toBe(
      'Can read and make changes anywhere in all your organisations, including ones you join later.',
    );
    const limited = {
      scopes: ['tasks:read' as const],
      constraints: {
        orgs: [
          { orgId: personal, read: 'all' as const, write: 'none' as const },
          { orgId: acme, read: { groups: [g.companyInbox, 'gone'] }, write: 'none' as const },
        ],
      },
    };
    expect(describeWhere(limited, orgs, t, 'en')).toBe(
      'Can read everything in Personal and only Acme › Inbox and Acme › a deleted group; can’t change anything.',
    );
    const loading = orgs.map((org) => ({ ...org, groups: undefined }));
    expect(describeWhere(limited, loading, t, 'en')).toContain('only 2 groups in Acme');
    expect(
      describeWhere(
        {
          scopes: ['tasks:read'],
          constraints: { orgs: [{ orgId: 'x', read: 'all', write: 'none' }] },
        },
        orgs,
        t,
        'en',
      ),
    ).toBe('Can read everything in an organisation you left; can’t change anything.');
    expect(
      describeWhere({ scopes: ['tasks:read'], constraints: { orgs: [] } }, orgs, t, 'en'),
    ).toBe('Can’t reach any organisation.');
  });

  test('write everywhere in an org, and capabilities in plain words', () => {
    expect(
      describeWhere(
        {
          scopes: ['tasks:write'],
          constraints: { orgs: [{ orgId: acme, read: 'all', write: 'all' }] },
        },
        orgs,
        t,
        'en',
      ),
    ).toBe('Can read everything in Acme; can add and change tasks anywhere in Acme.');
    expect(describeScopes(['tasks:delete', 'notifications:read'], t, 'en')).toBe(
      'Add and change tasks, delete tasks, and read notifications',
    );
    expect(describeScopes(['notifications:read'], t, 'en')).toBe('Read notifications');
    // Never understate: delete implies add and change, which is listed too (the CLI device row).
    expect(
      describeScopes(
        ['tasks:delete', 'comments:write', 'groups:write', 'notifications:read'],
        t,
        'en',
      ),
    ).toBe('Add and change tasks, comment, manage groups, delete tasks, and read notifications');
    expect(describeScopes(['tasks:read', 'notifications:read'], t, 'en')).toBe(
      'See tasks and read notifications',
    );
  });

  test('grant dates: no year within this year', () => {
    const zone = { locale: 'en', timezone: 'Europe/Stockholm' };
    const now = Date.UTC(2026, 9, 9, 12);
    expect(formatGrantDate(Date.UTC(2026, 9, 2, 12), zone, now)).toBe('Oct 2');
    expect(formatGrantDate(Date.UTC(2027, 0, 7, 12), zone, now)).toBe('Jan 7, 2027');
    expect(formatGrantDate(Date.UTC(2026, 9, 2, 12), { ...zone, locale: 'sv' }, now)).toBe(
      '2 okt.',
    );
  });
});
