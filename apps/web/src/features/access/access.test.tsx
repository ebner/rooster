import type { GrantScope } from '@rooster/core/grants';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type { DisplayPrefs } from '../../lib/format';
import { fixtureIds } from '../shell/fixtures';
import { ConnectedAppsSection, type ConnectedAppsSectionProps } from './connected-apps';
import { ConstraintEditor } from './constraint-editor';
import { DevicePage, type DevicePageProps } from './device-page';
import { fixtureGrantOrgs, fixtureGrants, fixtureUserCode, fixtureGroupIds as g } from './fixtures';
import { defaultTokenValue, type GrantCeiling, type GrantValue } from './grant-model';

const prefs: DisplayPrefs = {
  locale: 'en',
  timezone: 'Europe/Stockholm',
  dateFormat: 'MMM d',
  timeFormat: '24h',
};
const now = Date.UTC(2026, 9, 9, 10);
const orgs = fixtureGrantOrgs;
const acme = fixtureIds.companyOrg;

function Editor({
  initial,
  ceiling,
  onValue,
}: {
  initial: GrantValue;
  ceiling?: GrantCeiling;
  onValue?: (value: GrantValue) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ConstraintEditor
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
      orgs={orgs}
      ceiling={ceiling}
      prefs={prefs}
      now={now}
    />
  );
}

