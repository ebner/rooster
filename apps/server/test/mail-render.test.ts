// The production bundle replaces prettier with a throwing stub (tsdown.config.ts `alias`):
// rendering must never reach it.
import { describe, expect, it, vi } from 'vitest';

vi.mock('prettier/standalone', () => import('../src/mail/prettier-stub.ts'));
vi.mock('prettier/plugins/html', () => import('../src/mail/prettier-stub.ts'));

const { renderMail } = await import('../src/mail/render.ts');
const { mailT } = await import('../src/mail/i18n.ts');
const { InviteEmail } = await import('../src/mail/templates/invite.tsx');
const { format } = await import('../src/mail/prettier-stub.ts');

describe('email rendering without prettier', () => {
  it('renders HTML and plain text through the stub, which throws if ever called', async () => {
    const { html, text } = await renderMail(
      InviteEmail({
        locale: 'en',
        t: mailT('en'),
        host: 'tasks.example.com',
        inviter: 'Ann',
        org: 'Acme',
        url: 'https://tasks.example.com/invite/abc',
        expires: 'October 16, 2026',
      }),
    );
    expect(html).toMatch(/^<!DOCTYPE html/);
    expect(html).toContain('Join Acme on rooster');
    expect(text).toContain('Accept invite https://tasks.example.com/invite/abc');
    expect(() => format()).toThrow(/not bundled/);
  });
});
