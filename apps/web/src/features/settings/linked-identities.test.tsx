import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { DisplayPrefs } from '../../lib/format';
import { fixtureIdentities, fixtureRemovedIdentities } from '../access/fixtures';
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
    expect(
      screen.getByText(/can’t sign in with it until you allow it again under Removed sign-ins/),
    ).toBeTruthy();
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

  test('no removed sign-ins: the subsection stays hidden', () => {
    render(
      <LinkedIdentitiesSection
        identities={identities}
        prefs={prefs}
        now={now}
        onUnlink={vi.fn()}
        removed={[]}
        onAllow={vi.fn()}
      />,
    );
    expect(screen.queryByRole('heading', { name: 'Removed sign-ins' })).toBeNull();
  });

  test('lists removed sign-ins newest first, with their email and removal date', () => {
    render(
      <LinkedIdentitiesSection
        identities={identities}
        prefs={prefs}
        now={now}
        onUnlink={vi.fn()}
        removed={[...fixtureRemovedIdentities(now)].reverse()}
        onAllow={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Removed sign-ins' })).toBeTruthy();
    expect(screen.getByText(/can’t be used to sign in/)).toBeTruthy();
    const items = within(screen.getByTestId('removed-identities')).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('jannik.old@example.com');
    expect(items[0]?.textContent).toContain('Removed Oct 6');
    expect(items[1]?.textContent).toContain('Company SSO');
  });

  test('allowing again asks inline first; Escape cancels; confirming calls onAllow', async () => {
    const onAllow = vi.fn(async () => true);
    render(
      <LinkedIdentitiesSection
        identities={identities}
        prefs={prefs}
        now={now}
        onUnlink={vi.fn()}
        removed={fixtureRemovedIdentities(now)}
        onAllow={onAllow}
      />,
    );
    const name = 'Allow Google (jannik.old@example.com) again';
    fireEvent.click(screen.getByRole('button', { name }));
    expect(screen.getByText(/The next time you sign in with it, it’s linked/)).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('confirm-allow'), { key: 'Escape' });
    expect(screen.queryByTestId('confirm-allow')).toBeNull();
    expect(onAllow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-allow'));
    });
    expect(onAllow).toHaveBeenCalledWith('acc_google_old');
    expect(screen.queryByTestId('confirm-allow')).toBeNull();
  });

  test('a failed allow keeps the confirm open', async () => {
    const onAllow = vi.fn(async () => false);
    render(
      <LinkedIdentitiesSection
        identities={identities}
        prefs={prefs}
        now={now}
        onUnlink={vi.fn()}
        removed={fixtureRemovedIdentities(now)}
        onAllow={onAllow}
        initialAllowingId="acc_oidc_old"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-allow'));
    });
    expect(onAllow).toHaveBeenCalledWith('acc_oidc_old');
    expect(screen.getByTestId('confirm-allow')).toBeTruthy();
  });

  test('removed sign-ins that fail to load say so', () => {
    render(
      <LinkedIdentitiesSection
        identities={identities}
        prefs={prefs}
        now={now}
        onUnlink={vi.fn()}
        removedError={new Error('offline')}
        onAllow={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t load your removed sign-ins');
  });
});