describe('ConstraintEditor', () => {
  test('ticking "Add and change tasks" checks and locks "See tasks"; the summary follows', () => {
    render(<Editor initial={defaultTokenValue(orgs)} />);
    const see = screen.getByRole('checkbox', { name: /See tasks/ });
    expect((see as HTMLInputElement).checked).toBe(true);
    expect((see as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: /Add and change tasks/ }));
    expect((see as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Included')).toBeTruthy();
    expect(screen.getByTestId('grant-summary').textContent).toContain(
      'can add and change tasks only in Personal › Inbox',
    );
  });

  test('write only in Prio, picked with the keyboard-friendly group list', () => {
    const onValue = vi.fn();
    render(
      <Editor
        initial={{ ...defaultTokenValue(orgs), scopes: ['tasks:write'] }}
        onValue={onValue}
      />,
    );
    const write = screen.getByTestId(`write-${acme}`);
    fireEvent.click(within(write).getByRole('radio', { name: 'Only these groups' }));
    expect(screen.getByText('Choose at least one group.')).toBeTruthy();
    const picker = screen.getByRole('listbox', { name: 'Groups it may change in Acme' });
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Inbox', 'Today', 'Prio', 'Later']);
    fireEvent.click(within(picker).getByRole('option', { name: 'Prio' }));
    const last = onValue.mock.calls.at(-1)?.[0] as GrantValue;
    expect(last.constraints.orgs !== 'all' && last.constraints.orgs[1]).toEqual({
      orgId: acme,
      read: 'all',
      write: { groups: [g.companyPrio] },
    });
    expect(screen.getByTestId('grant-summary').textContent).toContain('Acme › Prio');
  });

  test('P2: "Change → Everything" makes reading everything, with the limit disabled and explained', () => {
    render(<Editor initial={{ ...defaultTokenValue(orgs), scopes: ['tasks:write'] }} />);
    const read = screen.getByTestId(`read-${acme}`);
    fireEvent.click(within(read).getByRole('radio', { name: 'Only these groups' }));
    fireEvent.click(
      within(screen.getByTestId(`write-${acme}`)).getByRole('radio', { name: 'Everything' }),
    );
    expect(
      (within(read).getByRole('radio', { name: 'Everything' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (within(read).getByRole('radio', { name: 'Only these groups' }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      screen.getByText('Changing everything here needs reading everything here.'),
    ).toBeTruthy();
  });

  test('a ceiling hides scopes beyond it and disables widening choices', () => {
    const oauth = fixtureGrants(now)[2];
    if (!oauth) throw new Error('fixture');
    render(
      <Editor
        initial={{
          scopes: oauth.scopes as GrantScope[],
          constraints: oauth.constraints,
          expiry: 'keep',
        }}
        ceiling={{ scopes: oauth.scopes, constraints: oauth.constraints }}
      />,
    );
    expect(screen.queryByRole('checkbox', { name: /Delete/ })).toBeNull();
    expect(
      (screen.getByRole('checkbox', { name: /^All organisations/ }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Acme' }) as HTMLInputElement).disabled).toBe(
      true,
    );
    const write = screen.getByTestId(`write-${fixtureIds.personalOrg}`);
    expect(
      (within(write).getByRole('radio', { name: 'Everything' }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (within(write).getByRole('radio', { name: 'Nothing' }) as HTMLInputElement).disabled,
    ).toBe(false);
    const readPicker = screen.getByRole('listbox', { name: 'Groups it may read in Personal' });
    expect(
      within(readPicker).getByRole('option', { name: 'Errands' }).getAttribute('aria-disabled'),
    ).toBe('true');
  });
});

function renderApps(overrides: Partial<ConnectedAppsSectionProps> = {}) {
  const props: ConnectedAppsSectionProps = {
    grants: fixtureGrants(now),
    orgs,
    prefs,
    now,
    onCreateToken: vi.fn(),
    onUpdate: vi.fn(async () => undefined),
    onRevoke: vi.fn(async () => undefined),
    ...overrides,
  };
  const view = render(<ConnectedAppsSection {...props} />);
  return {
    ...props,
    rerender: (next: Partial<ConnectedAppsSectionProps>) =>
      view.rerender(<ConnectedAppsSection {...props} {...next} />),
  };
}

describe('Connected apps', () => {
  test('lists every grant with kind, capabilities, where, last use and expiry', () => {
    renderApps();
    const pat = screen.getByTestId('grant-0192f5d0-7a1e-7c3a-9f10-00000000c002');
    expect(pat.textContent).toContain('Prio sync script');
    expect(pat.textContent).toContain('Token');
    expect(pat.textContent).toContain('rooster_pat_ab12');
    expect(pat.textContent).toContain('can add and change tasks only in Acme › Prio');
    expect(pat.textContent).toContain('from 10.0.0.14');
    const old = screen.getByTestId('grant-0192f5d0-7a1e-7c3a-9f10-00000000c004');
    expect(within(old).getByText('Expired')).toBeTruthy();
  });

  test('revoke asks inline, then calls onRevoke', async () => {
    const props = renderApps();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Prio sync script' }));
    expect(screen.getByText(/Anything using it stops working right away/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-revoke'));
    });
    expect(props.onRevoke).toHaveBeenCalledWith('0192f5d0-7a1e-7c3a-9f10-00000000c002');
    await waitFor(() => expect(screen.queryByTestId('confirm-revoke')).toBeNull());
  });

  test('edit opens the editor in place and saves a patch', async () => {
    const props = renderApps();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Prio sync script' }));
    const form = screen.getByTestId('edit-grant');
    fireEvent.click(
      within(within(form).getByTestId(`write-${acme}`)).getByRole('radio', { name: 'Nothing' }),
    );
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    });
    expect(props.onUpdate).toHaveBeenCalledWith('0192f5d0-7a1e-7c3a-9f10-00000000c002', {
      scopes: ['tasks:write'],
      constraints: {
        orgs: [
          { orgId: fixtureIds.personalOrg, read: 'all', write: 'none' },
          { orgId: acme, read: 'all', write: 'none' },
        ],
      },
      label: 'Prio sync script',
    });
  });

  test('P2: editing a grant with stale ids says so and saves without them (rename works)', async () => {
    const [, pat] = fixtureGrants(now);
    if (!pat) throw new Error('fixture');
    const stale = {
      ...pat,
      constraints: {
        orgs: [
          { orgId: 'left-org', read: 'all' as const, write: 'none' as const },
          { orgId: acme, read: 'all' as const, write: { groups: [g.companyPrio, 'deleted'] } },
        ],
      },
    };
    const onUpdate = vi.fn(async () => undefined);
    renderApps({ grants: [stale], onUpdate, confirmedOrgs: orgs, confirmOrgs: async () => orgs });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Prio sync script' }));
    const form = screen.getByTestId('edit-grant');
    expect(within(form).getByRole('status').textContent).toBe(
      '1 group no longer exists and will be removed. You left 1 organisation it names; it will be removed.',
    );
    const picker = within(form).getByRole('listbox', { name: 'Groups it may change in Acme' });
    expect(
      within(picker)
        .getAllByRole('option')
        .filter((o) => o.getAttribute('aria-selected') === 'true')
        .map((o) => o.textContent),
    ).toEqual(['Prio']);
    fireEvent.change(within(form).getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Renamed' },
    });
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    });
    expect(onUpdate).toHaveBeenCalledWith(pat.id, {
      scopes: ['tasks:write'],
      constraints: {
        orgs: [{ orgId: acme, read: 'all', write: { groups: [g.companyPrio] } }],
      },
      label: 'Renamed',
    });
  });

  test('P2: ids are only pruned when the server confirms them missing, never from a stale cache', async () => {
    const [, pat] = fixtureGrants(now);
    if (!pat) throw new Error('fixture');
    const fresh = '0192f5d0-7a1e-7c3a-9f10-00000000b099';
    const grant = {
      ...pat,
      constraints: {
        orgs: [{ orgId: acme, read: 'all' as const, write: { groups: [g.companyPrio, fresh] } }],
      },
    };
    // This tab's cache has not seen the new group yet; the server has it.
    const confirmed = orgs.map((org) =>
      org.id === acme
        ? { ...org, groups: [...(org.groups ?? []), { id: fresh, name: 'New', isInbox: false }] }
        : org,
    );
    const onUpdate = vi.fn(async () => undefined);
    const onEditingChange = vi.fn();
    const view = renderApps({ grants: [grant], onUpdate, onEditingChange });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Prio sync script' }));
    expect(onEditingChange).toHaveBeenLastCalledWith(grant);
    const form = () => screen.getByTestId('edit-grant');
    // Not confirmed yet (or offline): nothing is pruned.
    expect(within(form()).queryByRole('status')).toBeNull();
    // Confirmed missing: pruned from what is sent, with the note.
    view.rerender({ confirmedOrgs: orgs });
    expect(within(form()).getByRole('status').textContent).toContain('1 group no longer exists');
    // The data now shows it exists: the removal does not stick.
    view.rerender({ confirmedOrgs: confirmed });
    expect(within(form()).queryByRole('status')).toBeNull();
    // Editing the picker keeps the id it does not show.
    const picker = within(form()).getByRole('listbox', { name: 'Groups it may change in Acme' });
    fireEvent.click(within(picker).getByRole('option', { name: 'Today' }));
    await act(async () => {
      fireEvent.click(within(form()).getByRole('button', { name: 'Save changes' }));
    });
    expect(onUpdate).toHaveBeenCalledWith(
      pat.id,
      expect.objectContaining({
        constraints: {
          orgs: [
            {
              orgId: acme,
              read: 'all',
              write: { groups: [g.companyToday, g.companyPrio, fresh] },
            },
          ],
        },
      }),
    );
  });

  test('P2: a group created after the editor opened, then selected and saved, is kept', async () => {
    const [, pat] = fixtureGrants(now);
    if (!pat) throw new Error('fixture');
    const created = { id: '0192f5d0-7a1e-7c3a-9f10-00000000b098', name: 'Fresh', isInbox: false };
    const withCreated = orgs.map((org) =>
      org.id === acme ? { ...org, groups: [...(org.groups ?? []), created] } : org,
    );
    const onUpdate = vi.fn(async () => undefined);
    const confirmOrgs = vi.fn(async () => withCreated);
    // The confirmation snapshot predates the group; this tab's list already shows it.
    renderApps({ grants: [pat], onUpdate, orgs: withCreated, confirmedOrgs: orgs, confirmOrgs });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Prio sync script' }));
    const form = screen.getByTestId('edit-grant');
    const picker = within(form).getByRole('listbox', { name: 'Groups it may change in Acme' });
    fireEvent.click(within(picker).getByRole('option', { name: 'Fresh' }));
    // Not announced as deleted while the confirmation catches up.
    expect(within(form).queryByRole('status')).toBeNull();
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    });
    expect(confirmOrgs).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(
      pat.id,
      expect.objectContaining({
        constraints: {
          orgs: [
            { orgId: fixtureIds.personalOrg, read: 'all', write: 'none' },
            { orgId: acme, read: 'all', write: { groups: [g.companyPrio, created.id] } },
          ],
        },
      }),
    );
  });

  test('a failed confirmation (e.g. cancelled) still saves, unpruned: the server decides', async () => {
    const [, pat] = fixtureGrants(now);
    if (!pat) throw new Error('fixture');
    const onUpdate = vi.fn(async () => undefined);
    const confirmOrgs = vi.fn(async (): Promise<typeof orgs> => {
      throw new Error('CancelledError');
    });
    renderApps({ grants: [pat], onUpdate, confirmOrgs });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Prio sync script' }));
    const form = screen.getByTestId('edit-grant');
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    });
    expect(onUpdate).toHaveBeenCalledWith(
      pat.id,
      expect.objectContaining({ constraints: pat.constraints, label: pat.label }),
    );
  });

  test('P2: if everything it named is confirmed gone, the save stops and says why', async () => {
    const [, pat] = fixtureGrants(now);
    if (!pat) throw new Error('fixture');
    const gone = {
      ...pat,
      constraints: { orgs: [{ orgId: 'left', read: 'all' as const, write: 'none' as const }] },
    };
    const onUpdate = vi.fn(async () => undefined);
    renderApps({ grants: [gone], onUpdate, confirmOrgs: async () => orgs });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Prio sync script' }));
    const form = screen.getByTestId('edit-grant');
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(within(form).getByRole('alert').textContent).toBe('Choose at least one organisation.');
  });

  test('a new token is created from the form and shown once', async () => {
    const created = fixtureGrants(now)[1];
    if (!created) throw new Error('fixture');
    const onCreateToken = vi.fn(async () => ({ token: 'rooster_pat_secret', grant: created }));
    renderApps({ onCreateToken });
    fireEvent.click(screen.getByTestId('new-token'));
    const form = screen.getByTestId('new-token-form');
    const create = within(form).getByRole('button', { name: 'Create token' });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(form).getByRole('textbox', { name: /Name/ }), {
      target: { value: 'Backup' },
    });
    await act(async () => {
      fireEvent.click(create);
    });
    expect(onCreateToken).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Backup', scopes: ['tasks:read'], expiresInDays: 90 }),
    );
    const reveal = screen.getByTestId('token-reveal');
    expect((within(reveal).getByTestId('token-value') as HTMLInputElement).value).toBe(
      'rooster_pat_secret',
    );
    expect(reveal.textContent).toContain('You won’t be able to see it again');
    fireEvent.click(within(reveal).getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('token-reveal')).toBeNull();
    expect(screen.queryByText('rooster_pat_secret')).toBeNull();
  });
});

