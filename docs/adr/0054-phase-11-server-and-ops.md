# ADR 0054: Phase 11 server, security and operations

- Status: accepted
- Date: 2026-10-10
- Implements: ADR 0052 §5–§7 (WPs 11.1, 11.4, 11.5)

## Decisions
1. **Never use `fileTypeFromFile`.**
   - Upload sniffing uses `fileTypeFromBlob(await openAsBlob(path))`.
   - `fileTypeFromFile` imports `strtok3` through a computed specifier, which the bundled `dist/main.js` cannot resolve. Every upload in the 1.4.0 image failed with a 500; tests run from source, so they didn't catch it.
   - The backup drill now uploads an image through the built image, so CI catches this class of bug.
2. **The storage quota** is checked twice: after streaming (a read), and again inside the `immediate()` transaction that inserts the attachment row. Of two concurrent uploads, only one can pass; the loser's blobs go to `blob_gc`. Migration `0012_p11_attachment_uploader` adds the covering index `attachment(uploader_id, size)`.
3. **Job runs for Admin → System** are kept in memory (`jobs/job-board.ts`), so they start empty after a restart. Errors are scrubbed with `logSafeError`: the first line only, at most 300 characters.
4. **API responses default to `Cache-Control: no-store`** (ASVS 8.2.1). It applies to every `/api/v1` response that sets no cache policy of its own.
5. **At boot, a database, WAL or SHM file with group or other permission bits is made 0600.** Restored snapshots and Litestream copies arrive as 0644.
6. **Memory:** the image sets `MALLOC_ARENA_MAX=2`. glibc malloc arenas kept idle RSS at 158.7 MB, above the 150 MB budget, while the V8 heap was about 37 MB. With the setting, the server idles at 144.4 MB with 5 users. The next lever is lazy-loading the MCP SDK, nodemailer and better-auth.
7. **The image is slimmer:** only the current platform's better-sqlite3 prebuild is kept, and the web build's source maps are dropped. The image went from 295 to 259 MB, and rooster's own layer from 67 to 41 MB.
8. **The backup and restore drill** (`scripts/backup-drill.sh <image>`) and **the migration test from the previous release** (`test/fixtures/release-<version>.sql`, refreshed at each release by `make-release-fixture.ts`) run in CI.
9. **Litestream** (`compose.litestream.yaml`, 0.5.17 pinned by digest) needs no rooster setting change. rooster keeps SQLite's automatic checkpoints, as Litestream recommends for light write loads.
10. **Known ASVS L2 gaps, accepted for 1.5.0** (`docs/security/asvs.md`):
    - no malware scanning of uploads (12.4.2);
    - no self-service account deletion (8.3.2);
    - no SBOM (14.2.5);
    - 30-day rolling sessions without step-up re-authentication (3.3.2, 3.7.1);
    - no written threat model (1.1.2, 1.8.1).

    These go to the backlog.
