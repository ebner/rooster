import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { Org } from '../../data/types';
import { fixtureIds, fixtureMe } from '../shell/fixtures';
import { fixtureInvites, fixtureMembers } from './fixtures';
import { OrgSettingsPage, type OrgSettingsPageProps } from './org-settings-page';

const [personal, company, club] = fixtureMe.orgs as [Org, Org, Org];

function renderPage(org: Org, overrides: Partial<OrgSettingsPageProps> = {}) {
  const props: OrgSettingsPageProps = {
    org,
    currentUserId: fixtureIds.jannik,
    members: fixtureMembers[org.id] ?? [],
    invites: fixtureInvites[org.id] ?? [],
    prefs: { locale: 'en', timezone: 'Europe/Stockholm', dateFormat: 'MMM d', timeFormat: '24h' },
    now: Date.UTC(2026, 9, 5, 10),
    onUpdateOrg: vi.fn(),
    onChangeRole: vi.fn(),
    onRemoveMember: vi.fn(),
    onCreateInvite: vi.fn(async () => ({
      id: 'i',
      kind: 'link' as const,
      url: 'https://x/invite/t',
    })),
    onRevokeInvite: vi.fn(),
    onDeleteOrg: vi.fn(async () => {}),
    onLeaveOrg: vi.fn(async () => {}),
    ...overrides,
  };
  render(<OrgSettingsPage {...props} />);
  return props;
}

describe('OrgSettingsPage', () => {
  test('AC-1.4 the personal org hides invites, members and deletion', () => {
    renderPage(personal);
    expect(screen.getByTestId('personal-invites-note').textContent).toContain(
      'Personal organisations can’t be shared',
    );
    expect(screen.queryByRole('button', { name: /Create invite|Create link/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Open invites' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Members' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    // The name is read-only; emoji and colour stay editable (06 §2.2).
    expect(screen.queryByRole('button', { name: /Organisation name/ })).toBeNull();
    expect(screen.getByRole('listbox', { name: 'Icon' })).toBeTruthy();
  });

  test('owners of a shared org see members, invites and the danger zone', () => {
    renderPage(company);
    expect(screen.getByRole('heading', { name: 'Members' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Open invites' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create invite' })).toBeTruthy();
    expect(screen.getByText('olof@example.com')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
  });

  test('members see no invite form and cannot delete', () => {
    renderPage(club);
    expect(screen.queryByRole('heading', { name: 'Invites' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Leave/ })).toBeTruthy();
  });

  test('deleting requires typing the org name', async () => {
    const props = renderPage(company);
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    const confirm = screen.getByRole('button', { name: 'Delete organisation' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText(`Type “${company.name}” to confirm`), {
      target: { value: company.name },
    });
    expect(confirm.hasAttribute('disabled')).toBe(false);
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(props.onDeleteOrg).toHaveBeenCalledWith(company.name));
  });

  test('the last owner cannot be demoted', () => {
    const members = (fixtureMembers[company.id] ?? []).map((m) =>
      m.userId === fixtureIds.anna ? { ...m, role: 'member' as const } : m,
    );
    renderPage(company, { members });
    expect(screen.getByText(/before you change your own role/)).toBeTruthy();
    const ownRole = screen.getByRole('button', { name: /Role for Jannik Lunde/ });
    expect(ownRole.hasAttribute('disabled')).toBe(true);
  });
});
