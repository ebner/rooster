import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { deviceErrorKind } from '../../data/device';
import { ApiError } from '../../data/errors';
import type { DisplayPrefs } from '../../lib/format';
import { fixtureIds } from '../shell/fixtures';
import {
  ConnectedAppsSection,
  type ConnectedAppsSectionProps,
  mcpSetupLines,
} from './connected-apps';
import { DevicePage, type DevicePageProps } from './device-page';
import {
  cliDeviceRequestFields,
  fixtureDeviceRequests,
  fixtureGrantOrgs,
  fixtureGrants,
  fixtureUserCode,
  fixtureGroupIds as g,
} from './fixtures';
import { deviceCeiling, deviceNewScopes, deviceStart, toDeviceApprove } from './grant-model';

/** Phase 12 (11 §9.3, §9.7, ADR 0065): the device grant's approval page and MCP tokens. */

const prefs: DisplayPrefs = {
  locale: 'en',
  timezone: 'Europe/Stockholm',
  dateFormat: 'MMM d',
  timeFormat: '24h',
};
const now = Date.UTC(2026, 9, 21, 10);
const orgs = fixtureGrantOrgs;
const personal = fixtureIds.personalOrg;
const acme = fixtureIds.companyOrg;
const requests = fixtureDeviceRequests(now);

