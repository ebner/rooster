# ADR 0063: Switching orgs from the phone header with a swipe or press-and-slide

- Status: accepted
- Date: 2026-10-16
- Amends: 02 §13.1 (Frame: the org switcher)
- Code: `apps/web/src/features/shell/org-switcher.tsx`, `mobile-header.tsx`, `app-shell.tsx`, `sidebar-views.ts` (`switchView`), `routes/_app.tsx`

## Context
On phones, switching orgs took two taps: the header's org name opens a bottom sheet, then the org. Desktop has Mod+1…9. The request was for something closer to Google's apps, where swiping on the profile picture changes accounts, but sideways.

The options considered:
- a sideways swipe on the org name: fastest with two or three orgs, but invisible without a cue;
- press-and-slide (hold the name, the sheet opens under the finger, lift on an org): one movement for any number of orgs, as in iOS context menus;
- a "back to the last org" gesture (Alt+Tab style): fastest between two orgs, but a third hidden gesture;
- other orgs' avatars in the header: visible, but a phone header has no room beyond two or three.

## Decisions
1. **A sideways swipe on the org name** moves to the next org (swipe left) or the previous one (swipe right) in sidebar order. The name follows the finger, and the neighbour's avatar and name slide in behind it. It commits past 30 % of the larger of the name's width and half the screen, or with a fling, as row swipes do (02 §13.2).
2. **At the first and last org a swipe only stretches** (the rows' rubber band) and springs back; it does not wrap.
3. **Dots under the name** show how many orgs there are and which one is open, as the cue that the name swipes. They appear with two to seven orgs.
4. **Press-and-slide:** holding the name for the long-press time (350 ms, shared with row dragging) opens the org sheet. The org under the finger is highlighted, and lifting over it switches. Lifting anywhere else leaves the sheet open, as after a tap.
5. **A switch keeps the view** (`switchView`): Today stays Today, and Everyone's tasks falls back to My tasks in a personal org. This applies to every phone switch, the sheet included. Desktop's Mod+1…9 still opens My tasks.
6. **Touch only.** A mouse press and the keyboard open the sheet as before, and Mod+1…9 remains the keyboard path. The gestures add nothing for screen readers, so the button's name and sheet are unchanged.

## Consequences
- Switching between neighbouring orgs takes one swipe, and any org is one press-and-slide away.
- The switcher is `touch-action: none`, so a vertical drag that starts on it does nothing; the header does not scroll anyway.
