import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { InvitesSection, type InvitesSectionProps } from './invites-section';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../ui/toast', () => ({ toast }));

function renderSection(overrides: Partial<InvitesSectionProps>) {
  const props: InvitesSectionProps = {
    invites: [],
    onCreate: vi.fn(async () => ({ id: 'i', kind: 'email' as const, url: 'https://x/invite/t' })),
    onRevoke: vi.fn(),
    prefs: { locale: 'en', timezone: 'Europe/Stockholm', dateFormat: 'MMM d', timeFormat: '24h' },
    now: Date.UTC(2026, 9, 5, 10),
    ...overrides,
  };
  render(<InvitesSection {...props} />);
  return props;
}

async function inviteByEmail(address: string) {
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: address } });
  fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));
  return screen.findByRole('textbox', { name: 'Invite link' });
}

describe('Invites and email delivery (AC-7.3)', () => {
  test('with SMTP: an emailed invite toasts "Invite sent" and still shows the link', async () => {
    toast.mockClear();
    renderSection({
      emailEnabled: true,
      onCreate: vi.fn(async () => ({
        id: 'i',
        kind: 'email' as const,
        url: 'https://x/invite/t',
        emailed: true,
      })),
    });
    expect(screen.getByText('Invite by email or share a link.')).toBeTruthy();
    const link = (await inviteByEmail('anna@example.com')) as HTMLInputElement;
    expect(link.value).toBe('https://x/invite/t');
    expect(toast).toHaveBeenCalledWith({ message: 'Invite sent to anna@example.com' });
    expect(screen.getByText(/on its way to anna@example.com/)).toBeTruthy();
  });

  test('without SMTP: no promise of an email, the link is to copy', async () => {
    toast.mockClear();
    renderSection({});
    expect(screen.getByText(/Until email delivery is set up/)).toBeTruthy();
    await inviteByEmail('anna@example.com');
    expect(toast).not.toHaveBeenCalled();
    expect(
      screen.getByText('Invite for anna@example.com created. Send them this link:'),
    ).toBeTruthy();
    expect(screen.queryByText(/Invite sent/)).toBeNull();
  });
});
