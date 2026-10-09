import { describe, expect, it } from 'vitest';
import {
  canRead,
  canWrite,
  canWriteOrg,
  expandScopes,
  type GrantConstraints,
  grantsOrg,
  hasScope,
  isGrantScope,
  isNarrowing,
  minimalScopes,
  UNCONSTRAINED,
} from '../src/grants.ts';
import { grantConstraintsSchema, grantPatchSchema } from '../src/schemas/grants.ts';

const A = '01900000-0000-7000-8000-00000000000a';
const B = '01900000-0000-7000-8000-00000000000b';
const prio = '01900000-0000-7000-8000-0000000000a1';
const inbox = '01900000-0000-7000-8000-0000000000a2';

const prioOnly: GrantConstraints = {
  orgs: [{ orgId: A, read: 'all', write: { groups: [prio] } }],
};

describe('grant scopes (11 §2.1)', () => {
  it('expands implications transitively', () => {
    expect([...expandScopes(['tasks:assign'])].sort()).toEqual([
      'tasks:assign',
      'tasks:read',
      'tasks:write',
    ]);
    expect(hasScope(['tasks:delete'], 'tasks:read')).toBe(true);
    expect(hasScope(['comments:write'], 'tasks:write')).toBe(false);
    expect(hasScope(['notifications:read'], 'tasks:read')).toBe(false);
  });

  it('minimises to the scopes that are not implied by others', () => {
    expect(minimalScopes(['tasks:read', 'tasks:write', 'comments:write'])).toEqual([
      'tasks:write',
      'comments:write',
    ]);
  });

  it('recognises scope names', () => {
    expect(isGrantScope('tasks:read')).toBe(true);
    expect(isGrantScope('admin')).toBe(true);
    expect(isGrantScope('root')).toBe(false);
  });
});

describe('grant constraints (11 §2.2)', () => {
  it('an unconstrained grant reaches everything', () => {
    expect(grantsOrg(UNCONSTRAINED, B)).toBe(true);
    expect(canWrite(UNCONSTRAINED, B, null)).toBe(true);
    expect(canWriteOrg(UNCONSTRAINED, B)).toBe(true);
  });

  it('a group write grant writes only there, and reads the org', () => {
    expect(grantsOrg(prioOnly, A)).toBe(true);
    expect(grantsOrg(prioOnly, B)).toBe(false);
    expect(canRead(prioOnly, A, inbox)).toBe(true);
    expect(canRead(prioOnly, A, null)).toBe(true);
    expect(canWrite(prioOnly, A, prio)).toBe(true);
    expect(canWrite(prioOnly, A, inbox)).toBe(false);
    expect(canWrite(prioOnly, A, null)).toBe(false);
    expect(canWriteOrg(prioOnly, A)).toBe(false);
    expect(canRead(prioOnly, B, prio)).toBe(false);
  });

  it('a group read grant hides other groups and tasks outside the list', () => {
    const readPrio: GrantConstraints = {
      orgs: [{ orgId: A, read: { groups: [prio] }, write: 'none' }],
    };
    expect(canRead(readPrio, A, prio)).toBe(true);
    expect(canRead(readPrio, A, inbox)).toBe(false);
    expect(canRead(readPrio, A, null)).toBe(false);
    expect(canWrite(readPrio, A, prio)).toBe(false);
  });

  it('narrowing never widens', () => {
    expect(isNarrowing(UNCONSTRAINED, prioOnly)).toBe(true);
    expect(isNarrowing(prioOnly, UNCONSTRAINED)).toBe(false);
    expect(isNarrowing(prioOnly, { orgs: [{ orgId: A, read: 'all', write: 'none' }] })).toBe(true);
    expect(
      isNarrowing(prioOnly, { orgs: [{ orgId: A, read: 'all', write: { groups: [inbox] } }] }),
    ).toBe(false);
    expect(isNarrowing(prioOnly, { orgs: [{ orgId: A, read: 'all', write: 'all' }] })).toBe(false);
    expect(isNarrowing(prioOnly, { orgs: [{ orgId: B, read: 'all', write: 'none' }] })).toBe(false);
    expect(
      isNarrowing(
        { orgs: [{ orgId: A, read: { groups: [prio, inbox] }, write: 'none' }] },
        { orgs: [{ orgId: A, read: { groups: [prio] }, write: 'none' }] },
      ),
    ).toBe(true);
    expect(
      isNarrowing(
        { orgs: [{ orgId: A, read: { groups: [prio] }, write: 'none' }] },
        { orgs: [{ orgId: A, read: 'all', write: 'none' }] },
      ),
    ).toBe(false);
  });

  it('schemas accept the shapes and reject empty patches', () => {
    expect(grantConstraintsSchema.safeParse(prioOnly).success).toBe(true);
    expect(grantConstraintsSchema.safeParse({ orgs: [] }).success).toBe(false);
    expect(grantPatchSchema.safeParse({}).success).toBe(false);
    expect(grantPatchSchema.safeParse({ expiresAt: null }).success).toBe(true);
  });
});
