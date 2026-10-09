import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ApiError } from '../../data/errors';
import { consentErrorKind } from '../../data/oauth-consent';
import type { DisplayPrefs } from '../../lib/format';
import { fixtureIds } from '../shell/fixtures';
import {
  cleanClientText,
  displayDomain,
  externalRedirect,
  httpsLogo,
  resourceKind,
  signedOAuthQuery,
} from './client-display';
import { NewTokenForm } from './connected-apps';
import { ConsentPage, type ConsentPageProps } from './consent-page';
import { DevicePage } from './device-page';
import {
  fixtureConsentRequests,
  fixtureGrantOrgs,
  fixtureGroupIds,
  fixtureUserCode,
} from './fixtures';
import {
  consentCeiling,
  consentScopes,
  defaultConsentValue,
  defaultDeviceValue,
  offeredScopes,
  toConsentDecision,
} from './grant-model';

const prefs: DisplayPrefs = {
  locale: 'en',
  timezone: 'Europe/Stockholm',
  dateFormat: 'MMM d',
  timeFormat: '24h',
};
const now = Date.UTC(2026, 9, 9, 10);
const orgs = fixtureGrantOrgs;
const personal = fixtureIds.personalOrg;
const acme = fixtureIds.companyOrg;
const requests = fixtureConsentRequests(now);

describe('consent defaults (11 §3.1: least privilege)', () => {
  test('read only: every current org listed (never "all"), writing nothing', () => {
    const value = defaultConsentValue(
      { ...requests.verified, requestedScopes: ['tasks:read'] },
      orgs,
    );
    expect(value.scopes).toEqual(['tasks:read']);
    expect(value.constraints).toEqual({
      orgs: [
        { orgId: personal, read: 'all', write: 'none' },
        { orgId: acme, read: 'all', write: 'none' },
      ],
    });
    expect(value.expiry).toBe(90);
  });

  test('tasks:write requested: write only in the personal Inbox', () => {
    const value = defaultConsentValue(requests.verified, orgs);
    expect(value.scopes).toEqual(['tasks:write']);
    expect(value.constraints).toEqual({
      orgs: [
        { orgId: personal, read: 'all', write: { groups: [fixtureGroupIds.personalInbox] } },
        { orgId: acme, read: 'all', write: 'none' },
      ],
    });
  });

  test('"Allow deleting tasks" starts unticked, keeping what delete implies', () => {
    const value = defaultConsentValue(
      { ...requests.verified, requestedScopes: ['tasks:delete', 'comments:write'] },
      orgs,
    );
    expect(value.scopes).toEqual(['tasks:write', 'comments:write']);
    expect(value.scopes).not.toContain('tasks:delete');
  });

  test('step-up: the existing grant pre-fills where; delete stays as the user left it', () => {
    const stepUp = requests.stepUp;
    const value = defaultConsentValue(stepUp, orgs);
    expect(value.constraints).toEqual(stepUp.existing?.constraints);
    expect(value.scopes).not.toContain('tasks:delete');
    const deleting = defaultConsentValue(
      {
        ...stepUp,
        existing: stepUp.existing && { ...stepUp.existing, scopes: ['tasks:delete'] },
      },
      orgs,
    );
    expect(deleting.scopes).toContain('tasks:delete');
  });

  test('step-up of a session-only grant offers "This session only" again', () => {
    const existing = requests.stepUp.existing;
    if (!existing) throw new Error('fixture');
    const value = defaultConsentValue(
      { ...requests.stepUp, existing: { ...existing, idleTimeoutMs: 86_400_000 } },
      orgs,
    );
    expect(value.expiry).toBe('session');
  });

  test('authorization_details pre-fill the screen and are the ceiling', () => {
    const prefill = {
      orgs: [
        { orgId: acme, read: 'all' as const, write: { groups: [fixtureGroupIds.companyPrio] } },
      ],
    };
    const request = { ...requests.verified, prefill };
    expect(defaultConsentValue(request, orgs).constraints).toEqual(prefill);
    expect(consentCeiling(request)).toEqual({ scopes: ['tasks:write'], constraints: prefill });
  });

  test('admin is never offered to an OAuth client, even if the server slipped', () => {
    const request = { ...requests.verified, requestedScopes: ['tasks:read', 'admin'] as const };
    expect(consentScopes({ requestedScopes: [...request.requestedScopes] })).toEqual([
      'tasks:read',
    ]);
  });

  test('the decision: minimal scopes; session only → sessionOnly, else the day count', () => {
    const value = defaultConsentValue(requests.verified, orgs);
    expect(toConsentDecision({ ...value, expiry: 'session' }, 'q')).toEqual({
      accept: true,
      oauthQuery: 'q',
      scopes: ['tasks:write'],
      constraints: value.constraints,
      sessionOnly: true,
    });
    const days = toConsentDecision({ ...value, expiry: 30 }, 'q');
    expect(days).toMatchObject({ expiresInDays: 30 });
    expect(days).not.toHaveProperty('sessionOnly');
    expect(toConsentDecision({ ...value, expiry: 'never' }, 'q')).not.toHaveProperty(
      'expiresInDays',
    );
  });
});

