# ADR 0059: The emails' logo, and a test email from Admin → System

- Status: accepted
- Date: 2026-10-12
- Builds on: ADR 0026 (the brand), ADR 0033–0035 (email delivery), ADR 0052 §7 (Admin → System)

## Context
The emails' header was the word "rooster" in Georgia: mail clients load neither web fonts nor SVG, and the brand's mark had no form an email could carry. Users noticed that the header matched neither the app's logo nor its typeface. Separately, an operator had no way to check the mail setup short of waiting for a digest, so a misconfigured relay (for example one that doesn't use TLS to the recipient) showed only in the recipients' mail clients.

## Decisions
1. **The header logo is a PNG, sent inline.**
   - `apps/web/scripts/render-icons.mjs` renders the `row` lockup (mark and the outlined Fraunces name, 28 px tall) at 2× from `brand.ts` and writes it, base64, to `apps/server/src/mail/logo.ts` (about 5 KB). The server bundle carries it; there is no file to ship or serve.
   - Every message attaches it with `Content-Disposition: inline` and `Content-ID: <logo@rooster>`, and the layout shows `<img src="cid:logo@rooster" alt="rooster">`. Inline images show without loading anything remote (Gmail, Apple Mail, Outlook), and nothing points at the instance, which may not be reachable from the reader's mail client.
   - The picture has the email page's own background colour (`bg-subtle`), not a transparent one: a mail app's dark mode can darken a transparent background under the black line.
   - Where images are blocked, the alt text shows the name in the old Georgia style.
2. **A test email from Admin → System** (`POST /api/v1/admin/mail/test`):
   - Instance admins, in the browser only (no token or app reaches it), and only ever to the caller's own address. It cannot be used to mail anyone else.
   - It goes through the delivery queue under the admin's email key and waits for the SMTP server. `200` with the address; `409 mail_not_configured` without SMTP; `502 mail_failed` when the server refuses or cannot be reached. The detail names only the shape-checked SMTP code, status and command (`sanitizeSmtpError`), never the server's text, as in the logs (ASVS 7.1.2).
   - The page shows the result inline, under "Email (SMTP)". There is no confirmation: it only mails the admin.
   - A test proves that rooster's SMTP server accepted the message. What happens after (the host's relay, TLS to the recipient, spam filtering) shows in the inbox; `docs/operator.md` covers the host Postfix case.

## Consequences
- Each email is about 5 KB larger.
- A change to the mark means rerunning `render-icons.mjs`, which now also rewrites the emails' logo.
