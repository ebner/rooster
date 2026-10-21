import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { Button, buttonVariants } from './button';

describe('Button', () => {
  test('a focused button that goes away while loading leaves no unnamed announcement behind', () => {
    const { rerender, unmount } = render(<Button>Create</Button>);
    const button = screen.getByRole('button', { name: 'Create' });
    act(() => button.focus());
    rerender(<Button isLoading>Create</Button>);
    const pending = () =>
      [...document.querySelectorAll('[data-live-announcer] [aria-labelledby]')].filter((node) =>
        node.getAttribute('aria-labelledby')?.split(' ').includes(button.id),
      );
    expect(pending().length).toBeGreaterThan(0);
    unmount();
    expect(pending()).toHaveLength(0);
  });

  test.each([
    ['primary', 'bg-bg-accent', 'text-text-on-accent'],
    ['secondary', 'bg-bg-elevated', 'border-border'],
    ['ghost', 'bg-transparent', 'text-text-secondary'],
    ['danger', 'bg-bg-danger', 'text-text-on-danger'],
    ['link', 'text-text-accent', 'px-0'],
  ] as const)('%s variant uses token classes', (variant, a, b) => {
    render(<Button variant={variant}>Go</Button>);
    const button = screen.getByRole('button', { name: 'Go' });
    expect(button.className).toContain(a);
    expect(button.className).toContain(b);
  });

  test.each([
    ['sm', 'h-control-sm'],
    ['md', 'h-control'],
    ['lg', 'h-control-lg'],
  ] as const)('size %s maps to the control height', (size, height) => {
    expect(buttonVariants({ size }).split(' ')).toContain(height);
  });

  test('defaults to secondary / md', () => {
    const classes = buttonVariants({}).split(' ');
    expect(classes).toContain('bg-bg-elevated');
    expect(classes).toContain('h-control');
  });

  test('fires onPress and respects disabled', () => {
    const onPress = vi.fn();
    const { rerender } = render(<Button onPress={onPress}>Save</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onPress).toHaveBeenCalledTimes(1);
    rerender(
      <Button onPress={onPress} isDisabled>
        Save
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  });

  test('loading keeps the accessible name and blocks presses', () => {
    const onPress = vi.fn();
    render(
      <Button onPress={onPress} isLoading>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('data-pending')).toBe('true');
    fireEvent.click(button);
    expect(onPress).not.toHaveBeenCalled();
  });
});
