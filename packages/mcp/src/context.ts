import { type RoosterClient, type Schemas, unwrap } from '@rooster/api-client';
import {
  isValidIsoDate,
  isValidTime,
  matchMembers,
  parseDatePhrase,
  todayIn,
} from '@rooster/core/dates';
import { compareKeys } from '@rooster/core/ordering';
import { ASSIGNEE_ME, ASSIGNEE_NONE } from './tools.ts';

export type Task = Schemas['Task'];
export type TaskDetail = Schemas['TaskDetail'];
export type Group = Schemas['Group'];
export type Org = Schemas['Org'];
export type Me = Schemas['Me'];
export type Tag = Schemas['Tag'];
export type Member = Schemas['Member'];
export type MyList = Schemas['MyList'];

/**
 * A business failure the agent can act on (bad argument, unknown group, ambiguous member):
 * returned as a tool result with `isError: true`, never as a protocol error. `data` is user
 * content that explains it (candidate titles), framed as untrusted data like any result.
 */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** The due unit of a task (05 §4.4): date, time, timezone and start date change together. */
export interface DueUnit {
  dueDate: string | null;
  dueTime: string | null;
  dueTz: string | null;
  startDate: string | null;
}

/** The words that clear a due date, in both UI languages. */
const CLEAR_WORDS = ['none', 'null', 'no date', 'clear', '-', 'ingen', 'inget'];

/** `42` or `#42`: a task number in the tool's org (07 §3). */
const BARE_SEQ_RE = /^#?(\d{1,7})$/;

/** The org a tool works in, its groups, tags and members, read once per tool call. */
export class CallContext {
  private meCache: Promise<Me> | undefined;
  private readonly lists = new Map<string, Promise<MyList>>();
  private readonly tagCache = new Map<string, Promise<Tag[]>>();
  private readonly memberCache = new Map<string, Promise<Member[]>>();

  constructor(
    readonly client: RoosterClient,
    private readonly defaultOrg: string | null,
    readonly now: () => number,
  ) {}

  me(): Promise<Me> {
    this.meCache ??= unwrap(this.client.GET('/api/v1/me'));
    return this.meCache;
  }

  /** The user's orgs in sidebar order (the order `list_orgs` shows). */
  async orgs(): Promise<Org[]> {
    const me = await this.me();
    return [...me.orgs].sort(
      (a, b) => compareKeys(a.position, b.position) || compareKeys(a.id, b.id),
    );
  }

  /**
   * The org named by `slug` (a slug, an id, or `personal`), else the default org: the
   * profile's (stdio) or the first one in the sidebar (remote; 07 §6).
   */
  async org(slug?: string | undefined): Promise<Org> {
    const orgs = await this.orgs();
    const wanted = slug?.trim() || this.defaultOrg || undefined;
    if (wanted === undefined) {
      const first = orgs[0];
      if (first === undefined) throw new ToolError('This connection cannot see any organisation.');
      return first;
    }
    const org =
      wanted === 'personal'
        ? orgs.find((o) => o.isPersonal)
        : orgs.find((o) => o.slug === wanted || o.id === wanted);
    if (org === undefined) {
      throw new ToolError(
        'No such organisation is visible to this connection. list_orgs shows the ones it can use.',
        { org: wanted },
      );
    }
    return org;
  }

  async orgById(id: string): Promise<Org | undefined> {
    return (await this.me()).orgs.find((o) => o.id === id);
  }

  myList(orgId: string): Promise<MyList> {
    let list = this.lists.get(orgId);
    if (list === undefined) {
      list = unwrap(
        this.client.GET('/api/v1/orgs/{orgId}/my-list', { params: { path: { orgId } } }),
      );
      this.lists.set(orgId, list);
    }
    return list;
  }

  /** The user's groups in an org, Inbox first, then in their order. */
  async groups(orgId: string): Promise<Group[]> {
    const { groups } = await this.myList(orgId);
    return [...groups].sort(
      (a, b) =>
        (a.kind === 'inbox' ? 0 : 1) - (b.kind === 'inbox' ? 0 : 1) ||
        compareKeys(a.position, b.position) ||
        compareKeys(a.id, b.id),
    );
  }

  tags(orgId: string): Promise<Tag[]> {
    let tags = this.tagCache.get(orgId);
    if (tags === undefined) {
      tags = unwrap(this.client.GET('/api/v1/orgs/{orgId}/tags', { params: { path: { orgId } } }));
      this.tagCache.set(orgId, tags);
    }
    return tags;
  }

  members(orgId: string): Promise<Member[]> {
    let members = this.memberCache.get(orgId);
    if (members === undefined) {
      members = unwrap(
        this.client.GET('/api/v1/orgs/{orgId}/members', { params: { path: { orgId } } }),
      );
      this.memberCache.set(orgId, members);
    }
    return members;
  }

