import type { QueryResult } from './types';

/** A settled, successful `QueryResult` for values computed on the client. */
export function ok<T>(data: T): QueryResult<T> {
  return { data, isPending: false, error: null };
}
