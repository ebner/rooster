import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema/index.ts';

export type Orm = BetterSQLite3Database<typeof schema>;

export interface AppDb {
  /** Raw connection, for pragmas, `VACUUM INTO` and FTS. */
  sqlite: Database.Database;
  orm: Orm;
  close(): void;
}

// docs/spec/05-data-model.md §1: applied on every connection at open.
const PRAGMAS = [
  'journal_mode = WAL',
  'synchronous = NORMAL',
  'foreign_keys = ON',
  'busy_timeout = 5000',
  'temp_store = MEMORY',
  'cache_size = -20000',
] as const;

/** Opens (creating if needed) the database at `path`; `':memory:'` gives a private in-memory DB. */
export function openDb(path: string): AppDb {
  const sqlite = new Database(path);
  for (const pragma of PRAGMAS) sqlite.pragma(pragma);
  const orm = drizzle({ client: sqlite, schema });
  return {
    sqlite,
    orm,
    close: () => {
      if (sqlite.open) sqlite.close();
    },
  };
}