function renderDevice(overrides: Partial<DevicePageProps> = {}) {
  const props: DevicePageProps = {
    state: { kind: 'request', request: requests.app },
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

describe('device grant defaults (11 §9.3)', () => {
  test('an app starts at least privilege: every org read, writing only the personal Inbox, no delete, 90 days', () => {
    const { value } = deviceStart(requests.app, orgs);
    expect(value.scopes).toEqual(['tasks:write']);
    expect(value.expiry).toBe(90);
    expect(value.constraints).toEqual({
      orgs: [
        { orgId: personal, read: 'all', write: { groups: [g.personalInbox] } },
        { orgId: acme, read: 'all', write: 'none' },
      ],
    });
  });

  test('rooster CLI starts with what it asked for, everywhere, never expiring', () => {
    const { value } = deviceStart(requests.cli, orgs);
    expect(value.constraints).toEqual({ orgs: 'all' });
    expect(value.expiry).toBe('never');
    expect(value.scopes).toContain('tasks:delete');
  });

  test('admin: only for rooster CLI and an instance admin, never for an app', () => {
    const asks = { ...requests.app, requestedScopes: ['tasks:write' as const, 'admin' as const] };
    expect(deviceCeiling(asks, { isAdmin: true }).scopes).not.toContain('admin');
    const cli = { ...requests.cli, requestedScopes: ['tasks:write' as const, 'admin' as const] };
    expect(deviceCeiling(cli, { isAdmin: true }).scopes).toContain('admin');
    expect(deviceCeiling(cli, { isAdmin: false }).scopes).not.toContain('admin');
  });

  test('step-up: the existing grant pre-fills where; the capabilities it lacks are new', () => {
    const { value } = deviceStart(requests.stepUp, orgs);
    expect(value.constraints).toEqual(requests.stepUp.existing?.constraints);
    expect(deviceNewScopes(requests.stepUp)).toEqual(['tasks:write', 'comments:write']);
    expect(deviceNewScopes(requests.app)).toEqual([]);
  });

  test('"This session only" is sent as sessionOnly, and only when offered', () => {
    const { value } = deviceStart(requests.app, orgs);
    const session = { ...value, expiry: 'session' as const };
    const body = toDeviceApprove(session, requests.app);
    expect(body).toMatchObject({ sessionOnly: true, decisionNonce: requests.app.decisionNonce });
    expect(body).not.toHaveProperty('expiresInDays');
    expect(toDeviceApprove(session, requests.cli)).not.toHaveProperty('sessionOnly');
    expect(toDeviceApprove(value, requests.app)).toMatchObject({ expiresInDays: 90 });
  });

  test('429 on a code lookup is "too many wrong codes"', () => {
    expect(deviceErrorKind(new ApiError('rate_limited', 429))).toBe('tooMany');
    expect(deviceErrorKind(new ApiError('not_found', 404))).toBe('notFound');
  });
});

describe('/device: the full-context request (11 §9.3)', () => {
  test('an app: its name, Unverified with its domain, never a logo; the account', () => {
    renderDevice();
    const title = screen.getByTestId('device-title');
    expect(title.textContent).toBe('Connect a device');
    expect(document.activeElement).toBe(title);
    expect(screen.getByTestId('device-client-name').textContent).toBe('Acme Agent');
    expect(screen.getByTestId('device-unverified').textContent).toBe('Unverified');
    expect(screen.getByTestId('device-client-domain').textContent).toBe('agent.acme.example');
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByTestId('device-account').textContent).toBe('jannik@example.com');
    expect(screen.getByText(/wants access to your rooster account/)).toBeTruthy();
  });

  test('the code to compare, the request IP and age, and the warning', () => {
    renderDevice();
    expect(screen.getByTestId('device-user-code').textContent).toBe('KXRT-49WM');
    expect(screen.getByText('Check that your device shows the same code.')).toBeTruthy();
    expect(screen.getByTestId('device-origin').textContent).toBe(
      '203.0.113.7 · started 1 minute ago',
    );
    expect(screen.getByTestId('device-warning').textContent).toBe(
      'Only continue if you started this yourself, just now, on a device you control. Nobody from rooster will ever ask you for this code.',
    );
    expect(screen.getByTestId('device-resource').textContent).toBe('rooster for AI agents (MCP)');
  });

  test('rooster CLI is named by rooster, without Unverified or a domain', () => {
    renderDevice({
      state: { kind: 'request', request: { ...requests.cli, clientName: 'Evil (official)' } },
    });
    expect(screen.getByTestId('device-client-name').textContent).toBe('rooster CLI');
    expect(screen.queryByTestId('device-unverified')).toBeNull();
    expect(screen.queryByTestId('device-client-domain')).toBeNull();
    expect(screen.getByTestId('device-warning')).toBeTruthy();
  });

  test('a request without an IP shows only its age; the legacy flow shows neither', () => {
    renderDevice({ state: { kind: 'request', request: { ...requests.cli, requestIp: null } } });
    expect(screen.getByTestId('device-origin').textContent).toBe('Started 2 minutes ago');
  });

  test('the legacy CLI flow (no IP, no age, no resource) leaves the lines out', () => {
    renderDevice({
      state: {
        kind: 'request',
        request: {
          ...cliDeviceRequestFields,
          userCode: fixtureUserCode,
          clientId: 'rooster-cli',
          clientName: 'rooster CLI',
          requestedScopes: ['tasks:read'],
          expiresAt: now + 600_000,
          decisionNonce: 'n',
        },
      },
    });
    expect(screen.queryByTestId('device-origin')).toBeNull();
    expect(screen.queryByTestId('device-resource')).toBeNull();
    expect(screen.getByTestId('device-user-code').textContent).toBe('WDJB-MJHT');
  });

  test('Deny comes first in the reading order, as large as Allow', () => {
    renderDevice();
    const deny = screen.getByTestId('device-deny');
    const allow = screen.getByTestId('device-approve');
    expect(deny.compareDocumentPosition(allow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(deny.textContent).toBe('Deny');
    expect(allow.textContent).toBe('Allow');
  });

  test('an app: delete is unticked, admin never offered, "This session only" offered', () => {
    renderDevice({
      isAdmin: true,
      state: {
        kind: 'request',
        request: { ...requests.app, requestedScopes: ['tasks:delete', 'admin'] },
      },
    });
    const del = screen.getByRole('checkbox', { name: /Allow deleting tasks/ }) as HTMLInputElement;
    expect(del.checked).toBe(false);
    expect(screen.queryByRole('checkbox', { name: /Administer the server/ })).toBeNull();
    expect(screen.getAllByText('This session only').length).toBeGreaterThan(0);
  });

  test('rooster CLI: no "This session only"', () => {
    renderDevice({ state: { kind: 'request', request: requests.cli } });
    expect(screen.queryAllByText('This session only')).toHaveLength(0);
  });

  test('Allow sends the narrowed grant with the nonce; session only as sessionOnly', async () => {
    const { value } = deviceStart(requests.app, orgs);
    const props = renderDevice({ initialValue: { ...value, expiry: 'session' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('device-approve'));
    });
    expect(props.onApprove).toHaveBeenCalledWith({
      decisionNonce: requests.app.decisionNonce,
      scopes: ['tasks:write'],
      constraints: value.constraints,
      sessionOnly: true,
    });
  });

  test('Allow drops groups the server no longer confirms', async () => {
    const confirmOrgs = vi.fn(async () =>
      orgs.map((org) =>
        org.isPersonal
          ? { ...org, groups: org.groups?.filter((group) => group.id !== g.personalHome) }
          : org,
      ),
    );
    const props = renderDevice({
      state: { kind: 'request', request: requests.stepUp },
      confirmOrgs,
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('device-approve'));
    });
    expect(confirmOrgs).toHaveBeenCalled();
    expect(props.onApprove).toHaveBeenCalledWith(
      expect.objectContaining({
        constraints: {
          orgs: [{ orgId: personal, read: { groups: [g.personalInbox] }, write: 'none' }],
        },
      }),
    );
  });

  test('reconnect: what the grant already has is shown, but only what this request covers is sent', async () => {
    // The server checks the approval against this request and merges the grant's own scopes
    // (11 §9.4); sending `comments:write` here was refused as widening, with no way out.
    const reconnect = {
      ...requests.stepUp,
      requestedScopes: ['tasks:write' as const],
      existing: {
        scopes: ['comments:write' as const],
        constraints: { orgs: [{ orgId: personal, read: 'all' as const, write: 'all' as const }] },
      },
    };
    const props = renderDevice({ state: { kind: 'request', request: reconnect } });
    const comment = screen.getByRole('checkbox', { name: /Comment/ }) as HTMLInputElement;
    expect(comment.checked).toBe(true);
    expect(comment.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId('device-approve'));
    });
    expect(props.onApprove).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['tasks:write'] }),
    );
    expect(toDeviceApprove(deviceStart(reconnect, orgs).value, reconnect).scopes).toEqual([
      'tasks:write',
    ]);
  });

  test('reconnect: approving nothing this request asks for is blocked and explained', () => {
    const reconnect = {
      ...requests.stepUp,
      requestedScopes: ['notifications:read' as const],
      existing: {
        scopes: ['comments:write' as const],
        constraints: { orgs: [{ orgId: personal, read: 'all' as const, write: 'all' as const }] },
      },
    };
    const props = renderDevice({ state: { kind: 'request', request: reconnect } });
    expect(screen.queryByTestId('device-nothing-new')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Read notifications/ }));
    expect(screen.getByTestId('device-nothing-new').textContent).toContain(
      'Approve at least one capability',
    );
    expect((screen.getByTestId('device-approve') as HTMLButtonElement).disabled).toBe(true);
    expect(props.onApprove).not.toHaveBeenCalled();
  });

  test('step-up: banner, new capabilities marked, what it has is kept', () => {
    renderDevice({ state: { kind: 'request', request: requests.stepUp } });
    expect(screen.getByText(/already has access and is asking for more/)).toBeTruthy();
    expect(within(screen.getByTestId('scope-comments:write')).getByText('New')).toBeTruthy();
    const see = screen.getByRole('checkbox', { name: /See tasks/ }) as HTMLInputElement;
    expect(see.checked).toBe(true);
  });

  test('Deny answers without a grant', async () => {
    const props = renderDevice();
    await act(async () => {
      fireEvent.click(screen.getByTestId('device-deny'));
    });
    expect(props.onDeny).toHaveBeenCalled();
    expect(props.onApprove).not.toHaveBeenCalled();
  });

  test('done: an app sends the user back to the device and names Connected apps', () => {
    renderDevice({ state: { kind: 'approved', clientName: 'Acme Agent', app: true } });
    expect(screen.getByTestId('device-done').textContent).toContain('Connected apps');
  });
});

