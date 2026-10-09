import { Plus } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import { LogoMark } from '../../ui/logo';
import { GridCell, GridRow } from './grid';
import { useListContext } from './list-context';
import type { EmptyRow } from './model/rows';

/** 02 §14: an empty smart view, with "+ Add task" where the view takes adds. */
export const ViewEmptyState = memo(function ViewEmptyState({ row }: { row: EmptyRow }) {
  const { t } = useTranslation('views');
  const { t: tList } = useTranslation('list');
  const { controller } = useListContext();
  return (
    <GridRow aria-level={1} data-row-id={row.id} data-testid="view-empty" className="flex shrink-0">
      <GridCell className="flex flex-1 flex-col items-center gap-3 py-12 text-center">
        {/* 03 §2.10: the brand mark in muted grey, only the comb in amber. */}
        <LogoMark size={96} tone="muted" />
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
