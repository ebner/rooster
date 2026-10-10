import { getI18n } from 'react-i18next';
import { describe, expect, test } from 'vitest';
import { ApiError } from '../../data/errors';
import { uploadErrorText } from './attachments-view';
import { problemUsedBytes, uploadErrorKind } from './model';

const t = getI18n().getFixedT('en', 'attachments') as unknown as Parameters<
  typeof uploadErrorText
>[3];
const gb = 1024 * 1024 * 1024;

describe('uploads past the storage quota (ADR 0052 §6, AC-11.2)', () => {
  test('413 storage_quota_exceeded is the quota, not the per-file size limit', () => {
    const error = new ApiError('storage_quota_exceeded', 413, undefined, {
      limitBytes: gb,
      usedBytes: gb - 1000,
    });
    expect(uploadErrorKind(error)).toBe('storageFull');
    expect(problemUsedBytes(error.problem)).toBe(gb - 1000);
    expect(uploadErrorKind(new ApiError('payload_too_large', 413))).toBe('tooLarge');
  });

  test('the message names the quota and what is used', () => {
    const text = uploadErrorText(
      { name: 'plan.pdf', error: 'storageFull', limitBytes: gb, usedBytes: 0.98 * gb },
      'en',
      100,
      t,
    );
    expect(text).toBe(
      'plan.pdf wasn’t uploaded: it would take your attachments past your 1 GB of storage (1,003.5 MB used). Delete attachments you no longer need and try again.',
    );
    expect(uploadErrorText({ name: 'plan.pdf', error: 'storageFull' }, 'en', 100, t)).toBe(
      'plan.pdf wasn’t uploaded: your attachment storage is full.',
    );
  });
});
