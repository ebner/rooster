import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  type MenuItemProps as AriaMenuItemProps,
  type MenuProps as AriaMenuProps,
  Popover as AriaPopover,
  type PopoverProps as AriaPopoverProps,
  Header,
  MenuSection,
  MenuTrigger,
  Separator,
} from 'react-aria-components';
import { cn } from '../lib/cn';
import { iconStrokeWidth } from './button';
import { Kbd } from './kbd';
import { overlayOffsetPx, popoverMotion, popoverSurface } from './popover';

export { MenuTrigger };

export interface MenuProps<T extends object> extends Omit<AriaMenuProps<T>, 'className'> {
  className?: string | undefined;
}

/** The item list. Wrap in `MenuPopover` under a `MenuTrigger`, or render inline. */
export function Menu<T extends object>({ className, ...props }: MenuProps<T>) {
  return <AriaMenu {...props} className={cn('flex flex-col outline-none', className)} />;
}

export interface MenuPopoverProps extends Omit<AriaPopoverProps, 'className'> {
  className?: string | undefined;
}

export function MenuPopover({ className, ...props }: MenuPopoverProps) {
  return (
    <AriaPopover
      offset={overlayOffsetPx}
      placement="bottom start"
      {...props}
      className={cn(popoverSurface, popoverMotion, className)}
    />
  );
}

export interface MenuItemProps extends Omit<AriaMenuItemProps, 'className' | 'children'> {
  icon?: LucideIcon;
  /** Shortcut hint, e.g. `"Mod+D"`, rendered right-aligned in a Kbd. */
  shortcut?: string;
  tone?: 'default' | 'danger';
  children: ReactNode;
  className?: string | undefined;
}

/** 03 §3.8: 32 px tall, radius sm, 16 px icon + label + right-aligned Kbd. */
export function MenuItem({
  icon: Icon,
  shortcut,
  tone = 'default',
  children,
  className,
  ...props
}: MenuItemProps) {
  const textValue = props.textValue ?? (typeof children === 'string' ? children : undefined);
  return (
    <AriaMenuItem
      {...props}
      {...(textValue === undefined ? {} : { textValue })}
      className={cn(
        'flex h-control cursor-default items-center gap-2 rounded-sm px-2 text-sm outline-none',
        tone === 'danger' ? 'text-text-danger' : 'text-text',
        'data-focused:bg-bg-muted data-pressed:bg-bg-muted',
        'data-disabled:cursor-not-allowed data-disabled:text-text-disabled',
        className,
      )}
    >
      {Icon && (
        <Icon
          className={cn(
            'size-4 shrink-0',
            tone === 'danger' ? 'text-text-danger' : 'text-text-secondary',
          )}
          strokeWidth={iconStrokeWidth}
          aria-hidden
        />
      )}
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <Kbd shortcut={shortcut} className="ms-4" />}
    </AriaMenuItem>
  );
}

export function MenuSeparator() {
  return <Separator className="mx-1 my-1 h-px bg-border" />;
}

export interface MenuGroupProps {
  title: string;
  children: ReactNode;
}

export function MenuGroup({ title, children }: MenuGroupProps) {
  return (
    <MenuSection className="flex flex-col">
      <Header className="px-2 pt-1.5 pb-1 text-xs font-semibold text-text-muted">{title}</Header>
      {children}
    </MenuSection>
  );
}
