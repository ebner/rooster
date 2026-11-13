/** A string that is already HTML (from `html` or `raw`): interpolated without escaping. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const escapes: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => escapes[c] ?? c);
}

export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

type Value = SafeHtml | string | number | false | null | undefined | readonly Value[];

function render(value: Value): string {
  if (value === false || value === null || value === undefined) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(String(value));
}

/** Escapes every interpolated string; nested `html` results and arrays of them pass through. */
export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? '');
  });
  return new SafeHtml(out);
}

/**
 * The copy's inline markup, after escaping: `code`, **strong** and *em*. The copy is ours;
 * this only saves writing tags in it.
 */
export function inline(text: string): SafeHtml {
  return raw(
    escapeHtml(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>'),
  );
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''));
}
