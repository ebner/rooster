import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { fixtureProviders } from './fixtures';
import { isLoginError, LoginPage } from './login-page';

describe('login errors', () => {
  test('identity_unlinked is a known error (FR-SET-3)', () => {
    expect(isLoginError('identity_unlinked')).toBe(true);
  });

  test('a removed sign-in explains how to use it again', () => {
    render(<LoginPage providers={fixtureProviders} error="identity_unlinked" onSignIn={vi.fn()} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('This sign-in was removed');
    expect(alert.textContent).toContain('sign in another way and allow it in Settings → Security');
    // The other providers stay right there to sign in another way.
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
  });
});
