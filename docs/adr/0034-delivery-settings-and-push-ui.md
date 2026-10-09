# ADR 0034: Notification settings and push in the web app (Phase 7)

- Status: accepted
- Date: 2026-10-09
- Amends: 02 §13.5 (push on iOS), FR-NOT-2 (the permission prompt), FR-NOT-4 (the settings matrix)
- Code: `apps/web/src/data/push.ts`, `features/settings/{notifications-page,push-device-section}.tsx`, `features/pwa/{push-support,push-resubscribe,sw-enabled}.ts`, `features/admin/push-keys-section.tsx`, `src/sw.ts`

## Decisions
1. **The matrix follows the server's features.** Columns appear only for channels the instance has: email needs `features.email`, push needs `features.push`. A row with no visible cell is hidden, such as the digest without email. Phones get a stacked list per event, with rows at least 44 px tall. Without SMTP nothing mentions email (AC-7.3).
2. **Timing** has the reminder time (with push), and the digest time and the email mode (with email). Times are selects in half-hour steps in the user's time format and timezone. A stored time off that grid stays selectable.
3. **"Push is on" for this device** needs three things at once: a browser subscription on the current VAPID key, the server listing it, and permission `granted`. A device removed elsewhere, or dropped by the server, reads "off", and turning it on again re-registers it (an upsert).
4. **The permission prompt** comes only from the "Turn on push for this device" button. `Notification.requestPermission()` is its first await, and the VAPID key is fetched when the page loads, so the gesture is never spent on a network call.
5. **Key rotation.**
   - On app open, the app re-subscribes silently only where this user turned push on in this browser (a per-user marker under `userStorageKey`) and permission is still granted.
   - A device the user removed is never re-added.
   - The service worker's `pushsubscriptionchange` handler re-subscribes and posts with the session cookie. If that fails, the next app open fixes it.
6. **iOS**: an iPhone or iPad that isn't running the installed app gets the "Add rooster to your Home Screen first" hint, which opens the existing install sheet. Without a service worker or `PushManager`, the section says push is unavailable.
7. **Endpoint rejected**: when the browser's push service is not on the allowlist (ADR 0033), the subscription is dropped and a toast explains why.
8. **"Send test"** against a device the server has dropped (`410 push_gone`) explains that the device is no longer subscribed and refreshes the list.
9. **Invites**: when the server emailed the invite, a toast says so and the copyable link stays. Without SMTP, nothing promises an email.
10. **Admin → Regenerate push keys** appears only with push, and uses an inline confirm in the danger-zone style (no modal).
11. **Bundle**: the push code is a lazy chunk. The initial route gains only the features query and the service-worker check.
