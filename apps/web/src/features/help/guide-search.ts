import type { GuidePage } from './guide-model';

/**
 * Searching the guide (ADR 0058): every page is split into its sections at the `h2`/`h3`
 * headings of its build-time HTML, and a query matches a section that contains all of its
 * words. It runs on the loaded guide chunk, so it works offline like the guide itself.
 */

/** One section of a page: the text before the first heading (`id` null), or one heading's. */
export interface GuideSection {
  slug: string;
  pageTitle: string;
  lang: string;
  /** The heading's id (the URL fragment), or null for the page's opening text. */
  id: string | null;
  heading: string | null;
  text: string;
}

export interface Highlighted {
  text: string;
  match: boolean;
}

export interface GuideSearchResult {
  section: GuideSection;
  /** The section's heading (or the page title) with the matches marked. */
  title: Highlighted[];
  /** A line of the text around the first match, with the matches marked. */
  snippet: Highlighted[];
  score: number;
}

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return entities[name.toLowerCase()] ?? whole;
  });
}

const inlineTags = /<\/?(?:a|b|strong|em|i|code|kbd|mark|span|sub|sup|small|abbr)\b[^>]*>/gi;

/**
 * The visible text of a fragment of the guide's own HTML (trusted build output): inline tags
 * go without a trace ("**Done**," stays "Done,"), block tags leave a space.
 */
function plainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, ' $1 ')
      .replace(inlineTags, '')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

const headingPattern = /<h([23]) id="([^"]*)">([\s\S]*?)<\/h\1>/g;

/** A page's sections, in order. */
export function pageSections(page: GuidePage): GuideSection[] {
  const base = { slug: page.slug, pageTitle: page.title, lang: page.lang };
  const sections: GuideSection[] = [];
  let id: string | null = null;
  let heading: string | null = null;
  let start = 0;
  const push = (end: number) => {
    const text = plainText(page.html.slice(start, end));
    if (id !== null || text) sections.push({ ...base, id, heading, text });
  };
  for (const match of page.html.matchAll(headingPattern)) {
    push(match.index);
    id = decodeEntities(match[2] ?? '');
    heading = plainText(match[3] ?? '');
    start = match.index + match[0].length;
  }
  push(page.html.length);
  return sections;
}

const indexes = new WeakMap<readonly GuidePage[], GuideSection[]>();

/** Every section of the guide, built once per loaded guide. */
export function guideSections(pages: readonly GuidePage[]): GuideSection[] {
  let sections = indexes.get(pages);
  if (!sections) {
    sections = pages.flatMap(pageSections);
    indexes.set(pages, sections);
  }
  return sections;
}

/**
 * Lower case without accents, one UTF-16 unit for one, so a match's offsets in the folded text
 * are its offsets in the original: "aterkommande" finds "återkommande".
 */
export function fold(text: string): string {
  let out = '';
  for (const unit of text) {
    const folded = unit.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    out += folded.length === unit.length ? folded : unit;
  }
  return out;
}

/** The query's words, folded; empty when there is nothing to search for. */
export function queryWords(query: string): string[] {
  return [...new Set(fold(query).split(/\s+/).filter(Boolean))];
}

function ranges(folded: string, words: readonly string[]): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  for (const word of words) {
    for (let at = folded.indexOf(word); at >= 0; at = folded.indexOf(word, at + word.length)) {
      found.push([at, at + word.length]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const range of found) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

function highlight(text: string, words: readonly string[], from = 0, to = text.length) {
  const parts: Highlighted[] = [];
  let at = from;
  for (const [start, end] of ranges(fold(text), words)) {
    if (end <= from || start >= to) continue;
    const s = Math.max(start, from);
    const e = Math.min(end, to);
    if (s > at) parts.push({ text: text.slice(at, s), match: false });
    parts.push({ text: text.slice(s, e), match: true });
    at = e;
  }
  if (at < to) parts.push({ text: text.slice(at, to), match: false });
  return parts;
}

const snippetBefore = 50;
/** How far back the snippet may start, to begin with the match's sentence. */
const sentenceBefore = 110;
const snippetLength = 180;

/** About a line of `text` from shortly before its first match, cut at word boundaries. */
function snippet(text: string, words: readonly string[]): Highlighted[] {
  const first = ranges(fold(text), words)[0];
  if (!first) return text ? highlight(text, words, 0, Math.min(text.length, snippetLength)) : [];
  // From the start of the match's sentence when it is close enough, else from a word shortly
  // before the match.
  const sentence = text.lastIndexOf('. ', first[0]);
  let start = 0;
  if (sentence >= 0 && first[0] - sentence <= sentenceBefore) {
    start = sentence + 2;
  } else if (first[0] > sentenceBefore) {
    const space = text.indexOf(' ', first[0] - snippetBefore);
    start = space >= 0 && space < first[0] ? space + 1 : first[0] - snippetBefore;
  }
  let end = Math.min(text.length, start + snippetLength);
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    end = space > first[1] ? space : end;
  }
  const parts = highlight(text, words, start, end);
  if (start > 0) parts.unshift({ text: '…', match: false });
  if (end < text.length) parts.push({ text: '…', match: false });
  return parts;
}

const wordStart = (folded: string, word: string) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(folded);

function score(section: GuideSection, words: readonly string[]): number {
  const heading = fold(section.heading ?? '');
  const page = fold(section.pageTitle);
  const text = fold(section.text);
  let total = 0;
  for (const word of words) {
    if (!heading.includes(word) && !page.includes(word) && !text.includes(word)) return 0;
    if (heading.includes(word)) total += wordStart(heading, word) ? 12 : 8;
    if (page.includes(word)) total += wordStart(page, word) ? 5 : 3;
    let count = 0;
    for (let at = text.indexOf(word); at >= 0 && count < 5; at = text.indexOf(word, at + 1)) {
      count += 1;
    }
    total += count + (count > 0 && wordStart(text, word) ? 1 : 0);
  }
  return total;
}

/** The sections that contain every word of `query`, best first, then in the guide's order. */
export function searchGuide(pages: readonly GuidePage[], query: string): GuideSearchResult[] {
  const words = queryWords(query);
  if (words.length === 0) return [];
  const sections = guideSections(pages);
  return sections
    .map((section, order) => ({ section, order, score: score(section, words) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ section, score }) => ({
      section,
      score,
      title: highlight(section.heading ?? section.pageTitle, words),
      snippet: snippet(section.text, words),
    }));
}
