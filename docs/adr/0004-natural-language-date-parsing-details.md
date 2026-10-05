# ADR 0004: Natural-language date parsing details

- Status: accepted
- Date: 2026-10-05
- Refines: 02 §8 (implemented in `packages/core/src/dates/parse.ts`)

## Decisions
1. **Weekdays:**
   - `next mon`, `nästa måndag` and `på fredag` mean the same as plain `mon`: the next occurrence **after** today.
   - Only `this <weekday>` can resolve to today.
2. **Weekend:**
   - `weekend` / `helgen` means Saturday, or today if today is Saturday or Sunday.
   - `next weekend` / `nästa helg` means the Saturday after that.
   - On a Sunday, `next weekend` is the coming Saturday.
3. **End of week** is the last day of the week given the user's week start. **"In N months"** is clamped to the month's last day (Jan 31 + 1 month = Feb 28/29).
4. **Short forms `tod`, `tom`, `tmr`** only match at the end of a title.
   - "Email Tom about invoice" gets no date.
   - "Call Tom" *is* read as tomorrow. The user cancels it by clicking the highlight; the risk is accepted because a highlight is always shown before commit.
5. **Possessives do not match:** "Meeting about tomorrow's plan" gets no date.
6. **Recurrence guard (until P10):**
   - No date is produced when the phrase is preceded by `every` / `each` / `daily` / `varje` / `varannan` / `var` / `dagligen`. Filler words such as "and", "last", numbers or weekdays may sit in between.
   - The same applies when the phrase is directly followed by one of those words.
   - So "Water plants every mon" never becomes a one-off Monday.
7. **Prepositions** "on", "på" and "den" directly before a date phrase are part of the match. They are highlighted and removed with it.
8. **Times:**
   - A time needs `at` / `@` / `kl` / `klockan`, unless it has minutes or am/pm. `tomorrow 3pm` works; `tomorrow 14` does not.
   - `kl` and `klockan` are active in titles only when the UI language is Swedish.
   - In the picker, a lone time means today at that time.
9. **`>Group` token:** only whitespace or a date phrase may follow it, so `>Errands #shop` is not a group token. Users put `>Group` last.