describe('client display (11 §7: consent phishing)', () => {
  test('client text loses control and bidi characters and is capped', () => {
    expect(cleanClientText('Task Helper\u202e (official)')).toBe('Task Helper (official)');
    expect(cleanClientText('  a\n\tb\u200bc ')).toBe('a bc');
    const long = cleanClientText('x'.repeat(200));
    expect(Array.from(long)).toHaveLength(48);
    expect(long.endsWith('…')).toBe(true);
  });

  test('domains show in punycode, logos only over https, redirects only to http(s)', () => {
    expect(displayDomain('аpple.example')).toBe('xn--pple-43d.example');
    expect(displayDomain('Claude.AI')).toBe('claude.ai');
    expect(httpsLogo('https://claude.ai/logo.png')).toBe('https://claude.ai/logo.png');
    expect(httpsLogo('http://claude.ai/logo.png')).toBeNull();
    expect(httpsLogo('data:image/png;base64,AAAA')).toBeNull();
    const shown = 'https://claude.ai/cb';
    expect(externalRedirect('https://claude.ai/cb?code=1&iss=x', shown)).toBe(
      'https://claude.ai/cb?code=1&iss=x',
    );
    expect(externalRedirect('http://127.0.0.1:5000/cb?code=1', 'http://127.0.0.1:5000/cb')).toBe(
      'http://127.0.0.1:5000/cb?code=1',
    );
    expect(externalRedirect('javascript:alert(1)', shown)).toBeNull();
    expect(externalRedirect('/relative', shown)).toBeNull();
    expect(externalRedirect('https://evil.example/cb?code=1', shown)).toBeNull();
    expect(externalRedirect('https://claude.ai/other?code=1', shown)).toBeNull();
  });

  test('the resource names what the token is for', () => {
    expect(resourceKind('https://r.example.com/mcp')).toBe('mcp');
    expect(resourceKind('https://r.example.com/api/v1/')).toBe('api');
    expect(resourceKind('nonsense')).toBe('other');
  });

  test('the signed query keeps the signed parameters only, as the plugin does', () => {
    const search =
      '?client_id=c&scope=tasks%3Aread&exp=9&ba_param=client_id&ba_param=exp&ba_param=scope&sig=s&utm=x';
    expect(signedOAuthQuery(search)).toBe(
      'client_id=c&scope=tasks%3Aread&exp=9&ba_param=client_id&ba_param=exp&ba_param=scope&sig=s',
    );
    expect(signedOAuthQuery('?client_id=c')).toBeUndefined();
    expect(signedOAuthQuery('?client_id=c&sig=s')).toBeUndefined();
  });

  test('server errors: 4xx means start again, the rest may be retried', () => {
    expect(consentErrorKind(new ApiError('invalid_request', 400))).toBe('invalid');
    expect(consentErrorKind(new ApiError('not_found', 404))).toBe('invalid');
    expect(consentErrorKind(new ApiError('http_500', 500))).toBe('failed');
    expect(consentErrorKind(new ApiError('rate_limited', 429))).toBe('failed');
    expect(consentErrorKind(new Error('offline'))).toBe('failed');
  });
});

