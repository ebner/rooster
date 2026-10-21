/** Where better-auth is mounted; also the OAuth issuer's path (ADR 0041). */
export const AUTH_BASE_PATH = '/api/auth';

/** Set by the `/api/auth/*` mount from the socket (or a trusted proxy); never from clients. */
export const CLIENT_IP_HEADER = 'x-rooster-client-ip';
