import { render } from '@react-email/render';
import type { ReactElement } from 'react';

export interface RenderedMail {
  html: string;
  /** The plain-text alternative (links as `text [url]`). */
  text: string;
}

/** Renders a template to HTML and to its plain-text alternative. */
export async function renderMail(element: ReactElement): Promise<RenderedMail> {
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { html, text };
}