  /** One of the user's groups by exact name, then case-insensitive, then a unique prefix. */
  async findGroup(orgId: string, name: string): Promise<Group> {
    const groups = await this.groups(orgId);
    const text = name.trim();
    const wanted = text.toLocaleLowerCase();
    const exact = groups.find((g) => g.name === text);
    if (exact !== undefined) return exact;
    const folded = groups.filter((g) => g.name.toLocaleLowerCase() === wanted);
    if (folded.length === 1 && folded[0] !== undefined) return folded[0];
    const prefixed = groups.filter((g) => g.name.toLocaleLowerCase().startsWith(wanted));
    if (prefixed.length === 1 && prefixed[0] !== undefined) return prefixed[0];
    if (prefixed.length > 1) {
      throw new ToolError('Several groups match that name; use the full name.', {
        query: text,
        groups: prefixed.map((g) => g.name),
      });
    }
    throw new ToolError('No group has that name. list_groups shows the groups.', {
      query: text,
    });
  }

  /**
   * A task by ref (07 §3): `42` in `org` (or the default org), `acme#42`, `personal#42`, or an
   * id prefix of 8+ hex digits. The server resolves every form.
   */
  async resolveTask(ref: string, org?: string | undefined): Promise<Task> {
    const text = ref.trim();
    const bare = BARE_SEQ_RE.exec(text);
    const query = bare
      ? { ref: bare[1] as string, org: (await this.org(org)).id }
      : { ref: text.replace(/^#/, '') };
    return unwrap(this.client.GET('/api/v1/tasks/resolve', { params: { query } }));
  }

  async taskDetail(id: string): Promise<TaskDetail> {
    return unwrap(this.client.GET('/api/v1/tasks/{id}', { params: { path: { id } } }));
  }

  /**
   * `assignee` → a member's id, or null for nobody. "Me" as `isAssigneeMe` defines it, then
   * an email, then a name (whole name first, then a unique partial match), as the CLI's
   * `--assign` does.
   */
  async resolveAssignee(orgId: string, input: string): Promise<string | null> {
    const me = await this.me();
    const query = input.trim();
    const folded = query.toLowerCase();
    if ((ASSIGNEE_NONE as readonly string[]).includes(folded)) return null;
    if ((ASSIGNEE_ME as readonly string[]).includes(folded) || query === me.id) return me.id;
    if (folded === me.email.toLowerCase()) return me.id;
    const members = await this.members(orgId);
    const byId = members.find((m) => m.userId === query);
    if (byId !== undefined) return byId.userId;
    if (query.includes('@')) {
      const byEmail = members.find((m) => m.email.toLowerCase() === folded);
      if (byEmail !== undefined) return byEmail.userId;
    }
    const matches = matchMembers(query, members, me.id);
    const exact = matches.filter((m) => m.exact);
    const pick = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
    if (pick !== undefined) return pick.userId;
    if (matches.length > 1) {
      throw new ToolError('Several members match that assignee; use their email.', {
        query,
        members: matches.map((m) => members.find((x) => x.userId === m.userId)?.name ?? m.userId),
      });
    }
    throw new ToolError('No member of this organisation matches that assignee.', { query });
  }

  /**
   * `due` → the new due unit: an ISO date, a phrase in English or Swedish ("fri",
   * "tomorrow 14:00", "nästa vecka"), read in the user's timezone and week start like the
   * CLI's `--due` (ADR 0004), or a clearing word ("none"). Floating dates stay strings.
   */
  async parseDue(input: string): Promise<DueUnit> {
    const text = input.trim();
    if (CLEAR_WORDS.includes(text.toLowerCase())) {
      return { dueDate: null, dueTime: null, dueTz: null, startDate: null };
    }
    const me = await this.me();
    if (isValidIsoDate(text)) return { dueDate: text, dueTime: null, dueTz: null, startDate: null };
    const parsed = parseDatePhrase(text, {
      today: todayIn(me.timezone, this.now()),
      locale: me.locale,
      weekStart: me.weekStart,
      dateFormat: me.dateFormat,
    });
    if (parsed === null || (parsed.time !== null && !isValidTime(parsed.time))) {
      throw new ToolError(
        'The due date was not understood. Use YYYY-MM-DD or a phrase like "tomorrow", "fri 14:00", "next week" or "in 3 days"; "none" clears it.',
        { due: text },
      );
    }
    return {
      dueDate: parsed.date,
      dueTime: parsed.time,
      dueTz: parsed.time === null ? null : me.timezone,
      startDate: null,
    };
  }

  /** The user's today, for the summaries of date views. */
  async today(): Promise<{ today: string; timezone: string }> {
    const me = await this.me();
    return { today: todayIn(me.timezone, this.now()), timezone: me.timezone };
  }
}
