# ADR 0031: Comments, activity and the inbox in the web app (Phase 6)

- Status: accepted
- Date: 2026-10-09
- Amends: 02 §2 (no header bell), 02 §6 (composer and inbox keys), 02 §9.2 item 8, 02 §13.4
- Code: `apps/web/src/features/collab/*`, `features/pane/detail-pane.tsx`, `data/collab.ts`, `data/notifications.ts`, `data/sync/events.ts`, `keymap.ts` (`postComment`, `toggleRead`, `markAllRead`)

## Decisions
1. **Composer keys.**
   - The composer is neither `[data-no-chords]` nor a pane input, so Tab chords still reach the pane. Tab+Enter arrives as the `openPaneFocus` chord, and the pane turns it into "post" when focus is in `[data-comment-composer]`.
   - The composer handles Ctrl/⌘+Enter itself, and list keys never fire while typing.
   - While suggestions are open, ↑/↓, Enter, Tab and Esc belong to the autocomplete. Esc with nothing open returns to the list on desktop.
   - The registry's `postComment` entry (scope `composer`) documents the keys for the cheat sheet.
2. **Mention suggestions** are an inline listbox above the field (`aria-activedescendant`, with focus staying in the textarea), not a popover or a bottom sheet: on phones a sheet would take the focus and close the keyboard. The author is excluded, and matching ignores accents, with prefixes first, by name or email.
3. **"Comments only"** filters the loaded feed on the client. There is one cache, it works offline, and it holds the optimistic comments. The choice is remembered per user (`userStorageKey`).
4. **Drafts** are kept per task in memory. A draft is lost on reload and cleared at sign-out.
5. **Activity text** is the actor, then a predicate ("renamed this task to “X”").
   - The viewer is "You", and system work is "Rooster". Assigning to oneself reads "took this task".
   - Entries made somewhere other than the web or PWA name their source: "via the CLI", "the terminal app", "an AI assistant" or "import".
6. **Undo of a comment delete** is its own undo entry, whose inverse is `restoreComment`, with a toast and Ctrl+Z.
7. **Inbox.**
   - Opening a notification marks it read. In the Unread filter a read item stays visible until the next refetch, so the list does not jump.
   - `invite_accepted` and notifications without a task open the org's members settings.
   - U toggles read and Shift+U marks everything read; the selection keys are shared with the list.
8. **No header bell.** The sidebar Inbox item (unread count, and a dot on the rail) and the phone's Inbox tab cover 02 §2 and §13.1.
9. **Live count.** The SSE `notification` event writes the unread count into the cache without a refetch, then invalidates `['notifications']`. The badge and the inbox read the same count.
10. **Bundle.** The feed and the comment renderer are a lazy chunk warmed at idle (`InteractionPrefetch`). The notification settings use a local list of types, checked against `NOTIFICATION_TYPES` by a test, so the route does not pull in zod.
