# ADR 0001: Date formatting and due-state details not covered by the spec

- Status: accepted
- Date: 2026-10-04
- Context: WP 0.6 (`packages/core/dates`). Spec references: 02 §8.3, 03 §2.3.

## Decisions

1. **Timed overdue.** A task with a due time is `overdue` as soon as that instant (`dueDate` + `dueTime` in `dueTz`) has passed. This holds even when the viewer's local date is still the day before. Exactly at the due minute, the task is not yet overdue.
2. **Deterministic names.** Month and weekday names for EN and SV are hard-coded tables, not taken from `Intl`. Output is identical across Node, browsers and ICU versions. Swedish months are `jan…dec` (with "maj"), written without a trailing period.
3. **Swedish 12-hour time** renders as "2 em" / "8:15 fm". 24-hour time is the Swedish default.
4. **Ranges:**
   - EN with `d MMM`: "10 – 12 Oct"
   - SV across months: "30 okt – 2 nov"
   - Another year: "Mar 10 – 12, 2027"
   - Across years: both ends carry the year.
   - A range always shows dates, never "Today" or "Tomorrow".
5. **Timezone conversion is the caller's job.** `formatRelative` formats the time it is given. Converting a timed due into the viewer's timezone happens before the call (see `dueInstant`).
6. **Problem schema:** `detail` and `instance` are optional. `errors[].path` is a dotted string.
7. **Meta:** `gitSha` is always a string. Dev builds send `"dev"`.

## Consequences
UI, CLI, TUI and email output stay byte-identical for the same inputs. Snapshot tests are stable across environments.
