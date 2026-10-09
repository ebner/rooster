/** The payload P7's web push sends (06 §notifications); only these fields are read here. */
export interface PushData {
  title?: string;
  body?: string;
  /** Same-origin path to open, e.g. `/o/acme/t/<taskId>`. */
  url?: string;
  /** Org slug and task id, when no `url` is given. */
  org?: string;
  taskId?: string;
  /** Collapses repeated notifications about the same thing. */
  tag?: string;
  /** `notification`, `due_reminder` or `test` (ADR 0033); every kind is shown the same way. */
  kind?: string;
}

const slugOrId = /^[\w-]{1,100}$/;

/**
 * Where a notification click goes (04 §6.3): the given same-origin path, else the task
 * `/o/:org/t/:id`, else the app root. Never another origin.
 */
export function pushTargetPath(data: unknown, origin: string): string {
  if (!data || typeof data !== 'object') return '/';
  const { url, org, taskId } = data as PushData;
  if (typeof url === 'string') {
    try {
      const target = new URL(url, origin);
      if (target.origin === origin && target.pathname.startsWith('/')) {
        return `${target.pathname}${target.search}${target.hash}`;
      }
    } catch {
      // Not a URL: fall through to the task fields.
    }
  }
  if (typeof org === 'string' && typeof taskId === 'string') {
    if (slugOrId.test(org) && slugOrId.test(taskId)) return `/o/${org}/t/${taskId}`;
  }
  return '/';
}
