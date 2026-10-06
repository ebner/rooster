import { Plus } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import { GridCell, GridRow } from './grid';
import { useListContext } from './list-context';
import type { EmptyRow } from './model/rows';

/**
 * The empty-state illustration (03 §2.10): n-300 line art of a rooster with one coral detail
 * (the comb), at most 160 px.
 */
export function RoosterIllustration({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 160 120"
      aria-hidden
      className={className}
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g className="stroke-border-strong">
        {/* Body, tail feathers and wing */}
        <path d="M58 52c-10 8-14 22-10 34 5 14 20 20 36 18 18-2 30-14 32-30" />
        <path d="M116 74c6-10 6-24 0-36M116 74c10-6 16-18 16-30M116 74c12 0 20-8 24-18" />
        <path d="M66 74c8 8 22 10 34 4" />
        {/* Neck and head */}
        <path d="M58 52c-2-12 2-24 12-28 9-4 18 2 18 12 0 8-6 12-6 20" />
        {/* Beak and wattle */}
        <path d="M60 32l-9 4 9 3" />
        <path d="M62 40c-2 5 0 9 4 9" />
        {/* Legs */}
        <path d="M76 104v10M92 104v10M70 114h12M86 114h12" />
        {/* Ground */}
        <path d="M30 116h100" />
      </g>
      {/* Eye */}
      <circle cx="68" cy="30" r="1.5" className="fill-border-strong" />
      {/* The coral comb */}
      <path d="M62 24c-2-6 2-10 6-8 0-6 6-8 9-4 3-4 9-2 8 4" className="stroke-brand" />
    </svg>
  );
}

/** 02 §14: an empty smart view, with "+ Add task" where the view takes adds. */
export const ViewEmptyState = memo(function ViewEmptyState({ row }: { row: EmptyRow }) {
  const { t } = useTranslation('views');
  const { t: tList } = useTranslation('list');
  const { controller } = useListContext();
  return (
    <GridRow aria-level={1} data-row-id={row.id} data-testid="view-empty" className="flex shrink-0">
      <GridCell className="flex flex-1 flex-col items-center gap-3 py-12 text-center">
        <RoosterIllustration className="w-illustration max-w-full" />
        <p className="text-base text-text-secondary">{t(`empty.${row.view}`)}</p>
        {row.canAdd && (
          <Button variant="ghost" size="sm" icon={Plus} onPress={() => controller.quickAdd()}>
            {tList('row.addTask')}
          </Button>
        )}
      </GridCell>
    </GridRow>
  );
});