function renderDevice(overrides: Partial<DevicePageProps> = {}) {
  const props: DevicePageProps = {
    state: { kind: 'enter' },
    account: 'jannik@example.com',
    orgs,
    prefs,
    now,
    onSubmitCode: vi.fn(),
    onApprove: vi.fn(async () => undefined),
    onDeny: vi.fn(async () => undefined),
    homeHref: '/',
    ...overrides,
  };
  render(<DevicePage {...props} />);
  return props;
}

describe('/device', () => {
  test('a typed code is normalised before it is looked up', () => {
    const props = renderDevice();
    fireEvent.change(screen.getByRole('textbox', { name: 'Code' }), {
      target: { value: 'wdjb-mjht' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(props.onSubmitCode).toHaveBeenCalledWith('WDJBMJHT');
  });

  test('errors explain what to do', () => {
    renderDevice({ state: { kind: 'enter', code: fixtureUserCode, error: 'expired' } });
    expect(screen.getByRole('alert').textContent).toContain('Run rooster login again');
  });

  test('approve sends the narrowed grant; the requested scopes are the ceiling', async () => {
    const props = renderDevice({
      state: {
        kind: 'request',
        request: {
          userCode: fixtureUserCode,
          clientId: 'rooster-cli',
          clientName: 'rooster CLI',
          requestedScopes: ['tasks:write'],
          expiresAt: now + 600_000,
        },
      },
    });
    expect(screen.getByTestId('device-user-code').textContent).toBe('WDJB-MJHT');
    expect(screen.queryByRole('checkbox', { name: /Delete/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /^All organisations/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Personal' }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('device-approve'));
    });
    expect(props.onApprove).toHaveBeenCalledWith({
      scopes: ['tasks:write'],
      constraints: { orgs: [{ orgId: acme, read: 'all', write: 'all' }] },
    });
  });

  test('done states', () => {
    renderDevice({ state: { kind: 'approved', clientName: 'rooster CLI' } });
    expect(screen.getByText('You can go back to your terminal.')).toBeTruthy();
  });
});
