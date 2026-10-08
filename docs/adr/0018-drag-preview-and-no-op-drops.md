# ADR 0018: Drag preview position and no-op drops

- Status: accepted
- Date: 2026-10-09
- Refines: 02 §5; ADRs 0006 (§9, one grid-wide draggable), 0011 (phone long-press drag)
- Code: `apps/web/src/features/list/use-list-dnd.tsx`, `model/moves.ts` (`isNoopIntent`), `model/slots.ts` (`isNoopSlot`), `controller.ts`

## Context
The drag preview appeared far above the drop position: 124 px when unscrolled and 884 px with the list scrolled by 600 px, measured at 1440×900. The list uses one draggable for the whole tree grid (ADR 0006 §9), so dnd-kit's `DragOverlay` sized and placed itself from the grid's rect, not from the grabbed row's. dnd-kit's scroll-adjusted `delta` also put the computed pointer off by the distance auto-scroll had moved, and auto-scroll kept running after the pointer left the edge zone.

Dropping a task or group directly before or after itself was offered as a target. It sent a real `task.move`/`group.move` and pushed an undo entry.

## Decisions
1. **Preview layer.** The list does not use `DragOverlay`. `ListDnd` portals its own `fixed` layer to `<body>` (`z-(--z-drag)`, `pointer-events-none`) and moves it with `translate3d(pointer − grab offset)` set directly on the element, so a move causes no React re-render. Width and height come from the pressed row. The 2° pointer-only tilt (02 §5) pivots on the grab point, so the grabbed spot stays under the cursor or finger.
2. **Pointer source.** The pointer is read from window `pointermove` and `touchmove` listeners for the drag session, not from dnd-kit's delta. A scroll listener recomputes the drop target under a still pointer.
3. **No-op targets.** Positions equivalent to the dragged item's current place are never drop targets. This covers a task, a contiguous selection, a subtask and a group, by pointer and by keyboard. Dropping there announces "Drop cancelled.", sends no op and records no undo entry. As a backstop, `moveTasks`, `moveGroup` and `reorderSubtask` in the controller refuse no-op intents.
