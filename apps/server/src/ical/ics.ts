// A minimal RFC 5545 writer for the calendar feed (FR-CAL, ADR 0049 §4.3): TEXT escaping,
// 75-octet line folding that never splits a UTF-8 sequence, and CRLF line ends.

export interface IcsEvent {
  /** `<taskId>@<host>`. */
  uid: string;
  summary: string;
  description: string;
  url: string;
  /** All-day: the floating date (`YYYY-MM-DD`) and the next day; timed: UTC instants (ms). */
  when: { date: string; nextDate: string } | { start: number; end: number };
  /** DTSTAMP (ms): the task's last change, so an unchanged feed has an unchanged ETag. */
  stamp: number;
}

export interface IcsCalendar {
  name: string;
  /** e.g. `-//rooster//rooster 1.3.0//EN`. */
  prodId: string;
  /** Suggested refresh interval for subscribers (RFC 7986 REFRESH-INTERVAL). */
  refreshMinutes: number;
  events: readonly IcsEvent[];
}

const CRLF = '\r\n';
// Controls other than tab are not allowed in TEXT; line breaks are escaped before this runs.
const CONTROLS = /[^\P{Cc}\t]/gu;
const MAX_OCTETS = 75;

/** RFC 5545 §3.3.11 TEXT: backslash, semicolon, comma and line breaks escaped; no controls. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(CONTROLS, '');
}

/**
 * RFC 5545 §3.1: content lines longer than 75 octets are folded with CRLF and one space. The
 * split falls between code points, so a multi-byte character is never cut.
 */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= MAX_OCTETS) return line;
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  // Continuation lines start with the folding space, which counts towards their 75 octets.
  let limit = MAX_OCTETS;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
      limit = MAX_OCTETS - 1;
    }
    current += ch;
    octets += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

/** `YYYY-MM-DD` → `YYYYMMDD` (DATE). */
function icsDate(date: string): string {
  return date.replace(/-/g, '');
}

/** ms → `YYYYMMDDTHHMMSSZ` (UTC DATE-TIME). */
export function icsUtc(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export function renderCalendar(calendar: IcsCalendar): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${calendar.prodId}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `NAME:${escapeText(calendar.name)}`,
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
    `REFRESH-INTERVAL;VALUE=DURATION:PT${calendar.refreshMinutes}M`,
    `X-PUBLISHED-TTL:PT${calendar.refreshMinutes}M`,
  ];
  for (const event of calendar.events) {
    lines.push('BEGIN:VEVENT', `UID:${escapeText(event.uid)}`, `DTSTAMP:${icsUtc(event.stamp)}`);
    if ('date' in event.when) {
      lines.push(
        `DTSTART;VALUE=DATE:${icsDate(event.when.date)}`,
        `DTEND;VALUE=DATE:${icsDate(event.when.nextDate)}`,
        // A day's to-do should not show the whole day as busy.
        'TRANSP:TRANSPARENT',
      );
    } else {
      lines.push(`DTSTART:${icsUtc(event.when.start)}`, `DTEND:${icsUtc(event.when.end)}`);
    }
    lines.push(
      `SUMMARY:${escapeText(event.summary)}`,
      `DESCRIPTION:${escapeText(event.description)}`,
      `URL:${event.url}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`;
}