describe('/device: the code (11 §9.2: typed, never auto-submitted from a link)', () => {
  test('a code from the link is shown to confirm, and looked up only on Continue', () => {
    const props = renderDevice({
      state: { kind: 'enter', code: 'kxrt49wm', prefilled: true },
    });
    expect(props.onSubmitCode).not.toHaveBeenCalled();
    const field = screen.getByRole('textbox', { name: 'Code' }) as HTMLInputElement;
    expect(field.value).toBe('KXRT-49WM');
    expect(screen.getByText(/Continue only if your device shows the same code/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(props.onSubmitCode).toHaveBeenCalledWith('KXRT49WM');
  });

  test('too many wrong codes is explained', () => {
    renderDevice({ state: { kind: 'enter', code: fixtureUserCode, error: 'tooMany' } });
    expect(screen.getByRole('alert').textContent).toContain('Too many wrong codes');
  });
});

describe('Connected apps: MCP tokens (11 §9.7)', () => {
  function renderApps(overrides: Partial<ConnectedAppsSectionProps> = {}) {
    const props: ConnectedAppsSectionProps = {
      grants: fixtureGrants(now),
      orgs,
      prefs,
      now,
      isAdmin: true,
      baseUrl: 'https://rooster.example.com',
      onCreateToken: vi.fn(),
      onUpdate: vi.fn(async () => undefined),
      onRevoke: vi.fn(async () => undefined),
      ...overrides,
    };
    render(<ConnectedAppsSection {...props} />);
    return props;
  }

  test('"Works with: MCP" sends the audience and takes admin off the table', async () => {
    const mcp = fixtureGrants(now).find((grant) => grant.audience === 'mcp');
    if (!mcp) throw new Error('fixture');
    const onCreateToken = vi.fn(async () => ({ token: 'rooster_pat_secret', grant: mcp }));
    renderApps({ onCreateToken });
    fireEvent.click(screen.getByTestId('new-token'));
    const form = screen.getByTestId('new-token-form');
    expect(within(form).getByRole('checkbox', { name: /Administer the server/ })).toBeTruthy();
    fireEvent.click(within(form).getByRole('radio', { name: 'MCP' }));
    expect(within(form).queryByRole('checkbox', { name: /Administer the server/ })).toBeNull();
    expect(within(form).getByText(/can’t administer the server/)).toBeTruthy();
    fireEvent.change(within(form).getByRole('textbox', { name: /Name/ }), {
      target: { value: 'Agent' },
    });
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Create token' }));
    });
    expect(onCreateToken).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Agent', audience: 'mcp', scopes: ['tasks:read'] }),
    );
    const reveal = screen.getByTestId('token-reveal');
    const lines = within(reveal).getAllByTestId('mcp-setup-line');
    expect(lines).toHaveLength(3);
    expect(lines[0]?.textContent).toContain(
      'claude mcp add --transport http rooster https://rooster.example.com/mcp --header "Authorization: Bearer rooster_pat_secret"',
    );
    expect(lines[1]?.textContent).toContain('bearer_token_env_var = "ROOSTER_MCP_TOKEN"');
    expect(lines[2]?.textContent).toContain('export ROOSTER_MCP_TOKEN="rooster_pat_secret"');
  });

  test('an API token is created as before, without setup lines', async () => {
    const pat = fixtureGrants(now)[1];
    if (!pat) throw new Error('fixture');
    const onCreateToken = vi.fn(async () => ({ token: 'rooster_pat_secret', grant: pat }));
    renderApps({ onCreateToken });
    fireEvent.click(screen.getByTestId('new-token'));
    const form = screen.getByTestId('new-token-form');
    fireEvent.change(within(form).getByRole('textbox', { name: /Name/ }), {
      target: { value: 'Script' },
    });
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Create token' }));
    });
    expect(onCreateToken).toHaveBeenCalledWith(expect.objectContaining({ audience: 'api' }));
    expect(screen.queryByTestId('mcp-setup')).toBeNull();
  });

  test('rows show where a token works; the notice’s grant is marked', () => {
    renderApps({ focusGrantId: '0192f5d0-7a1e-7c3a-9f10-00000000c005' });
    const mcp = screen.getByTestId('grant-0192f5d0-7a1e-7c3a-9f10-00000000c005');
    expect(within(mcp).getByText('MCP')).toBeTruthy();
    expect(mcp.hasAttribute('data-focused')).toBe(true);
    const pat = screen.getByTestId('grant-0192f5d0-7a1e-7c3a-9f10-00000000c002');
    expect(within(pat).getByText('API')).toBeTruthy();
    expect(pat.hasAttribute('data-focused')).toBe(false);
  });

  test('setup lines trim a trailing slash from the base URL', () => {
    expect(mcpSetupLines('t', 'https://r.example/')[1]?.text).toContain(
      'url = "https://r.example/mcp"',
    );
  });
});
