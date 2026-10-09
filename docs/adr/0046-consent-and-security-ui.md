# ADR 0046: Consent screen, device page and linked identities (web)

- Status: accepted
- Date: 2026-10-09
- Amends: 11 §3.1–§3.2; 02 (Settings → Security)
- Code: `apps/web/src/routes/oauth.consent.tsx`, `apps/web/src/features/access/{consent-page,consent-frame,client-display,device-page,connected-apps,grant-model}.ts*`, `apps/web/src/features/settings/linked-identities.tsx`, `apps/web/src/data/{oauth-consent,identities}.ts`

## Decisions
1. **Deleting is its own checkbox** on both consent pages (OAuth and `/device`): "Allow deleting tasks", shown only when `tasks:delete` was requested.
   - It is unticked by default for OAuth, and starts as requested on the device page.
   - The Settings editors keep it as a "Delete" capability row.
2. **The signed provider query is read once from the raw URL** on `/oauth/consent` and `/login`, then kept as one opaque `oauth_query`. The router re-serialises the search on first render, which would break the signature. `/login` passes it to `signIn.social` so better-auth resumes the authorization. With an OAuth query present, `/login` doesn't auto-redirect a signed-in user, so `prompt=login` still works.
3. **Step-up:**
   - Deleting stays ticked only if the existing grant already deletes, and "session only" stays only if the existing grant is session-only.
   - "New" scope markers appear only on step-up.
4. **The redirect after a decision is bound to what the screen showed:**
   - `window.location.assign(redirectTo)` runs only when `redirectTo` is http(s) and has the same origin and path as the displayed `redirectUri`.
   - This is the app's only external navigation, and it can't use `safeRedirectPath`, which is for internal paths.
5. **Client-supplied text** is treated as hostile:
   - Control, format, bidi and zero-width characters are stripped, and names are capped at 48 characters.
   - Domains are shown in punycode (look-alikes).
   - Logos are https-only, loaded with `referrerPolicy="no-referrer"`.
   - The client name appears only inside rooster's own sentences.
   - Loading a logo does reveal the user's IP to the client's host, as CSP `img-src https:` already allows for avatars.
   - An OAuth grant's label is shown cleaned, because it starts as the client name.
6. **Least-privilege defaults:**
   - Every current org is listed explicitly, never "all".
   - Writing defaults to nothing, or only the personal Inbox when `tasks:write` was requested.
   - The expiry defaults to 90 days.
   - `authorization_details` is both the starting point and the ceiling.
   - Focus lands on the title, never on Allow, and Deny comes first in the tab order.
7. **Admin:**
   - The `admin` capability is offered to admins only: on the device page (only when requested), and on new tokens (unticked).
   - Editing a grant offers it when the user is an admin or the grant already has it.
8. **Linked identities** sit in Settings → Security, between Signed-in devices and Connected apps, with an inline unlink confirm. The last identity can't be unlinked, and the page says why.
9. **Activity** shows `via: oauth` as "via an app". The activity DTO carries no client name, so "via Claude (MCP)" (11 §2.3) would need the server to record it.
10. **E2E** uses DCR (`ROOSTER_OAUTH_DCR=on` in the Playwright server env), because CIMD needs a public https host.
