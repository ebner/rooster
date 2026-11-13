import { todayIn } from '@rooster/core/dates';
import type { Copy } from '../copy/en.ts';
import { analyse, type DemoResult } from '../demo/model.ts';
import { escapeHtml } from '../html.ts';
import { iconMarkup } from '../icons.ts';

const svg = (name: Parameters<typeof iconMarkup>[0]) =>
  `<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconMarkup(name)}</svg>`;

function mirrorHtml(result: DemoResult, raw: string): string {
  if (result.segments.length === 0) return escapeHtml(raw);
  return result.segments
    .map((s) =>
      s.kind === 'text'
        ? escapeHtml(s.text)
        : `<mark class="tok tok-${s.kind}">${escapeHtml(s.text)}</mark>`,
    )
    .join('');
}

/** The saved task as an app row, then what each token became. */
function savedHtml(result: DemoResult, copy: Copy['dates']): string {
  const r = copy.result;
  if (result.title === '') return `<p class="demo-empty">${escapeHtml(r.empty)}</p>`;
  const tags = result.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  const bell = result.reminders.length > 0 ? `<span class="meta">${svg('bell')}</span>` : '';
  const repeat = result.due?.repeats ? `<span class="meta">${svg('repeat')}</span>` : '';
  const due = result.due
    ? `<span class="due due-${result.due.state}">${escapeHtml(result.due.label)}</span>`
    : '';
  const row = `<div class="app-row"><span class="demo-check" aria-hidden="true"></span><span class="app-title">${escapeHtml(result.title)}</span>${tags}${bell}${repeat}${due}</div>`;
  const facts: [string, string][] = [
    [r.title, result.title],
    [r.due, result.due?.label ?? r.noDue],
  ];
  if (result.due?.repeats) facts.push([r.repeats, result.due.repeats]);
  if (result.tags.length > 0) facts.push([r.tags, result.tags.map((t) => `#${t}`).join(', ')]);
  if (result.reminders.length > 0) facts.push([r.reminders, result.reminders.join(', ')]);
  const list = facts
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
    .join('');
  return `${row}<dl class="demo-facts">${list}</dl>`;
}

export function mountDemo(root: HTMLElement): void {
  const input = root.querySelector<HTMLInputElement>('.demo-input');
  const mirror = root.querySelector<HTMLElement>('.demo-mirror');
  const resultBox = root.querySelector<HTMLElement>('[data-demo-result]');
  const saved = root.querySelector<HTMLElement>('[data-demo-saved]');
  const copyJson = root.querySelector('#demo-copy')?.textContent;
  if (!input || !mirror || !resultBox || !saved || !copyJson) return;
  const copy = JSON.parse(copyJson) as Copy['dates'];
  const locale = root.dataset.lang === 'sv' ? 'sv' : 'en';
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const update = () => {
    const now = Date.now();
    const result = analyse(
      input.value,
      { today: todayIn(timeZone, now), nowMs: now, timeZone, locale },
      copy,
    );
    mirror.innerHTML = mirrorHtml(result, input.value);
    mirror.scrollLeft = input.scrollLeft;
    saved.innerHTML = savedHtml(result, copy);
  };
  input.addEventListener('input', update);
  input.addEventListener('scroll', () => {
    mirror.scrollLeft = input.scrollLeft;
  });
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-example]')) {
    button.addEventListener('click', () => {
      input.value = button.dataset.example ?? '';
      update();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }
  resultBox.hidden = false;
  update();
}
