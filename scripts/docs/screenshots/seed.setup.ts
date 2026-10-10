import type { Browser, Page } from '@playwright/test';
import { signInAs } from '../../../apps/web/e2e/support/auth';
import { test } from '../../../apps/web/e2e/support/test';
import { formatMention } from '../../../packages/core/src/mentions';
import { addDays, api, type DemoState, nextWeekday, saveState, todayIso, upload } from './demo-api';
import { DEMO } from './demo-env';
import {
  type AvatarSpec,
  avatarPng,
  briefPdf,
  moodboardPng,
  typefacesPng,
  wireframePng,
} from './images';

/**
 * The demo team (ADR 0052 §3): Kestrel Lane, a fictional five-person design studio. Everything
 * goes through the public API as the person who would do it, so assignments, mentions, follows
 * and notifications come out exactly as in real use. Dates are relative to today.
 */

const PEOPLE = {
  maja: {
    local: 'maja.lind',
    name: 'Maja Lind',
    avatar: ['ML', ['#f59e0b', '#c2410c', '#fde68a'], 0],
  },
  amara: {
    local: 'amara.okafor',
    name: 'Amara Okafor',
    avatar: ['AO', ['#0d9488', '#155e75', '#99f6e4'], 1],
  },
  jonas: {
    local: 'jonas.aberg',
    name: 'Jonas Åberg',
    avatar: ['JÅ', ['#4f46e5', '#312e81', '#c7d2fe'], 2],
  },
  priya: {
    local: 'priya.raman',
    name: 'Priya Raman',
    avatar: ['PR', ['#db2777', '#831843', '#fbcfe8'], 3],
  },
  kenji: {
    local: 'kenji.sato',
    name: 'Kenji Sato',
    avatar: ['KS', ['#65a30d', '#365314', '#d9f99d'], 4],
  },
} as const;
type Person = keyof typeof PEOPLE;

const TZ = DEMO.timezone;

interface TaskSpec {
  title: string;
  group?: string;
  due?: string;
  time?: string;
  start?: string;
  tags?: string[];
  assignee?: Person | null;
  parent?: string;
  description?: string;
  recurrence?: string;
  basis?: 'due' | 'completion';
  reminders?: ({ offsetMinutes: number } | { at: number })[];
}

