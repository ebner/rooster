# ADR 0021: Update prompt hardening

- Status: accepted
- Date: 2026-10-09
- Amends: ADR 0010 (FR-PWA-6 update flow)
- Code: `apps/web/src/features/pwa/update-controller.ts`, `update-chip.tsx`, `sw-registration.ts`, `pwa-root.tsx`, `sync-status.tsx`; `apps/web/src/data/sync/engine.ts` (update-check wiring)

## Context
The update prompt was a toast only. Once it was dismissed, an open tab could stay on an old version indefinitely. Without a working service worker, a newer server version reported in the SSE `hello` changed nothing. With a service worker, a takeover started by another tab reloaded every tab silently, even one with a focused editor.

## Decisions
1. **Waiting update.** An update waits until the user reloads. The toast stays up to 24 h, and an "Update" chip in `SyncStatus` (every header, desktop and phone) persists until the reload. While a reload waits for the outbox or the editor, the chip reads "Reloading when saved…". Back in the foreground, a dismissed toast shows again at most once per 5 minutes.
2. **Newer `hello` without a new worker.** When no service worker works, or the active worker already is the server's latest, a newer `hello` prompts directly, and Reload is a gated `location.reload()`.
3. **Takeover by another tab.** A worker takeover started elsewhere no longer reloads silently. `onNeedReload` routes it through the update gate (empty outbox, no focused editor).
4. **Update checks.** `visibilitychange` (visible) and `online` run the SW update check, throttled to once per 5 minutes; the hourly check stays. A newer `hello` that arrives before the PWA module is ready is remembered and checked once it is.
