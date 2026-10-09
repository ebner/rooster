import { palette } from '@rooster/tokens';
import { describe, expect, it } from 'vitest';
import type { Tag, Task } from '../src/api.ts';
import {
  clean,
  colorLevel,
  displayWidth,
  hexToRgb,
  paint,
  stripAnsi,
  toAnsi16,
  toAnsi256,
  truncate,
} from '../src/output/color.ts';
import {
  type DateContext,
  dueLabel,
  header,
  localDue,
  renderRows,
  toRow,
} from '../src/output/format.ts';
import { renderMarkdown } from '../src/output/markdown.ts';

const ctx: DateContext = {
  today: '2026-10-09',
  nowMs: Date.UTC(2026, 9, 9, 10, 0),
  timezone: 'Europe/Stockholm',
  locale: 'en',
  dateFormat: 'MMM d',
  timeFormat: '24h',
};

let seq = 40;
function task(fields: Partial<Task>): Task {
  seq += 1;
  return {
    id: `0192f3a0-0000-7000-8000-0000000000${seq}`,
    orgId: 'org',
    seq,
    parentId: null,
    subtaskPosition: null,
    title: 'Task',
    hasDescription: false,
    assigneeId: 'me',
    createdBy: 'me',
    dueDate: null,
    dueTime: null,
    dueTz: null,
    startDate: null,
    completedAt: null,
    tagIds: [],
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: { groupId: 'g', position: 'a0' },
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  } as Task;
}

const tags = new Map<string, Tag>([
  ['t1', { id: 't1', orgId: 'org', name: 'mail', color: 'blue', createdAt: 0 }],
]);

function listing() {
  seq = 40;
  return [
    task({ title: 'Reply to Anna about invoice', tagIds: ['t1'], dueDate: '2026-10-09' }),
    task({ title: 'Book dentist', dueDate: '2026-10-10' }),
    task({
      title: 'Review PR',
      counts: { subtasks: 3, subtasksDone: 1, comments: 0, attachments: 0 },
      dueDate: '2026-10-16',
    }),
    task({ title: 'Write Q4 plan', dueDate: '2026-10-12' }),
    task({ title: 'Renew passport' }),
    task({ title: 'Pay rent', dueDate: '2026-10-01' }),
    task({ title: 'Filed taxes', dueDate: '2026-10-05', completedAt: 1 }),
  ].map((t) => toRow(t, { tags, dates: ctx }));
}

describe('task lines (07 §4.1)', () => {
  it('aligns seq, mark, title, tags, progress and due label (no colour)', () => {
    expect(
      ['Personal · My tasks', header('Today', 3, 0), ...renderRows(listing(), 0, null)].join('\n'),
    ).toMatchInlineSnapshot(`
        "Personal · My tasks
        Today (3)
           41  ○ Reply to Anna about invoice  #mail  Today
           42  ○ Book dentist                        Tomorrow
           43  ○ Review PR                    ▸ 1/3  Oct 16
           44  ○ Write Q4 plan                       Mon
           45  ○ Renew passport
           46  ○ Pay rent                            ! Oct 1
           47  ✓ Filed taxes                         Oct 5"
      `);
  });

  it('colours from Coop tokens in truecolor', () => {
    const lines = renderRows(listing(), 3, null);
    const rgb = (hex: string) => hexToRgb(hex).join(';');
    expect(lines[0]).toContain(`38;2;${rgb(palette['green-700'])}mToday`);
    expect(lines[1]).toContain(`38;2;${rgb(palette['orange-700'])}mTomorrow`);
    expect(lines[3]).toContain(`38;2;${rgb(palette['violet-700'])}mMon`);
    expect(lines[5]).toContain(`1;38;2;${rgb(palette['rose-700'])}m! Oct 1`);
    expect(lines[6]).toContain('\u001b[9;');
    expect(lines[0]).toContain('48;2;'); // the tag chip background
    expect(stripAnsi(lines.join('\n'))).toBe(renderRows(listing(), 0, null).join('\n'));
  });

  it('cuts long titles to the terminal width on a TTY only', () => {
    const rows = [
      toRow(
        task({
          title: 'A very long title that will not fit in a narrow terminal',
          dueDate: '2026-10-09',
        }),
        { tags, dates: ctx },
      ),
    ];
    const [line] = renderRows(rows, 0, 40);
    expect(displayWidth(line ?? '')).toBeLessThanOrEqual(40);
    expect(line).toContain('…');
    expect(renderRows(rows, 0, null)[0]).toContain('narrow terminal');
  });

  it('shows org refs, breadcrumbs, depth and extra columns', () => {
    const rows = [
      toRow(task({ title: 'Child', seq: 48 }), {
        tags,
        dates: ctx,
        orgSlug: 'acme',
        breadcrumb: 'Parent',
        extra: '@Ann',
      }),
      toRow(task({ title: 'Nested', seq: 49 }), { tags, dates: ctx, depth: 1 }),
    ];
    expect(renderRows(rows, 0, null)).toEqual([
      ' acme#48  ○ Parent › Child  @Ann',
      '      49  ○   Nested',
    ]);
  });

  it('never prints control characters from task content', () => {
    const evil = toRow(task({ title: 'Pwned\u001b]0;title\u0007\u001b[2J‮hidden' }), {
      tags,
      dates: ctx,
    });
    const [line] = renderRows([evil], 3, null);
    expect(line).not.toContain('\u001b]');
    expect(line).not.toContain('\u001b[2J');
    expect(line).not.toContain('‮');
    expect(clean('a\tb\nc\u0000d\u009be')).toBe('a\tb\ncde');
  });
});