function renderConsent(overrides: Partial<ConsentPageProps> = {}) {
  const props: ConsentPageProps = {
    state: { kind: 'request', request: requests.verified },
    account: 'jannik@example.com',
    orgs,
    prefs,
    now,
    onAllow: vi.fn(async () => undefined),
    onDeny: vi.fn(async () => undefined),
    homeHref: '/',
    ...overrides,
  };
  render(<ConsentPage {...props} />);
  return props;
}

describe('/oauth/consent', () => {
  test('a verified client: name, domain and badge; focus starts on the title', () => {
    renderConsent();
    const title = screen.getByTestId('consent-title');
    expect(title.textContent).toBe('Allow Claude to use your rooster account?');
    expect(document.activeElement).toBe(title);
    expect(screen.getByTestId('consent-domain').textContent).toBe('claude.ai');
    expect(screen.getByTestId('consent-verified').textContent).toBe('Verified');
    expect(screen.getByTestId('consent-redirect').textContent).toContain(
      'https://claude.ai/api/mcp/auth_callback',
    );
    expect(screen.getByText('rooster for AI agents (MCP)')).toBeTruthy();
  });

  test('an unverified DCR client is flagged, its name cleaned, its http logo dropped', () => {
    renderConsent({ state: { kind: 'request', request: requests.dynamic } });
    expect(screen.getByTestId('consent-unverified').textContent).toBe('Unverified app');
    expect(screen.getByText(/This app registered itself/)).toBeTruthy();
    expect(screen.getByTestId('consent-title').textContent).toBe(
      'Allow Task Helper (official) to use your rooster account?',
    );
    expect(screen.queryByTestId('consent-logo')).toBeNull();
    expect(screen.getByText('The rooster API')).toBeTruthy();
  });

  test('a loopback redirect reads "an app on this computer"', () => {
    renderConsent({ state: { kind: 'request', request: requests.loopback } });
    expect(screen.getByTestId('consent-redirect').textContent).toContain('An app on this computer');
  });

  test('step-up marks new capabilities; delete is its own unticked checkbox', async () => {
    const props = renderConsent({ state: { kind: 'request', request: requests.stepUp } });
    expect(screen.getByText(/already has access and is asking for more/)).toBeTruthy();
    const comment = screen.getByTestId('scope-comments:write');
    expect(within(comment).getByText('New')).toBeTruthy();
    expect(screen.queryByTestId('scope-tasks:delete')).toBeNull();
    const allow = screen.getByRole('checkbox', {
      name: /Allow deleting tasks/,
    }) as HTMLInputElement;
    expect(allow.checked).toBe(false);
    expect(within(screen.getByTestId('allow-delete')).getByText('New')).toBeTruthy();
    fireEvent.click(allow);
    expect(allow.checked).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId('consent-approve'));
    });
    expect(props.onAllow).toHaveBeenCalledWith(
      expect.objectContaining({ accept: true, scopes: ['comments:write', 'tasks:delete'] }),
    );
  });

  test('a first request marks nothing as "New", even if the server lists every scope', () => {
    renderConsent({
      state: {
        kind: 'request',
        request: { ...requests.verified, newScopes: ['tasks:write', 'tasks:read'] },
      },
    });
    expect(screen.queryByText('New')).toBeNull();
  });

  test('no delete checkbox when the client did not ask for it', () => {
    renderConsent();
    expect(screen.queryByRole('checkbox', { name: /Allow deleting tasks/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Administer/ })).toBeNull();
  });

  test('"This session only" is offered and sent as sessionOnly', async () => {
    const value = defaultConsentValue(requests.verified, orgs);
    const props = renderConsent({ initialValue: { ...value, expiry: 'session' } });
    expect(screen.getAllByText('This session only').length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getByTestId('consent-approve'));
    });
    expect(props.onAllow).toHaveBeenCalledWith(
      expect.objectContaining({ sessionOnly: true, oauthQuery: requests.verified.oauthQuery }),
    );
    expect(props.onAllow).not.toHaveBeenCalledWith(
      expect.objectContaining({ expiresInDays: expect.anything() }),
    );
  });

  test('Deny answers without a grant', async () => {
    const props = renderConsent();
    await act(async () => {
      fireEvent.click(screen.getByTestId('consent-deny'));
    });
    expect(props.onDeny).toHaveBeenCalled();
    expect(props.onAllow).not.toHaveBeenCalled();
  });

  test('an expired or invalid request explains what to do', () => {
    renderConsent({ state: { kind: 'invalid' } });
    expect(screen.getByRole('alert').textContent).toContain('Go back to the app');
  });

  test('a failed load offers a retry', () => {
    const onRetry = vi.fn();
    renderConsent({ state: { kind: 'failed' }, onRetry });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('admin capability (ADR 0041/0042)', () => {
  const request = {
    userCode: fixtureUserCode,
    clientId: 'rooster-cli',
    clientName: 'rooster CLI',
    expiresAt: now + 600_000,
  };

  test('the device page never shows admin to a non-admin, even when requested', () => {
    expect(defaultDeviceValue(['tasks:write', 'admin']).scopes).toEqual(['tasks:write']);
    render(
      <DevicePage
        state={{
          kind: 'request',
          request: { ...request, requestedScopes: ['tasks:write', 'admin'] },
        }}
        account="a@example.com"
        orgs={orgs}
        prefs={prefs}
        now={now}
        onSubmitCode={vi.fn()}
        onApprove={vi.fn(async () => undefined)}
        onDeny={vi.fn(async () => undefined)}
        homeHref="/"
      />,
    );
    expect(screen.queryByRole('checkbox', { name: /Administer the server/ })).toBeNull();
  });

  test('an admin sees it ticked when the CLI asked, and delete starts as requested', async () => {
    const onApprove = vi.fn(async () => undefined);
    render(
      <DevicePage
        state={{
          kind: 'request',
          request: { ...request, requestedScopes: ['tasks:delete', 'admin'] },
        }}
        account="a@example.com"
        isAdmin
        orgs={orgs}
        prefs={prefs}
        now={now}
        onSubmitCode={vi.fn()}
        onApprove={onApprove}
        onDeny={vi.fn(async () => undefined)}
        homeHref="/"
      />,
    );
    const admin = screen.getByRole('checkbox', {
      name: /Administer the server/,
    }) as HTMLInputElement;
    expect(admin.checked).toBe(true);
    const del = screen.getByRole('checkbox', { name: /Allow deleting tasks/ }) as HTMLInputElement;
    expect(del.checked).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId('device-approve'));
    });
    expect(onApprove).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['tasks:delete', 'admin'] }),
    );
  });

  test('an admin but not requested: not offered on the device page', () => {
    expect(offeredScopes({ scopes: ['tasks:read'] }, { admin: true })).toEqual(['tasks:read']);
  });

  test('new tokens offer admin, unticked, to admins only', () => {
    const { unmount } = render(
      <NewTokenForm orgs={orgs} prefs={prefs} now={now} onCancel={vi.fn()} onCreate={vi.fn()} />,
    );
    expect(screen.queryByRole('checkbox', { name: /Administer the server/ })).toBeNull();
    unmount();
    render(
      <NewTokenForm
        orgs={orgs}
        offerAdmin
        prefs={prefs}
        now={now}
        onCancel={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    const admin = screen.getByRole('checkbox', {
      name: /Administer the server/,
    }) as HTMLInputElement;
    expect(admin.checked).toBe(false);
  });
});
