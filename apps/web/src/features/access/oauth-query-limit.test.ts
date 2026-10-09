import { OAUTH_QUERY_MAX } from '@rooster/core/limits';
import { describe, expect, test } from 'vitest';
import { Route as LoginRoute } from '../../routes/login';
import { Route as ConsentRoute } from '../../routes/oauth.consent';

/** The signed query may carry a long client `state`: both routes keep what the server takes. */
function validate(route: typeof ConsentRoute | typeof LoginRoute, search: Record<string, unknown>) {
  const validateSearch = route.options.validateSearch as (s: Record<string, unknown>) => {
    oauth_query?: string;
  };
  return validateSearch(search).oauth_query;
}

describe('oauth_query length (the server’s limit, OAUTH_QUERY_MAX)', () => {
  const long = `client_id=c&state=${'s'.repeat(10_000)}&ba_param=client_id&sig=x`;
  const tooLong = `client_id=c&state=${'s'.repeat(OAUTH_QUERY_MAX)}&sig=x`;

  test('a 10,000-character query survives on /oauth/consent and /login', () => {
    expect(OAUTH_QUERY_MAX).toBe(16_384);
    expect(validate(ConsentRoute, { oauth_query: long })).toBe(long);
    expect(validate(LoginRoute, { oauth_query: long })).toBe(long);
  });

  test('anything beyond the server’s limit is dropped', () => {
    expect(validate(ConsentRoute, { oauth_query: tooLong })).toBeUndefined();
    expect(validate(LoginRoute, { oauth_query: tooLong })).toBeUndefined();
  });
});
