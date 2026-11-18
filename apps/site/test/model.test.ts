import { describe, expect, it } from 'vitest';
import { en } from '../src/copy/en.ts';
import { analyse, reminderText, repeatText } from '../src/demo/model.ts';

// Friday 13 November 2026, 10:00 in Stockholm.
const ctx = (locale: 'en' | 'sv') => ({
  today: '2026-11-13',
  nowMs: Date.parse('2026-11-13T09:00:00Z'),
  timeZone: 'Europe/Stockholm',
  locale,
});

describe('the parser demo', () => {
  it('highlights the date, tag and reminder and saves the rest as the title', () => {
    const r = analyse('Call the bank fri at 14 #finance !1h', ctx('en'), en.dates);
    expect(r.segments).toEqual([
      { kind: 'text', text: 'Call the bank ' },
      { kind: 'date', text: 'fri at 14' },
      { kind: 'text', text: ' ' },
      { kind: 'tag', text: '#finance' },
      { kind: 'text', text: ' ' },
      { kind: 'reminder', text: '!1h' },
    ]);
    expect(r.title).toBe('Call the bank');
    expect(r.due).toEqual({ label: 'Nov 20 14:00', state: 'later', repeats: null });
    expect(r.tags).toEqual(['finance']);
    expect(r.reminders).toEqual(['1 h before']);
  });

  it('describes a recurrence', () => {
    expect(analyse('Water the plants every mon', ctx('en'), en.dates).due).toEqual({
      label: 'Mon',
      state: 'thisWeek',
      repeats: 'Every Monday',
    });
  });

  it('leaves reminder tokens as text without a date, as the app does', () => {
    const r = analyse('Think about it !1h', ctx('en'), en.dates);
    expect(r.due).toBeNull();
    expect(r.reminders).toEqual([]);
    expect(r.segments).toEqual([{ kind: 'text', text: 'Think about it !1h' }]);
  });

  it('keeps a title made only of tokens', () => {
    const r = analyse('tomorrow', ctx('en'), en.dates);
    expect(r.title).toBe('tomorrow');
    expect(r.due).toBeNull();
  });

  it('strips escape backticks from the saved title, as the app does', () => {
    const r = analyse('Read `next week` notes tomorrow', ctx('en'), en.dates);
    expect(r.title).toBe('Read next week notes');
    expect(r.due?.label).toBe('Tomorrow');
    expect(r.segments.filter((s) => s.kind === 'date')).toEqual([
      { kind: 'date', text: 'tomorrow' },
    ]);
  });

  it('keeps a lone date phrase as the title but still applies its tags', () => {
    const r = analyse('tomorrow #work', ctx('en'), en.dates);
    expect(r.title).toBe('tomorrow');
    expect(r.due).toBeNull();
    expect(r.tags).toEqual(['work']);
    expect(r.segments).toEqual([
      { kind: 'text', text: 'tomorrow ' },
      { kind: 'tag', text: '#work' },
    ]);
  });

  it('shows no reminder when the date phrase stays as the title', () => {
    const r = analyse('tomorrow !1h', ctx('en'), en.dates);
    expect(r.title).toBe('tomorrow');
    expect(r.due).toBeNull();
    expect(r.reminders).toEqual([]);
  });

  it('marks a past time today as overdue', () => {
    expect(analyse('Standup today at 9', ctx('en'), en.dates).due?.state).toBe('overdue');
  });

  it('every example on the page parses to a dated task', () => {
    for (const example of en.dates.examples) {
      expect(analyse(example, ctx('en'), en.dates).due, example).not.toBeNull();
    }
  });
});

describe('demo texts', () => {
  it('formats reminder offsets', () => {
    expect(reminderText(0, en.dates)).toBe('At the due time');
    expect(reminderText(15, en.dates)).toBe('15 min before');
    expect(reminderText(120, en.dates)).toBe('2 h before');
    expect(reminderText(1440, en.dates)).toBe('1 day before');
  });

  it('formats rules', () => {
    expect(repeatText('FREQ=DAILY', 'due', 'en', en.dates)).toBe('Every day');
    expect(repeatText('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH', 'due', 'en', en.dates)).toBe(
      'Every 2 weeks on Monday and Thursday',
    );
    expect(repeatText('FREQ=YEARLY', 'due', 'en', en.dates)).toBe('Every year');
    expect(repeatText('nonsense', 'due', 'en', en.dates)).toBe('');
  });
});
