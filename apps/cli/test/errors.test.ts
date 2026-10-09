import { describe, expect, it } from 'vitest';
import { EXIT, exitCodeForProblem } from '../src/errors.ts';

describe('exit codes (07 §4.2)', () => {
  it.each([
    [401, 'unauthenticated', EXIT.auth],
    [403, 'forbidden_scope', EXIT.auth],
    [403, 'outside_grant', EXIT.auth],
    [403, 'forbidden', EXIT.auth],
    [403, 'csrf_origin', EXIT.auth],
    [404, 'not_found', EXIT.notFound],
    [409, 'ambiguous_ref', EXIT.notFound],
    [410, 'conflict_deleted', EXIT.notFound],
    [409, 'id_conflict', EXIT.conflict],
    [409, 'group_not_empty', EXIT.conflict],
    [409, 'personal_org', EXIT.conflict],
    [422, 'validation_failed', EXIT.conflict],
    [422, 'widening_not_allowed', EXIT.conflict],
    [413, 'payload_too_large', EXIT.conflict],
    [429, 'rate_limited', EXIT.network],
    [500, 'internal', EXIT.network],
    [502, 'push_failed', EXIT.network],
    [503, 'unavailable', EXIT.network],
    [418, 'http_418', EXIT.unexpected],
  ])('%i %s → %i', (status, code, exit) => {
    expect(exitCodeForProblem(status, code)).toBe(exit);
  });
});