describe('due labels', () => {
  it('moves a timed due set in another zone into the viewer’s zone', () => {
    expect(
      localDue(
        { dueDate: '2026-10-09', dueTime: '23:30', dueTz: 'America/New_York' },
        'Europe/Stockholm',
      ),
    ).toEqual({
      date: '2026-10-10',
      time: '05:30',
    });
    expect(
      dueLabel(task({ dueDate: '2026-10-09', dueTime: '09:00', dueTz: 'Europe/Stockholm' }), ctx),
    ).toEqual({
      text: '! Today 09:00',
      state: 'overdue',
    });
  });

  it('formats ranges and Swedish', () => {
    expect(dueLabel(task({ dueDate: '2026-10-12', startDate: '2026-10-10' }), ctx)?.text).toBe(
      'Oct 10 – 12',
    );
    expect(dueLabel(task({ dueDate: '2026-10-10' }), { ...ctx, locale: 'sv' })?.text).toBe(
      'Imorgon',
    );
  });
});

describe('colour support', () => {
  it('honours NO_COLOR, --no-color, FORCE_COLOR and the terminal', () => {
    expect(colorLevel({}, false, false)).toBe(0);
    expect(colorLevel({ COLORTERM: 'truecolor' }, true, false)).toBe(3);
    expect(colorLevel({ COLORTERM: 'truecolor', NO_COLOR: '1' }, true, false)).toBe(0);
    expect(colorLevel({ COLORTERM: 'truecolor' }, true, true)).toBe(0);
    expect(colorLevel({ TERM: 'xterm-256color' }, true, false)).toBe(2);
    expect(colorLevel({ TERM: 'xterm' }, true, false)).toBe(1);
    expect(colorLevel({ TERM: 'dumb' }, true, false)).toBe(0);
    expect(colorLevel({ FORCE_COLOR: '3' }, false, false)).toBe(3);
    expect(colorLevel({ FORCE_COLOR: '0', COLORTERM: 'truecolor' }, true, false)).toBe(0);
  });

  it('maps tokens to the nearest 256 and basic colours by hue', () => {
    expect(toAnsi256([0, 0, 0])).toBe(16);
    expect(toAnsi256([255, 255, 255])).toBe(231);
    expect(toAnsi256([128, 128, 128])).toBe(244);
    expect(toAnsi16(hexToRgb(palette['rose-700']))).toBe(31);
    expect(toAnsi16(hexToRgb(palette['green-700']))).toBe(32);
    expect(toAnsi16(hexToRgb(palette['orange-700']))).toBe(31);
    expect(toAnsi16(hexToRgb(palette['violet-700']))).toBe(35);
    expect(toAnsi16(hexToRgb(palette['blue-700']))).toBe(34);
    expect(toAnsi16(hexToRgb(palette['n-600']))).toBe(90);
    expect(paint('x', { fg: palette['rose-700'], bg: palette['rose-50'] }, 1)).toBe(
      '\u001b[31mx\u001b[0m',
    );
    expect(paint('x', { fg: palette['rose-700'] }, 2).startsWith('\u001b[38;5;')).toBe(true);
  });

  it('measures wide characters', () => {
    expect(displayWidth('漢字')).toBe(4);
    expect(displayWidth('é')).toBe(1);
    expect(truncate('漢字漢字', 5)).toBe('漢字…');
  });
});

describe('Markdown descriptions', () => {
  it('renders the common subset for the terminal', () => {
    const md =
      '# Plan\n\nSome **bold**, *italic*, `code` and [a link](https://x.example).\n\n- [ ] todo\n- [x] done\n* item\n> quote\n\n```\nconst a = 1;\n```\n---';
    expect(renderMarkdown(md, 0).join('\n')).toMatchInlineSnapshot(`
      "Plan

      Some bold, italic, code and a link <https://x.example>.

      ☐ todo
      ☑ done
      • item
      │ quote

          const a = 1;
      ────────────────────────"
    `);
  });
});
