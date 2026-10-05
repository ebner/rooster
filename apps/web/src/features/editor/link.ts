import { Mark } from '@tiptap/react';

/** Link attributes as stored on the mark. */
export interface LinkAttrs {
  href?: string | null;
  title?: string | null;
}

/** Schemes a description link may use; everything else (javascript:, data:) is refused. */
export const linkProtocols = ['http', 'https', 'mailto'] as const;

/**
 * The text GFM would turn into this link on its own (`https://…`, `www.…`, an email
 * address), or null when the link needs `[text](href)`.
 */
export function autolinkText(href: string): string | null {
  if (/^https?:\/\/\S+$/i.test(href)) return href;
  if (/^http:\/\/www\.\S+$/i.test(href)) return href.slice('http://'.length);
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(href)) return href.slice('mailto:'.length);
  return null;
}

/**
 * True when a link renders as a bare URL: its text is exactly what GFM would
 * auto-link, there is no title, and it ends where GFM's autolink would end
 * (trailing punctuation is left out of a bare autolink, so those use `<…>`).
 */
export function rendersBare(attrs: LinkAttrs, text: string | undefined): boolean {
  if (!attrs.href || attrs.title || text === undefined) return false;
  return autolinkText(attrs.href) === text && /[\p{L}\p{N}/]$/u.test(text);
}

function destination(href: string): string {
  // Spaces, angle brackets and unbalanced parentheses need the pointy-bracket form.
  const opens = href.split('(').length;
  const closes = href.split(')').length;
  return /[\s<>]/.test(href) || opens !== closes ? `<${href.replace(/[<>]/g, encodeURI)}>` : href;
}

/** Starter-kit Link options for descriptions (FR-DET-3): a new tab, safe `rel`, autolinks. */
export const linkOptions = {
  openOnClick: false,
  autolink: true,
  linkOnPaste: true,
  defaultProtocol: 'https',
  protocols: [...linkProtocols],
  isAllowedUri: (url: string, ctx: { defaultValidate: (url: string) => boolean }) => {
    if (!ctx.defaultValidate(url)) return false;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
    return scheme === undefined || (linkProtocols as readonly string[]).includes(scheme);
  },
  HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
};

/**
 * The Markdown side of the link mark, used only by the headless converter (the
 * editor's schema uses the starter-kit Link with `linkOptions`; both store
 * `{ href, title }`). Bare URLs stay bare, which the stock serializer would turn
 * into `[url](url)`; pasted links are the common case.
 */
export const LinkMarkdown = Mark.create({
  name: 'link',
  priority: 1000,
  addAttributes() {
    return { href: { default: null }, title: { default: null } };
  },
  markdownTokenName: 'link',
  parseMarkdown: (token, helpers) =>
    helpers.applyMark('link', helpers.parseInline(token.tokens ?? []), {
      href: token.href,
      title: token.title || null,
    }),
  renderMarkdown: (node, h, ctx) => {
    const attrs = (node.attrs ?? {}) as LinkAttrs;
    const href = attrs.href ?? '';
    const text = h.renderChildren(node);
    const markText = (ctx.meta as { markText?: string } | undefined)?.markText;
    if (rendersBare(attrs, markText)) return text;
    if (!attrs.title && markText !== undefined && autolinkText(href) === markText) {
      return `<${text}>`;
    }
    const title = attrs.title ? ` "${attrs.title.replace(/["\\]/g, '\\$&')}"` : '';
    return `[${text}](${destination(href)}${title})`;
  },
});
