import type { ReactElement, ReactNode } from 'react';
import {
  Tooltip as AriaTooltip,
  type TooltipProps as AriaTooltipProps,
  TooltipTrigger,
  type TooltipTriggerComponentProps,
} from 'react-aria-components';
import { cn } from '../lib/cn';
import { Kbd } from './kbd';

/** 03 §3.8: 500 ms open delay; React Aria opens neighbours instantly once one is shown. */
const openDelayMs = 500;
/** Gap between trigger and tooltip, matching spacing step 1.5. */
const offsetPx = 6;

export const tooltipSurface =
  'inline-flex max-w-pane-min items-center gap-2 rounded-sm bg-bg-inverse px-2 py-1 text-xs text-text-inverse';

export interface TooltipProps extends Omit<TooltipTriggerComponentProps, 'children'> {
  /** Must be a focusable React Aria element (Button, IconButton, …). */
  children: ReactElement;
  content: ReactNode;
  /** Shortcut shown in a Kbd, e.g. `"Mod+K"` (03 §3.8: always include it when one exists). */
  shortcut?: string | undefined;
  placement?: AriaTooltipProps['placement'];
}

export function Tooltip({
  children,
  content,
  shortcut,
  placement = 'top',
  ...props
}: TooltipProps) {
  return (
    <TooltipTrigger delay={openDelayMs} closeDelay={0} {...props}>
      {children}
      <AriaTooltip
        placement={placement}
        offset={offsetPx}
        className={cn(tooltipSurface, 'data-entering:animate-fade-in')}
      >
        {content}
        {shortcut && <Kbd shortcut={shortcut} variant="inverse" />}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
