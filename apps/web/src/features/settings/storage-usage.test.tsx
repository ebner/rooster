import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { StorageUsage } from './data-page';

const mb = 1024 * 1024;

describe('Settings → Data: attachment storage (ADR 0052 §6)', () => {
  test('with a quota: "312 MB of 1 GB used" and a progress bar', () => {
    render(<StorageUsage storage={{ usedBytes: 312 * mb, quotaBytes: 1024 * mb }} locale="en" />);
    const bar = screen.getByRole('progressbar', { name: 'Storage' });
    expect(bar.getAttribute('aria-valuetext')).toBe('Attachments: 312 MB of 1 GB used');
    expect(bar.getAttribute('aria-valuenow')).toBe(String(312 * mb));
    expect(screen.getByText('Attachments: 312 MB of 1 GB used')).toBeTruthy();
    expect(screen.queryByText(/storage is full/)).toBeNull();
  });

  test('a full quota says so', () => {
    render(<StorageUsage storage={{ usedBytes: 1024 * mb, quotaBytes: 1024 * mb }} locale="en" />);
    expect(screen.getByText(/Your storage is full/)).toBeTruthy();
  });

  test('without a quota: only what is used, no bar', () => {
    render(<StorageUsage storage={{ usedBytes: 312 * mb, quotaBytes: null }} locale="sv" />);
    expect(screen.getByTestId('storage-usage').textContent).toBe('Attachments: 312 MB used');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
