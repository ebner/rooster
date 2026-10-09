# ADR 0023: A pre-update backup on every version change

- Status: accepted
- Date: 2026-10-09
- Amends: 08 §2 step 3 and §8 (upgrades); 05 (`instance_setting` keys)
- Code: `apps/server/src/db/boot.ts`, `apps/server/src/db/instance.ts`, `apps/server/test/db.test.ts`

## Context

## Decisions
1. **Trigger.** On an existing (non-empty) database, boot takes the snapshot when migrations are pending **or** when the running version differs from the one that last booted the database. That covers upgrades and downgrades. A fresh database gets none.
2. **Where the version lives.** In `instance_setting` under `last_boot_version`, written (upsert) after migrations and `ensureInstanceId` succeed, so a failed boot leaves it unchanged. A missing table or key on an existing database counts as "changed", so the first boot with this rule takes one backup.
3. **No API change.** The file keeps the `pre-migrate` prefix and `BackupKind`; the admin UI already labels it "Before update", and rotation keeps the newest 10.
4. The log line is `pre-update backup written` with `{ backup, from, to, migrations }`.
