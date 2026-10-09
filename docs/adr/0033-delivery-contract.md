# ADR 0033: The Phase 7 delivery contract

- Status: accepted
- Date: 2026-10-09
- Amends: 04 §2 (email templates), 05 §3 (`notification_pref` rows), 06 §2.6 (push routes, the preference matrix)
- Code: `packages/core/src/schemas/delivery.ts`, `packages/core/src/notification-prefs.ts`, `packages/core/src/schemas/collab.ts`, `packages/core/src/schemas/user.ts` (`emailMode`)

## Decisions
1. **The matrix has 20 cells.** Each of the six events has an in-app, push and email cell. The digest exists only as email (FR-NOT-3), and the due reminder only as push (FR-NOT-2). Any other cell is rejected (`422`).
2. **Defaults** for cells the user never touched:
   - In-app and push are on for every event. Push still needs a subscribed device, which is opt-in per device.
   - Email is on only for assignments and mentions, so a shared org doesn't flood anyone's mailbox.
   - The digest and the due reminder are off until the user turns them on.
   - Notification emails are batched every 15 minutes by default (`prefs.emailMode = 'batch'`).
3. **Push payloads** carry a localised `title` and `body`, a same-origin `url` and a `tag`, as `PushData` in the service worker already expects. The service worker has no i18n, so the server writes the text in the recipient's locale.
4. **Push subscriptions** upsert by `endpoint`, so re-subscribing a browser updates it rather than adding a duplicate. Settings lists the user's devices with each one's last successful delivery.
5. **Email templates** are React components rendered with `@react-email/render` (HTML plus a plain-text alternative). The `@react-email/components` package is deprecated, and its successor `react-email` brings its CLI's dependencies (esbuild, socket.io, babel). The few layouts are written as email-safe JSX with values from `@rooster/tokens`.
6. **Unsubscribe categories** are the six event types plus `digest`. Each link turns off exactly one category's email cell.