test('seed the Kestrel Lane demo team', async ({ browser }) => {
  test.setTimeout(300_000);
  const today = todayIso();
  const d = (n: number) => addDays(today, n);

  // --- People: everyone signs in once (their personal org and default groups appear). ---------
  const pages = {} as Record<Person, Page>;
  const ids = {} as Record<Person, string>;
  for (const [n, key] of (Object.keys(PEOPLE) as Person[]).entries()) {
    const person = PEOPLE[key];
    const page = await signedIn(browser, `${person.local}@${DEMO.domain}`, n);
    const me = await api<{ id: string }>(page, 'PATCH', '/me', {
      name: person.name,
      locale: 'en',
      timezone: TZ,
      weekStart: 1,
      dateFormat: 'MMM d',
      timeFormat: '24h',
    });
    pages[key] = page;
    ids[key] = me.id;
    const [initials, colors, variant] = person.avatar;
    const spec: AvatarSpec = { initials, colors: [...colors], variant };
    await upload(page, 'PUT', '/me/avatar', {
      name: `${person.local}.png`,
      mimeType: 'image/png',
      buffer: await avatarPng(page, spec),
    });
  }
  const { maja } = pages;
  const as = (who: Person) => pages[who];

  // --- Orgs: the studio (everyone) and a garden club (Maja and Jonas). -----------------------
  const meMaja = await api<{ orgs: { id: string; isPersonal: boolean }[] }>(maja, 'GET', '/me');
  const personal = meMaja.orgs.find((o) => o.isPersonal)?.id ?? '';
  const studio = await api<{ id: string; slug: string }>(maja, 'POST', '/orgs', {
    name: 'Kestrel Lane',
    slug: 'kestrel-lane',
    avatarEmoji: '🪶',
    color: 'teal',
  });
  const garden = await api<{ id: string; slug: string }>(maja, 'POST', '/orgs', {
    name: 'Riverside Garden Club',
    slug: 'garden-club',
    avatarEmoji: '🌱',
    color: 'green',
  });
  const join = async (orgId: string, who: Person[]) => {
    const invite = await api<{ url: string }>(maja, 'POST', `/orgs/${orgId}/invites`, {
      role: 'member',
      multiUse: true,
    });
    const token = new URL(invite.url).pathname.split('/').pop();
    for (const person of who) await api(as(person), 'POST', `/invites/${token}/accept`);
  };
  await join(studio.id, ['amara', 'jonas', 'priya', 'kenji']);
  await join(garden.id, ['jonas']);
  await api(maja, 'PATCH', `/orgs/${studio.id}/members/${ids.amara}`, { role: 'owner' });
  // The studio first in Maja's sidebar; the club folded away.
  await api(maja, 'PUT', '/me/org-order', { orgId: studio.id, beforeId: personal });
  await api(maja, 'PATCH', `/me/orgs/${garden.id}`, { collapsed: true });

  // --- Groups and tags. -----------------------------------------------------------------------
  const groupsOf = async (who: Person, orgId: string) => {
    const list = await api<{ groups: { id: string; name: string }[] }>(
      as(who),
      'GET',
      `/orgs/${orgId}/my-list`,
    );
    return Object.fromEntries(list.groups.map((g) => [g.name, g.id])) as Record<string, string>;
  };
  const addGroup = async (who: Person, orgId: string, name: string, afterId: string) => {
    const res = await api<{ group: { id: string } }>(as(who), 'POST', `/orgs/${orgId}/groups`, {
      name,
      afterId,
    });
    return res.group.id;
  };
  const studioGroups = await groupsOf('maja', studio.id);
  studioGroups.Someday = await addGroup('maja', studio.id, 'Someday', studioGroups.Upcoming ?? '');
  await api(maja, 'PATCH', `/groups/${studioGroups.Upcoming}`, { name: 'This week' });
  studioGroups['This week'] = studioGroups.Upcoming ?? '';

  const tagColors: Record<string, string> = {
    design: 'purple',
    client: 'blue',
    finance: 'green',
    urgent: 'red',
    print: 'orange',
    web: 'teal',
    admin: 'gray',
    hiring: 'pink',
  };
  for (const [name, color] of Object.entries(tagColors)) {
    await api(maja, 'POST', `/orgs/${studio.id}/tags`, { name, color });
  }
  await api(maja, 'POST', `/orgs/${personal}/tags`, { name: 'home', color: 'amber' });
  await api(maja, 'POST', `/orgs/${personal}/tags`, { name: 'health', color: 'teal' });
  await api(maja, 'POST', `/orgs/${garden.id}/tags`, { name: 'greenhouse', color: 'green' });

  // --- Tasks. Created in list order: each after the previous one in its group. ---------------
  const tasks: Record<string, string> = {};
  const lastInGroup: Record<string, string> = {};
  const create = async (
    who: Person,
    orgId: string,
    groups: Record<string, string>,
    spec: TaskSpec,
  ) => {
    const groupId = spec.group ? groups[spec.group] : undefined;
    const body: Record<string, unknown> = { title: spec.title };
    if (groupId) {
      body.groupId = groupId;
      body.afterId = lastInGroup[`${who}:${groupId}`] ?? null;
    }
    if (spec.due) body.dueDate = spec.due;
    if (spec.time) Object.assign(body, { dueTime: spec.time, dueTz: TZ });
    if (spec.start) body.startDate = spec.start;
    if (spec.tags) body.tagNames = spec.tags;
    if (spec.assignee !== undefined) body.assigneeId = spec.assignee ? ids[spec.assignee] : null;
    if (spec.parent) body.parentId = tasks[spec.parent];
    if (spec.description) body.description = spec.description;
    if (spec.recurrence) {
      body.recurrence = spec.recurrence;
      if (spec.basis) body.recurrenceBasis = spec.basis;
    }
    if (spec.reminders) body.reminders = spec.reminders;
    const task = await api<{ id: string }>(as(who), 'POST', `/orgs/${orgId}/tasks`, body);
    if (groupId && !spec.parent) lastInGroup[`${who}:${groupId}`] = task.id;
    tasks[spec.title] = task.id;
    return task.id;
  };
  const studioTask = (spec: TaskSpec) => create('maja', studio.id, studioGroups, spec);

  const hero = 'Homepage hero concepts';
  // Today.
  await studioTask({
    title: 'Reply to Larkspur Books about the catalogue layout',
    group: 'Today',
    due: d(-1),
    tags: ['client'],
  });
  await studioTask({
    title: 'Send invoices for September',
    group: 'Today',
    due: d(0),
    time: '16:00',
    tags: ['finance'],
    reminders: [{ offsetMinutes: 60 }],
  });
  await studioTask({
    title: 'Approve business card print run',
    group: 'Today',
    due: d(0),
    tags: ['print'],
  });
  await studioTask({
    title: 'Water the studio plants',
    group: 'Today',
    due: d(0),
    recurrence: 'FREQ=WEEKLY',
  });
  await studioTask({
    title: 'Prepare the client workshop agenda',
    group: 'Today',
    due: d(1),
    time: '10:00',
    tags: ['client'],
  });
  await studioTask({
    title: 'Send the Larkspur proposal draft to Amara',
    group: 'Today',
    due: d(0),
  });
  // Prio.
  await studioTask({
    title: hero,
    group: 'Prio',
    due: d(4),
    start: d(2),
    tags: ['design', 'client'],
    reminders: [{ offsetMinutes: 1440 }],
    description: [
      'Three directions for the Juniper & Finch homepage, **warmer and more tactile** than today.',
      '',
      '- **A · Steam:** a pouring kettle, quiet serif',
      '- **B · Clay:** tins on a textured backdrop',
      '- **C · Leaf:** illustrated tea leaves',
    ].join('\n'),
  });
  await studioTask({
    title: 'Draft proposal for Larkspur Books',
    group: 'Prio',
    due: d(5),
    tags: ['client'],
  });
  await studioTask({
    title: 'Quarterly VAT return',
    group: 'Prio',
    due: d(8),
    tags: ['finance'],
    recurrence: 'FREQ=MONTHLY;INTERVAL=3',
  });
  await studioTask({
    title: 'Portfolio case study: Moss Pebble Bakery',
    group: 'Prio',
    tags: ['web'],
  });
  // This week.
  await studioTask({
    title: 'Book train to the Gothenburg design fair',
    group: 'This week',
    due: d(2),
  });
  await studioTask({
    title: 'Interview junior designer candidates',
    group: 'This week',
    due: d(6),
    tags: ['hiring'],
  });
  await studioTask({
    title: 'Weekly studio sync',
    group: 'This week',
    due: nextWeekday(today, [5], 1),
    time: '09:30',
    recurrence: 'FREQ=WEEKLY;BYDAY=FR',
  });
  await studioTask({
    title: 'Plan the studio offsite',
    group: 'This week',
    due: d(13),
    start: d(11),
  });
  await studioTask({
    title: 'Renew font licences',
    group: 'This week',
    due: d(20),
    tags: ['admin'],
  });
  // Someday.
  await studioTask({
    title: 'Try risograph printing for the zine',
    group: 'Someday',
    tags: ['print'],
  });
  await studioTask({ title: 'Reorganise the shared font library', group: 'Someday' });
  await studioTask({
    title: 'Blog post about the Larkspur project',
    group: 'Someday',
    tags: ['web'],
  });

  // Subtasks of the hero task, one done.
  for (const [title, assignee] of [
    ['Collect reference imagery', 'maja'],
    ['Sketch three directions', 'maja'],
    ['Pick typefaces with Priya', 'priya'],
    ['Present to Amara', 'maja'],
  ] as const) {
    await create('maja', studio.id, studioGroups, { title, parent: hero, assignee });
  }
  await api(maja, 'POST', `/tasks/${tasks['Collect reference imagery']}/complete`, {
    completed: true,
  });

  // The rest of the team: their own work (Everyone's tasks) and work for Maja (her Inbox).
  const team = async (who: Person, spec: TaskSpec) => {
    const groups = await groupsOf(who, studio.id);
    return create(who, studio.id, groups, { group: 'Today', ...spec });
  };
  await team('amara', {
    title: 'Finalise Juniper & Finch packaging dielines',
    due: d(1),
    tags: ['print', 'client'],
  });
  await team('amara', {
    title: 'Client call with Moss Pebble Bakery',
    due: d(0),
    time: '14:00',
    tags: ['client'],
  });
  await team('amara', { title: 'Colour-proof the tea tin labels', due: d(4), tags: ['print'] });
  await team('jonas', {
    title: 'Set up staging site for Larkspur Books',
    due: d(-2),
    tags: ['web'],
  });
  await team('jonas', {
    title: 'Fix the contact form on the studio site',
    due: d(2),
    tags: ['web', 'urgent'],
  });
  await team('jonas', { title: 'Move analytics to the new account' });
  await team('priya', {
    title: 'Typeface shortlist for Juniper & Finch',
    due: d(1),
    tags: ['design'],
  });
  await team('priya', { title: 'Illustration style frames', due: d(5), tags: ['design'] });
  await team('kenji', { title: 'Order new Pantone swatch books', due: d(3), tags: ['admin'] });
  await team('kenji', { title: 'Photograph product samples', due: d(6) });
  await team('kenji', {
    title: 'Jersey mockups for Tidewater Cycling Club',
    due: d(9),
    tags: ['design', 'client'],
  });
  await team('amara', { title: 'Update the studio holiday calendar', assignee: null });
  await team('kenji', { title: 'Recycle old proof prints', assignee: null, tags: ['admin'] });
  await team('amara', {
    title: 'Review moodboard for the tea tin refresh',
    due: d(1),
    tags: ['design'],
    assignee: 'maja',
  });
  await team('jonas', {
    title: 'Sign off on the Larkspur print proofs',
    due: d(0),
    tags: ['print'],
    assignee: 'maja',
  });
  // Maja hands work out; Jonas finishes one of them (a "completed" notification for her).
  await studioTask({
    title: 'Export final logo files for Moss Pebble Bakery',
    group: 'Today',
    assignee: 'jonas',
    due: d(0),
  });
  await api(
    as('jonas'),
    'POST',
    `/tasks/${tasks['Export final logo files for Moss Pebble Bakery']}/complete`,
    { completed: true },
  );
  // Amara moves a date on Maja's task (a "due date changed" notification).
  await api(as('amara'), 'PATCH', `/tasks/${tasks['Review moodboard for the tea tin refresh']}`, {
    dueDate: d(2),
  });

  // --- Attachments, comments and followers on the hero task. ---------------------------------
  const heroId = tasks[hero] ?? '';
  await upload(maja, 'POST', `/tasks/${heroId}/attachments`, {
    name: 'hero-wireframe.png',
    mimeType: 'image/png',
    buffer: await wireframePng(maja),
  });
  await upload(as('priya'), 'POST', `/tasks/${heroId}/attachments`, {
    name: 'moodboard-direction-b.png',
    mimeType: 'image/png',
    buffer: await moodboardPng(as('priya')),
  });
  await upload(as('priya'), 'POST', `/tasks/${heroId}/attachments`, {
    name: 'typeface-pairings.png',
    mimeType: 'image/png',
    buffer: await typefacesPng(as('priya')),
  });
  await upload(maja, 'POST', `/tasks/${heroId}/attachments`, {
    name: 'juniper-finch-brief.pdf',
    mimeType: 'application/pdf',
    buffer: briefPdf(),
  });
  const mention = (who: Person) => formatMention(PEOPLE[who].name, ids[who]);
  await api(as('amara'), 'POST', `/tasks/${heroId}/comments`, {
    body: `Love where this is going! Can we try a warmer palette for direction B? ${mention('priya')} do you still have the earthy swatches from last week?`,
  });
  await api(as('priya'), 'POST', `/tasks/${heroId}/comments`, {
    body: 'Yes, the moodboard is attached. Clay and Juniper work really well with the serif pairing.',
  });
  await api(maja, 'POST', `/tasks/${heroId}/comments`, {
    body: `Great, I'll put **A and B** in front of the client on Thursday. ${mention('kenji')} could you shoot the tins on the clay backdrop?`,
  });
  await api(as('kenji'), 'PUT', `/tasks/${heroId}/followers/me`);
  await api(
    as('amara'),
    'POST',
    `/tasks/${tasks['Finalise Juniper & Finch packaging dielines']}/comments`,
    {
      body: `${mention('maja')} could you check the bleed on the lid before I send it to the printer?`,
    },
  );

  // Done today, so "Show completed" has something to show.
  for (const title of [
    'Approve business card print run',
    'Send the Larkspur proposal draft to Amara',
  ]) {
    await api(maja, 'POST', `/tasks/${tasks[title]}/complete`, { completed: true });
  }

  // --- Personal org and the garden club. ---------------------------------------------------
  const personalGroups = await groupsOf('maja', personal);
  const own = (spec: TaskSpec) => create('maja', personal, personalGroups, spec);
  await own({ title: 'Pick up the dry cleaning', group: 'Today', due: d(0) });
  await own({
    title: 'Call the dentist to reschedule',
    group: 'Today',
    due: d(1),
    tags: ['health'],
  });
  await own({
    title: 'Yoga class',
    group: 'Today',
    due: nextWeekday(today, [2, 4], 1),
    time: '18:00',
    recurrence: 'FREQ=WEEKLY;BYDAY=TU,TH',
    tags: ['health'],
  });
  await own({
    title: 'Sort out the home insurance renewal',
    group: 'Prio',
    due: d(-3),
    tags: ['home'],
  });
  await own({ title: 'Renew passport', group: 'Prio', due: d(14) });
  await own({
    title: 'Change the water filter',
    group: 'Upcoming',
    due: d(9),
    recurrence: 'FREQ=MONTHLY;INTERVAL=2',
    basis: 'completion',
    tags: ['home'],
  });
  await own({ title: "Plan Elsa's birthday dinner", group: 'Upcoming', due: d(12) });
  const gardenGroups = await groupsOf('maja', garden.id);
  await create('maja', garden.id, gardenGroups, {
    title: 'Order seed potatoes',
    group: 'Today',
    due: d(3),
  });
  await create('maja', garden.id, gardenGroups, {
    title: 'Water the greenhouse',
    group: 'Today',
    due: d(0),
    recurrence: 'FREQ=DAILY;INTERVAL=2',
    basis: 'completion',
    tags: ['greenhouse'],
  });

  // --- Maja's account: a calendar feed, a token, an inbox with some already read. ------------
  await api(maja, 'POST', '/me/ical-feeds', { orgId: null });
  await api(maja, 'POST', '/me/tokens', {
    name: 'Weekly report script',
    scopes: ['tasks:read'],
    constraints: { orgs: [{ orgId: studio.id, read: 'all', write: 'none' }] },
    expiresInDays: 90,
  });
  const inbox = await api<{ items: { id: string; type: string }[] }>(maja, 'GET', '/notifications');
  const read = inbox.items.filter((n) => n.type === 'invite_accepted').map((n) => n.id);
  if (read.length > 0) await api(maja, 'POST', '/notifications/read', { ids: read });

  const state: DemoState = {
    people: Object.fromEntries(
      (Object.keys(PEOPLE) as Person[]).map((key) => [
        key,
        { id: ids[key], email: `${PEOPLE[key].local}@${DEMO.domain}`, name: PEOPLE[key].name },
      ]),
    ),
    orgs: { personal, studio: studio.id, studioSlug: studio.slug, garden: garden.id },
    tasks,
  };
  saveState(state);
  await Promise.all(Object.values(pages).map((p) => p.context().close()));
});

async function signedIn(browser: Browser, email: string, n: number): Promise<Page> {
  const context = await browser.newContext({
    locale: 'en-GB',
    timezoneId: TZ,
    viewport: { width: 1280, height: 800 },
    // A fixed documentation address per person (RFC 5737), shown in Settings → Security.
    extraHTTPHeaders: { 'X-Forwarded-For': `198.51.100.${10 + n}` },
  });
  await context.addInitScript(() => localStorage.setItem('rooster.locale', 'en'));
  const page = await context.newPage();
  const local = email.split('@')[0] ?? '';
  const derived = local
    .split('.')
    .map((p) => (p[0]?.toUpperCase() ?? '') + p.slice(1))
    .join(' ');
  await signInAs(page, email, derived);
  return page;
}
