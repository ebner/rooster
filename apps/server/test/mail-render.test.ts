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

  it('the header logo is an inline picture with the name as its alt text (ADR 0059)', async () => {
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
    expect(html).toMatch(/<img[^>]+src="cid:logo@rooster"[^>]+alt="rooster"/);
    expect(text).not.toContain('cid:');
  });

  it('nodemailer gets the logo as an inline attachment with its Content-ID', async () => {
    const { nodemailerMessage } = await import('../src/mail/transport.ts');
    const { mailLogo } = await import('../src/mail/logo.ts');
    const MailComposer = (await import('nodemailer/lib/mail-composer/index.js')).default;
    const png = Buffer.from(mailLogo.png, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const message = nodemailerMessage({
      from: 'rooster <noreply@example.com>',
      to: 'ann@example.com',
      subject: 'Hi',
      html: '<img src="cid:logo@rooster">',
      text: 'Hi',
      headers: {},
      inline: [
        { cid: 'logo@rooster', filename: 'rooster.png', contentType: 'image/png', content: png },
      ],
    });
    const raw = await new Promise<string>((resolve, reject) =>
      new MailComposer(message)
        .compile()
        .build((err, out) => (err ? reject(err) : resolve(out.toString()))),
    );
    expect(raw).toMatch(/Content-Type: multipart\/related/);
    expect(raw).toContain('Content-ID: <logo@rooster>');
    expect(raw).toContain('Content-Disposition: inline; filename=rooster.png');
  });
});
