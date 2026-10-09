import { describe, expect, test } from 'vitest';
import { deviceErrorKind } from './device';
import { ApiError } from './errors';

describe('deviceErrorKind', () => {
  test('maps problem codes and statuses to what /device explains', () => {
    expect(deviceErrorKind(new ApiError('device_code_expired', 400))).toBe('expired');
    expect(deviceErrorKind(new ApiError('http_410', 410))).toBe('expired');
    expect(deviceErrorKind(new ApiError('device_code_used', 409))).toBe('used');
    expect(deviceErrorKind(new ApiError('already_processed', 400))).toBe('used');
    expect(deviceErrorKind(new ApiError('not_found', 404))).toBe('notFound');
    expect(deviceErrorKind(new ApiError('internal', 500))).toBe('failed');
    expect(deviceErrorKind(new Error('offline'))).toBe('failed');
  });
});
