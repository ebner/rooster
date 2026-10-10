import { createAuthClient } from 'better-auth/react';
import { ApiError } from './errors';
import { sessionClosedCode } from './http';
import { isSessionClosed } from './session-events';

/**
 * better-auth at `/api/auth/*` (04 §4.4); used only for sign-in and sign-out. In
 * better-auth 1.7 the generic OIDC providers register as social providers, so every
 * provider signs in through `signIn.social` (no `genericOAuthClient` plugin exists).
 */
export const authClient = createAuthClient({
  baseURL: globalThis.location?.origin ?? '',
  basePath: '/api/auth',
  fetchOptions: {
    // The session barrier (ADR 0051): a sign-out after another account took over would sign
    // that account out.
    onRequest: (context) => {
      if (isSessionClosed()) throw new ApiError(sessionClosedCode, 0);
      return context;
    },
  },
});
