import { cn } from '../../lib/cn';
import { useListUi } from '../../state/list-store';

/**
 * 02 §5 / 03: the 2 px accent insertion line with an 8 px ring at its left end, drawn at the
 * top or bottom edge of the row it belongs to.
 */
export function DropLine({ rowId }: { rowId: string }) {
  const edge = useListUi((s) => (s.drop?.rowId === rowId ? s.drop.edge : null));
  if (edge !== 'before' && edge !== 'after') return null;
  return (
    <span
      aria-hidden
      data-testid="drop-indicator"
      className={cn(
        'pointer-events-none absolute inset-x-0 z-(--z-sticky) flex items-center',
        edge === 'before' ? 'top-0 -translate-y-1/2' : 'bottom-0 translate-y-1/2',
      )}
    >
      <span className="ms-6 size-2 shrink-0 rounded-full border-2 border-drop-indicator bg-bg-app" />
      <span className="h-0.5 flex-1 bg-drop-indicator" />
    </span>
  );
}
