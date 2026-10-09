import { AsyncLocalStorage } from 'node:async_hooks';
import { getOAuthProviderState } from '@better-auth/oauth-provider';
import { NO_GRANT_REFERENCE } from '../services/oauth-grants.ts';

export { NO_GRANT_REFERENCE };

/**
 * The grant handoff to better-auth's OAuth provider (ADR 0041 §1). The plugin stamps
 * `referenceId` on authorization codes, access and refresh tokens and consent rows from
 * `postLogin.consentReferenceId({user, session, scopes})`, which receives neither the client nor
 * the request. rooster's `referenceId` is the `access_grant.id`:
 * - inside `POST /api/v1/oauth/consent`, the grant that the decision just created or updated,
 *   passed explicitly through `consentHandoff`;
 * - everywhere else (a repeat authorization that skips the consent screen, sign-in
 *   continuations), the user's live OAuth grant for the client of the authorization request
 *   being processed (`getOAuthProviderState`), or `NO_GRANT_REFERENCE` without one.
 */

export interface ConsentHandoff {
  userId: string;
  clientId: string;
  grantId: string;
}

export const consentHandoff = new AsyncLocalStorage<ConsentHandoff>();

/** The `client_id` of the authorization request the provider is processing, if any. */
export async function currentAuthorizationClientId(): Promise<string | null> {
  const state = await getOAuthProviderState();
  if (state === null || state === undefined) return null;
  return new URLSearchParams(state.query).get('client_id');
}

/**
 * The `consentReferenceId` implementation. Throws (the authorization fails) when the explicit
 * handoff names another user or client than the request: a code must never carry a grant that
 * is not this user's grant for this client.
 */
export async function consentReferenceId(
  userId: string | undefined,
  liveGrantId: (userId: string, clientId: string) => string | null,
): Promise<string> {
  const clientId = await currentAuthorizationClientId();
  const handoff = consentHandoff.getStore();
  if (userId === undefined || clientId === null) {
    throw new Error('OAuth grant handoff: no user or client in the authorization request');
  }
  if (handoff !== undefined) {
    if (handoff.userId !== userId || handoff.clientId !== clientId) {
      throw new Error('OAuth grant handoff: the consent decision names another user or client');
    }
    return handoff.grantId;
  }
  return liveGrantId(userId, clientId) ?? NO_GRANT_REFERENCE;
}
