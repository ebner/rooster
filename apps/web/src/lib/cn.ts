import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge must know the Coop theme (src/styles/theme.css): otherwise it
 * mistakes `text-group` for a colour and cannot de-duplicate named sizes such as
 * `h-control` vs `h-row`.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['group'],
      spacing: [
        'control-sm',
        'control',
        'control-lg',
        'row',
        'row-mobile',
        'row-subtask',
        'group',
        'group-mobile',
        'chip',
        'pill',
        'toolbar',
        'sheet-header',
        'property-row',
        'checkbox',
        'hit',
        'hit-touch',
        'calendar-cell',
      ],
      container: [
        'list-max',
        'list-min',
        'sidebar',
        'rail',
        'pane',
        'pane-min',
        'pane-max',
        'pane-overlay',
        'date-popover',
        'palette',
        'toast',
        'date-cell',
        'label-col',
        'illustration',
      ],
      shadow: ['pane'],
      ease: ['standard', 'exit', 'spring'],
      animate: ['check-pop', 'popover-in', 'fade-in', 'toast-in'],
    },
  },
});

/** Joins class names and resolves Tailwind conflicts (last one wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
