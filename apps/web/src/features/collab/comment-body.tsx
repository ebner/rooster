import {
  type CommentBlock,
  type CommentInline,
  parseCommentMarkdown,
} from '@rooster/core/comment-markdown';
import { Fragment, memo, type ReactNode, useMemo } from 'react';
import { cn } from '../../lib/cn';

export interface CommentBodyProps {
  /** The stored Markdown-light body (mentions as `@[Name](user:<id>)`). */
  body: string;
  /** Mentions of the viewer stand out. */
  viewerId?: string | undefined;
  /** Current names of mentioned users (the stored name is a snapshot). */
  nameOf?: ((userId: string) => string | undefined) | undefined;
  className?: string | undefined;
}

interface RenderContext {
  viewerId: string | undefined;
  nameOf: ((userId: string) => string | undefined) | undefined;
}

function inline(nodes: readonly CommentInline[], ctx: RenderContext): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${node.type}-${i}`;
    switch (node.type) {
      case 'text':
        return <Fragment key={key}>{node.text}</Fragment>;
      case 'break':
        return <br key={key} />;
      case 'strong':
        return (
          <strong key={key} className="font-semibold">
            {inline(node.children, ctx)}
          </strong>
        );
      case 'em':
        return <em key={key}>{inline(node.children, ctx)}</em>;
      case 'code':
        return (
          <code key={key} className="rounded-xs bg-bg-muted px-1 font-mono text-xs text-text">
            {node.text}
          </code>
        );
      case 'link':
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-xs break-words text-text-accent underline underline-offset-2 hover:text-text-accent-hover focus-visible:outline-2 focus-visible:outline-border-focus"
          >
            {inline(node.children, ctx)}
          </a>
        );
      case 'mention': {
        const name = ctx.nameOf?.(node.userId) ?? node.name;
        return (
          <span
            key={key}
            data-mention={node.userId}
            className={cn(
              'rounded-xs px-0.5 font-medium whitespace-nowrap',
              node.userId === ctx.viewerId
                ? 'bg-bg-accent-subtle text-text'
                : 'bg-bg-muted text-text',
            )}
          >
            @{name}
          </span>
        );
      }
      default:
        return null;
    }
  });
}

function block(node: CommentBlock, i: number, ctx: RenderContext): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p key={i}>{inline(node.children, ctx)}</p>;
    case 'code_block':
      return (
        <pre
          key={i}
          className="overflow-x-auto rounded-sm bg-bg-muted px-3 py-2 font-mono text-xs text-text"
        >
          <code>{node.text}</code>
        </pre>
      );
    case 'list': {
      const items = node.items.map((item, j) => <li key={j}>{inline(item, ctx)}</li>);
      return node.ordered ? (
        <ol key={i} start={node.start} className="list-decimal ps-5">
          {items}
        </ol>
      ) : (
        <ul key={i} className="list-disc ps-5">
          {items}
        </ul>
      );
    }
  }
}

/**
 * A posted comment (FR-COL-3, ADR 0028): the Markdown-light AST from
 * `@rooster/core/comment-markdown` rendered to React elements, so no body ever becomes raw
 * markup. Links open in a new tab; mentions are chips.
 */
export const CommentBody = memo(function CommentBody({
  body,
  viewerId,
  nameOf,
  className,
}: CommentBodyProps) {
  const blocks = useMemo(() => parseCommentMarkdown(body), [body]);
  const ctx = { viewerId, nameOf };
  return (
    <div
      className={cn('flex flex-col gap-2 text-sm break-words text-text', className)}
      data-testid="comment-body"
    >
      {blocks.map((node, i) => block(node, i, ctx))}
    </div>
  );
});
