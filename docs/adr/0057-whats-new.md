# ADR 0057: What's new

- Status: accepted
- Date: 2026-10-12
- Builds on: ADR 0053 (the in-app guide), ADR 0021 (the update flow)

## Context
`CHANGELOG.md` is written for whoever runs rooster: upgrade notes, migrations, environment variables, ADR numbers, in English only. Users had no way to learn what an update changed, although they start every update themselves from the "Update" chip or toast.

## Decisions
1. **The notes are a guide page.**
   - `docs/guide/{en,sv}/whats-new.md` ("What's new" / "Nyheter", last in `pages.json`) has one `## X.Y.Z` section per release, newest first, with its date in italics. Each change is one line, written for users, in both languages.
   - The guide build renders it like every other page (offline, both languages, GitHub-style anchors). A section's anchor is the version without its dots (`#153`); `versionAnchor` in `features/help/guide-model.ts` computes the same id, and a unit test checks both against the real pages, and that English and Swedish list the same releases in order.
   - Changes for the next release go under `## Unreleased`, in both files. Only builds from between releases show that heading.
2. **After an update, a toast offers it once.** `useWhatsNewNotice` (in `features/help/whats-new.ts`, mounted in the signed-in layout) compares the bundle's version with the last one this account saw on this browser (`userStorageKey(userId, 'whatsNew.seen')`):
   - newer: "rooster was updated to X.Y.Z" with a "What's new" action that opens the version's section. It is shown for 12 s, and only once the guide chunk has loaded and has a section for the version. Either way the version then counts as seen.
   - none seen: the version that saved this account's cache on this browser stands in (`SyncEngine.cacheAtStart`, the cache's buster). If an older version saved it, the account is from before this feature and gets the toast too, so the first release with notes reaches existing users.
   - none seen and no older cache (a first visit, a new browser, after a sign-out): the version is recorded silently. Nothing is new to someone who just arrived. A cache saved by the current version, as when a first load was cut short before the notice ran, is no update either; the 1.5.3 CI run caught the earlier check (only "this browser held the account's cache") showing the toast to brand-new users that way.
   - older (a downgrade): recorded silently.

   It is a toast, not a dialog (02 §1: no modals for everyday things), and it never blocks anything.
3. **Permanent entry points:** the guide's page list, and "What's new" in Settings: below "Open the guide" in the side menu, and as a row of the phone's settings index.
4. **The release enforces it.** `scripts/release.sh` refuses a release unless both pages have entries under `## Unreleased`. The bump turns that heading into `## X.Y.Z` with the date. A release with nothing visible to users says so in one line; the toast then still offers the page, which is acceptable for a rare release.

## Consequences
- Every release costs a few lines in two languages. They are short and derived from the CHANGELOG entries, without the operator details.
- Entries before 1.5.0 are not carried over: the guide already covers those features.
