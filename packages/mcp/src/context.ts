import { RoosterApiError, type RoosterClient, type Schemas, unwrap } from '@rooster/api-client';
import {
  dueInstant,
  findDateInTitle,
  isValidIsoDate,
  isValidTime,
  matchMembers,
  parseDatePhrase,
  todayIn,
} from '@rooster/core/dates';
import { compareKeys } from '@rooster/core/ordering';
import { parseReminderOffset, type ReminderSpec } from '@rooster/core/reminders';
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
  /**
   * P10: set when the phrase was a recurrence ("every mon"); absent means the task keeps its
   * rule (ADR 0049 §1.8).
   */
  recurrence?: string | null;
  recurrenceBasis?: 'due' | 'completion' | null;
}

/** The recurrence fields of a task create or PATCH (P10). */
export interface RepeatFields extends Partial<DueUnit> {
  recurrence: string | null;
  recurrenceBasis: 'due' | 'completion' | null;
}

const AMBIGUOUS_ASSIGNEE =
  'Several members match that assignee; use their full name or ask the user for their email address.';

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
   * a member's id; the server resolves an email or a whole name, since apps never see
   * colleagues' emails (11 §2.1); a part of a name is then matched against the members' names,
   * as the CLI's `--assign` does.
   */
  async resolveAssignee(orgId: string, input: string): Promise<string | null> {
    const me = await this.me();
    const query = input.trim();
    const folded = query.toLowerCase();
    if ((ASSIGNEE_NONE as readonly string[]).includes(folded)) return null;
    if ((ASSIGNEE_ME as readonly string[]).includes(folded) || query === me.id) return me.id;
    if (folded === me.email.toLowerCase()) return me.id;
    const members = (await this.members(orgId)).map(({ userId, name }) => ({ userId, name }));
    const byId = members.find((m) => m.userId === query);
    if (byId !== undefined) return byId.userId;
    if (query !== '') {
      try {
        const found = await unwrap(
          this.client.GET('/api/v1/orgs/{orgId}/members/resolve', {
            params: { path: { orgId }, query: { q: query } },
          }),
        );
        return found.userId;
      } catch (error) {
        if (!(error instanceof RoosterApiError)) throw error;
        if (error.code === 'ambiguous_member') {
          throw new ToolError(AMBIGUOUS_ASSIGNEE, {
            query,
            members: (error.problem?.members ?? []).map((m) => m.name),
          });
        }
        // 404: no email or whole name matches; try part of a name below.
        if (error.status !== 404) throw error;
      }
    }
    const matches = matchMembers(query, members, me.id);
    const exact = matches.filter((m) => m.exact);
    const pick = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
    if (pick !== undefined) return pick.userId;
    if (matches.length > 1) {
      throw new ToolError(AMBIGUOUS_ASSIGNEE, {
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
      ...(parsed.recurrence === undefined
        ? {}
        : { recurrence: parsed.recurrence.rule, recurrenceBasis: parsed.recurrence.basis }),
    };
  }

  /**
   * The phrase in the user's language settings, read on `today` (default: the user's today),
   * or null (no exceptions: tools explain).
   */
  private async phrase(text: string, today?: string) {
    const me = await this.me();
    return parseDatePhrase(text, {
      today: today ?? todayIn(me.timezone, this.now()),
      locale: me.locale,
      weekStart: me.weekStart,
      dateFormat: me.dateFormat,
    });
  }

  /** The due date the server will find in this title (`parse: true`), or null. */
  async titleDate(title: string): Promise<string | null> {
    const me = await this.me();
    return (
      findDateInTitle(title, {
        today: todayIn(me.timezone, this.now()),
        locale: me.locale,
        weekStart: me.weekStart,
        dateFormat: me.dateFormat,
      })?.date ?? null
    );
  }

  /**
   * `repeat` (P10, FR-REC-2): a recurrence phrase ("every mon", "every 3 days after done",
   * "varje månad") as a rule, or a clearing word to stop repeating.
   *
   * `anchor` is the due date the task will have anyway. It is kept, and the phrase is read as
   * if on that day, so implicit anchors come from it ("monthly" on a task due Nov 1 is
   * `BYMONTHDAY=1`, not today's day). Without one, the phrase's first occurrence from today
   * becomes the due date, since a rule needs one.
   */
  async parseRepeat(input: string, anchor: string | null): Promise<RepeatFields> {
    const text = input.trim();
    if (CLEAR_WORDS.includes(text.toLowerCase()))
      return { recurrence: null, recurrenceBasis: null };
    const hasDueDate = anchor !== null && isValidIsoDate(anchor);
    const parsed = await this.phrase(text, hasDueDate ? anchor : undefined);
    if (parsed?.recurrence === undefined || (parsed.time !== null && !isValidTime(parsed.time))) {
      throw new ToolError(
        'The repeat was not understood. Use a phrase like "every mon", "every weekday", "every month", "every 2 weeks" or "every 3 days after done"; "none" stops repeating.',
        { repeat: text },
      );
    }
    const rule = { recurrence: parsed.recurrence.rule, recurrenceBasis: parsed.recurrence.basis };
    if (hasDueDate) return rule;
    const me = await this.me();
    return {
      dueDate: parsed.date,
      dueTime: parsed.time,
      dueTz: parsed.time === null ? null : me.timezone,
      startDate: null,
      ...rule,
    };
  }

  /**
   * `remind` (P10, FR-REM): `15m`, `1h`, `1d` or `due` (optionally with the title token's `!`)
   * are minutes before the due moment; anything else is a date and time phrase ("fri 14:00",
   * "2026-11-02 08:30") in the user's timezone, an absolute reminder. A date without a time
   * means the user's all-day reminder time. Duplicates collapse.
   */
  async parseRemind(inputs: string | readonly string[]): Promise<ReminderSpec[]> {
    const me = await this.me();
    const out: ReminderSpec[] = [];
    const seen = new Set<string>();
    for (const input of typeof inputs === 'string' ? [inputs] : inputs) {
      const text = input.trim().replace(/^!/, '');
      let spec: ReminderSpec;
      const offset = parseReminderOffset(text);
      if (offset !== null) spec = { offsetMinutes: offset };
      else {
        const iso = isValidIsoDate(text) ? { date: text, time: null } : null;
        const parsed = iso ?? (text === '' ? null : await this.phrase(text));
        if (
          parsed === null ||
          ('recurrence' in parsed && parsed.recurrence !== undefined) ||
          (parsed.time !== null && !isValidTime(parsed.time))
        ) {
          throw new ToolError(
            'The reminder was not understood. Use 15m, 1h, 1d or due (before the due time), or a time like "fri 14:00" or "2026-11-02 08:30".',
            { remind: input },
          );
        }
        const fallback = me.prefs.allDayReminderTime;
        const time = parsed.time ?? (isValidTime(fallback) ? fallback : '09:00');
        spec = { at: dueInstant(parsed.date, time, me.timezone) };
      }
      const key = 'at' in spec ? `at:${spec.at}` : `off:${spec.offsetMinutes}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(spec);
    }
    return out;
  }

  /** The user's today, for the summaries of date views. */
  async today(): Promise<{ today: string; timezone: string }> {
    const me = await this.me();
    return { today: todayIn(me.timezone, this.now()), timezone: me.timezone };
  }
}
