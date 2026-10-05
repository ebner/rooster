import type { HTMLAttributes, Ref } from 'react';

type DivProps = HTMLAttributes<HTMLDivElement> & {
  ref?: Ref<HTMLDivElement> | undefined;
  [data: `data-${string}`]: string | boolean | undefined;
};

/**
 * Tree-grid parts (02 §3.1: `role="treegrid"`, rows and cells). The list is a flat column
 * of flex rows, not a table, so these are divs with ARIA roles. Keyboard interaction is
 * the list keymap: rows are focus targets (tabIndex -1) reached with the arrow keys.
 */
export function GridRow({ ref, ...props }: DivProps & { 'aria-level': number }) {
  // biome-ignore lint/a11y/useSemanticElements: a flex tree-grid row, not a table row.
  return <div ref={ref} role="row" tabIndex={-1} {...props} />;
}

export function GridCell({ ref, ...props }: DivProps) {
  // biome-ignore lint/a11y/useSemanticElements: a flex tree-grid cell, not a table cell.
  // biome-ignore lint/a11y/useFocusableInteractive: cells hold the focusable controls.
  return <div ref={ref} role="gridcell" {...props} />;
}
