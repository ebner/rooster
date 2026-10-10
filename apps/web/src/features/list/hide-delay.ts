/**
 * FR-SET-2: how long a completed task stays in the list (`prefs.completeHideMs`, 02 §3.6).
 *
 * "Until reload" is stored as the schema's maximum, 10 000 ms, rather than a new value: the
 * prefs schema stays as it is (`int 0..10000`), and a client that predates the setting holds
 * the row for ten seconds instead of misreading it (0 already means "collapse at once", which
 * a swipe uses). The web treats 10 000 and above as "keep the row until the list is left or
 * reloaded".
 */
export const completeHideUntilReload = 10_000;

/** The choices Settings → Behaviour offers, in order. */
export const completeHideChoices = [1500, 3000, completeHideUntilReload] as const;

export type CompleteHideChoice = (typeof completeHideChoices)[number];

/** True when a completed row should stay until the list is left or reloaded. */
export function holdsUntilReload(holdMs: number): boolean {
  return holdMs >= completeHideUntilReload;
}
