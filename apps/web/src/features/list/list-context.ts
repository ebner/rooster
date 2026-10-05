import { createContext, useContext } from 'react';
import type { ViewerDateContext } from '../dates';
import type { ListController } from './controller';

export interface ListContextValue {
  controller: ListController;
  dateCtx: ViewerDateContext;
  /** 02 §8.1: title parsing (a Settings toggle from P9). */
  parseTitles: boolean;
  /** Sorted views disable dragging (none in P2). */
  dragEnabled: boolean;
}

export const ListContext = createContext<ListContextValue | null>(null);

export function useListContext(): ListContextValue {
  const value = useContext(ListContext);
  if (!value) throw new Error('useListContext outside <ListContext>');
  return value;
}
