import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { NotInvitedPage, parseNotInvitedReason } from './not-invited-page';

describe('not-invited reasons', () => {
  test.each(['not_invited', 'account_disabled', 'unverified_email', 'account_link_blocked'])(
    'knows %s',
    (reason) => {
      expect(parseNotInvitedReason(reason)).toBe(reason);
    },
  );

  test.each(['', 'nope', 'toString', '__proto__', 42, undefined])(
    'falls back to the generic text for %j',
    (reason) => {
      expect(parseNotInvitedReason(reason)).toBe('not_invited');
    },
  );

  test('account_link_blocked tells the user to sign in the usual way', () => {
    render(<NotInvitedPage reason="account_link_blocked" loginHref="/login" />);
    expect(screen.getByRole('heading', { name: 'Sign in the way you did before' })).toBeTruthy();
    expect(screen.getByText(/can’t be used for an existing account/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to sign-in' }).getAttribute('href')).toBe(
      '/login',
    );
  });

  test('an unknown reason renders the generic page', () => {
    render(<NotInvitedPage reason={parseNotInvitedReason('weird')} loginHref="/login" />);
    expect(screen.getByRole('heading', { name: 'You’re not on the list yet' })).toBeTruthy();
  });
});
