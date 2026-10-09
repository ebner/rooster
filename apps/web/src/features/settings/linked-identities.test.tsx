import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { DisplayPrefs } from '../../lib/format';
import { fixtureIdentities } from '../access/fixtures';
import { LinkedIdentitiesSection, type UnlinkOutcome } from './linked-identities';

const prefs: DisplayPrefs = {
  locale: 'en',
  timezone: 'Europe/Stockholm',
  dateFormat: 'MMM d',
  timeFormat: '24h',
};
const now = Date.UTC(2026, 9, 9, 10);
const identities = fixtureIdentities(now);

describe('Settings → Security → Linked identities (FR-SET-3)', () => {
  test('lists each provider with its email and linked date', () => {
    render(
      <LinkedIdentitiesSection
        identities={identities}
        prefs={prefs}
        now={now}
        onUnlink={vi.fn()}
      />,
    );
    const list = screen.getByTestId('linked-identities');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(list.textContent).toContain('Google');
    expect(list.textContent).toContain('jannik@example.com');
    expect(list.textContent).toContain('Linked Sep 19');
  });

  test('unlinking asks inline first; Escape cancels', async () => {
    const onUnlink = vi.fn(async (): Promise<UnlinkOutcome> => 'unlinked');
    render(
      <LinkedIdentitiesSection
        identities={identities}
        prefs={prefs}
        now={now}
        onUnlink={onUnlink}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Unlink Company SSO (jannik@company.example)' }),
    );
    expect(screen.getByText(/You can no longer sign in with it/)).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('confirm-unlink'), { key: 'Escape' });
    expect(screen.queryByTestId('confirm-unlink')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Unlink Company SSO (jannik@company.example)' }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-unlink'));
    });
    expect(onUnlink).toHaveBeenCalledWith('acc_oidc_1');
    expect(screen.queryByTestId('confirm-unlink')).toBeNull();
  });

  test('the last identity can’t be unlinked, and says why', () => {
    render(
      <LinkedIdentitiesSection
        identities={identities.slice(0, 1)}
        prefs={prefs}
        now={now}
        onUnlink={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: /^Unlink Google/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/your only way to sign in/)).toBeTruthy();
  });

  test('a 409 last_identity (another one went meanwhile) is explained in place', async () => {
    const onUnlink = vi.fn(async (): Promise<UnlinkOutcome> => 'lastIdentity');
    render(
      <LinkedIdentitiesSection
        identities={identities}
        prefs={prefs}
        now={now}
        onUnlink={onUnlink}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Unlink Google/ }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-unlink'));
    });
    expect(screen.getByRole('alert').textContent).toContain('now your only way to sign in');
    expect(screen.queryByTestId('confirm-unlink')).toBeNull();
  });
});
