import type { Me, Org } from '../../data/types';

/**
 * The org a task typed in an All organisations view goes to without a `^org` token (ADR 0073
 * A4): `prefs.defaultOrgId` while the user is still a member of it, else the personal org.
 */
export function defaultOrgOf(me: Pick<Me, 'orgs' | 'prefs'>): Org | undefined {
  const id = me.prefs?.defaultOrgId;
  return (
    (id ? me.orgs.find((org) => org.id === id) : undefined) ??
    me.orgs.find((org) => org.isPersonal) ??
    me.orgs[0]
  );
}

/**
 * Whether All organisations is offered at all: it adds nothing with a single org (the
 * personal one), so the sidebar section, the phone sheet entry, the palette entries and the
 * start-page choice appear from the second org on.
 */
export function hasAllOrgs(me: Pick<Me, 'orgs'> | undefined): boolean {
  return (me?.orgs.length ?? 0) > 1;
}
