import { grantsApi, RoosterApiError, type Task, unwrap } from './api.ts';
import { CliError, EXIT } from './errors.ts';
import { t } from './i18n.ts';
import { clean } from './output/color.ts';
import type { Runtime } from './runtime.ts';

/** A task reference as typed (07 §3). */
export type Ref =
  | { kind: 'seq'; seq: number; org: string | null }
  | { kind: 'prefix'; prefix: string }
  | { kind: 'last' };

const SEQ_RE = /^#?(\d{1,7})$/;
const ORG_SEQ_RE = /^([a-z0-9][a-z0-9-]{1,38})#(\d{1,12})$/;
/** What the server's resolver takes as an ID prefix: 8–32 hex digits, dashes anywhere. */
function isIdPrefix(text: string): boolean {
  if (!/^[0-9a-f-]+$/i.test(text)) return false;
  const hex = text.replace(/-/g, '');
  return hex.length >= 8 && hex.length <= 32;
}

/**
 * `42`, `personal#42`, a UUID prefix of 8+ hex characters, or `@last`. Up to seven bare
 * digits are a seq; eight or more read as an ID prefix, like the server (UUIDv7s often start
 * with digits).
 */
export function parseRef(input: string): Ref {
  const text = input.trim();
  if (text === '@last') return { kind: 'last' };
  const seq = SEQ_RE.exec(text);
  if (seq) return { kind: 'seq', seq: Number(seq[1]), org: null };
  const orgSeq = ORG_SEQ_RE.exec(text);
  if (orgSeq) return { kind: 'seq', seq: Number(orgSeq[2]), org: orgSeq[1] ?? null };
  if (isIdPrefix(text)) return { kind: 'prefix', prefix: text.toLowerCase() };
  throw new CliError(EXIT.usage, t('ref.invalid', { ref: input }));
}

/**
 * Replaces each `-` with the refs read from stdin, one per line (blank lines and `#`
 * comments skipped), so `rooster ls --json | jq -r '.[].seq' | rooster done -` works.
 */
export async function expandRefs(
  args: readonly string[],
  readStdin: () => Promise<string>,
): Promise<string[]> {
  if (!args.includes('-')) return [...args];
  const stdin = (await readStdin())
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('# '));
  return args.flatMap((arg) => (arg === '-' ? stdin : [arg]));
}

/** The query `GET /tasks/resolve` takes for a parsed ref. */
export function resolveQuery(ref: Exclude<Ref, { kind: 'last' }>, currentOrg: string) {
  if (ref.kind === 'prefix') return { ref: ref.prefix };
  if (ref.org !== null) return { ref: `${ref.org}#${ref.seq}` };
  return { ref: String(ref.seq), org: currentOrg };
}

interface Candidate {
  id: string;
  seq: number | null;
  title: string;
  orgId: string;
}

/** Resolves one ref through the server (one path for every form); remembers it as `@last`. */
export async function resolveRef(
  runtime: Runtime,
  input: string,
  options: { deleted?: boolean } = {},
): Promise<Task> {
  const ref = parseRef(input);
  const api = await runtime.api();
  let task: Task;
  try {
    if (ref.kind === 'last') {
      const last = runtime.state.last(runtime.profileName);
      if (last === undefined) throw new CliError(EXIT.notFound, t('ref.noLast'));
      task = await unwrap(api.GET('/api/v1/tasks/{id}', { params: { path: { id: last.id } } }));
    } else {
      const query = resolveQuery(ref, runtime.orgRef());
      task = await grantsApi.resolve(api, {
        ...query,
        ...(options.deleted ? { deleted: 'true' as const } : {}),
      });
    }
  } catch (error) {
    throw refError(error, input);
  }
  rememberLast(runtime, task);
  return task;
}

function refError(error: unknown, input: string): unknown {
  if (!(error instanceof RoosterApiError)) return error;
  if (error.status === 404 || error.status === 410) {
    return new CliError(EXIT.notFound, t('ref.notFound', { ref: input }), error.code);
  }
  if (error.code === 'ambiguous_ref') {
    const candidates = ((error.problem as { candidates?: Candidate[] } | undefined)?.candidates ??
      []) as Candidate[];
    const list = candidates
      .slice(0, 10)
      .map((c) => `  ${c.seq ?? c.id.slice(0, 8)}  ${c.id.slice(0, 13)}  ${clean(c.title)}`)
      .join('\n');
    return new CliError(
      EXIT.notFound,
      `${t('ref.ambiguous', { ref: input, count: candidates.length })}${list ? `\n${list}` : ''}`,
      error.code,
    );
  }
  return error;
}

export function rememberLast(runtime: Runtime, task: Pick<Task, 'id' | 'orgId' | 'seq'>): void {
  runtime.state.setLast(runtime.profileName, { id: task.id, orgId: task.orgId, seq: task.seq });
}

/** Expands `-` and resolves every ref in order (exit 4 at the first unknown one). */
export async function resolveRefs(
  runtime: Runtime,
  inputs: readonly string[],
  options: { deleted?: boolean } = {},
): Promise<Task[]> {
  const refs = await expandRefs(inputs, () => runtime.io.readStdin());
  if (refs.length === 0) throw new CliError(EXIT.usage, t('ref.missing'));
  const tasks: Task[] = [];
  for (const ref of refs) tasks.push(await resolveRef(runtime, ref, options));
  return tasks;
}
