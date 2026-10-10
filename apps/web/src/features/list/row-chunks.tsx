import { memo, type ReactElement } from 'react';
import type { Row, TaskRow } from './model/rows';

/**
 * Long lists (AC-11.4, 2,000 open tasks) render their task rows in chunks: a chunk is a run of
 * consecutive task rows in one wrapper. A keypress then reconciles a few dozen chunks, not every
 * row, and the browser skips whole chunks off screen (`content-visibility` on the wrapper, see
 * theme.css), so style, layout and its visibility checks touch a few dozen boxes, not 2,000.
 *
 * Chunks are keyed, and a row stays in its chunk from render to render: moving a row to another
 * chunk would remount it, losing focus and an unsaved title. So the assignment is sticky. A
 * row keeps its chunk while the chunk stays contiguous; a row that cannot (it moved away, or
 * is new) joins the chunk it lands in. The focused and edited rows ("pinned") always keep
 * theirs, and the rows around them adapt. Group headers, add rows and the like stay outside
 * chunks, so sticky headers keep the whole list as their containing block.
 */

/** Rows a new chunk takes on a first render; existing chunks absorb inserts up to the max. */
export const chunkTarget = 48;
export const chunkMax = 96;
/** How far ahead a displaced row looks for the rest of the open chunk (a moved neighbour). */
const lookahead = 3;

export interface RowChunk {
  key: string;
  rows: TaskRow[];
}

export type ListItem = Row | RowChunk;

export function isChunk(item: ListItem): item is RowChunk {
  return 'rows' in item;
}

export class ChunkAssigner {
  private keyOf = new Map<string, string>();
  private counter = 0;

  /** Splits `rows` into top-level rows and chunks of task rows; `pinned` rows keep their chunk. */
  assign(rows: readonly Row[], pinned: ReadonlySet<string>): ListItem[] {
    let result = this.walk(rows, pinned, new Set());
    // A pinned row whose chunk an earlier row already claimed (it moved down past it): walk
    // again with that chunk reserved for it.
    const reserved = new Set<string>();
    for (const id of pinned) {
      const before = this.keyOf.get(id);
      if (before !== undefined && result.keyOf.get(id) !== before) reserved.add(before);
    }
    if (reserved.size > 0) result = this.walk(rows, pinned, reserved);
    this.keyOf = result.keyOf;
    return result.items;
  }

  private walk(
    rows: readonly Row[],
    pinned: ReadonlySet<string>,
    reserved: ReadonlySet<string>,
  ): { items: ListItem[]; keyOf: Map<string, string> } {
    const items: ListItem[] = [];
    const keyOf = new Map<string, string>();
    const used = new Set<string>();
    const fresh = new Set<string>();
    let current: RowChunk | null = null;
    const start = (key: string, row: TaskRow) => {
      used.add(key);
      current = { key, rows: [row] };
      items.push(current);
      keyOf.set(row.id, key);
    };
    const comesBack = (key: string, index: number) => {
      for (let j = index + 1; j <= index + lookahead && j < rows.length; j++) {
        const next = rows[j] as Row;
        if (next.kind !== 'task') return false;
        if (this.keyOf.get(next.id) === key) return true;
      }
      return false;
    };
    rows.forEach((row, index) => {
      if (row.kind !== 'task') {
        current = null;
        items.push(row);
        return;
      }
      const open = current as RowChunk | null;
      const previous = this.keyOf.get(row.id);
      if (open && previous === open.key) {
        open.rows.push(row);
        keyOf.set(row.id, open.key);
        return;
      }
      const isPinned = pinned.has(row.id);
      const mayStart =
        previous !== undefined &&
        !used.has(previous) &&
        (isPinned || !reserved.has(previous)) &&
        (isPinned || !open || !comesBack(open.key, index));
      if (mayStart) {
        start(previous, row);
        return;
      }
      const room = open && (fresh.has(open.key) ? chunkTarget : chunkMax);
      if (open && room && open.rows.length < room) {
        open.rows.push(row);
        keyOf.set(row.id, open.key);
        return;
      }
      this.counter += 1;
      const key = `chunk-${this.counter}`;
      fresh.add(key);
      start(key, row);
    });
    return { items, keyOf };
  }
}

function sameRows(a: readonly TaskRow[], b: readonly TaskRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * One chunk's wrapper. `role="none"`: the rows stay the tree grid's rows for assistive
 * technology. Its intrinsic size is the rows' fixed heights, so a skipped chunk keeps its place.
 */
export const RowChunkView = memo(
  function RowChunkView({
    rows,
    element,
  }: {
    rows: readonly TaskRow[];
    element: (row: Row) => ReactElement;
  }) {
    let subtasks = 0;
    for (const row of rows) if (row.level > 2) subtasks += 1;
    return (
      <div
        role="none"
        data-row-chunk
        style={{
          containIntrinsicBlockSize: `auto calc(var(--h-row) * ${rows.length - subtasks} + var(--h-row-subtask) * ${subtasks})`,
        }}
      >
        {rows.map(element)}
      </div>
    );
  },
  (a, b) => a.element === b.element && sameRows(a.rows, b.rows),
);
