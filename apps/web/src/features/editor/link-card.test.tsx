import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { displayHref, LinkCard } from './link-card';

describe('LinkCard', () => {
  test('shows the address people read', () => {
    expect(displayHref('https://example.com/a/')).toBe('example.com/a');
    expect(displayHref('mailto:anna@example.com')).toBe('anna@example.com');
    expect(displayHref('/relative')).toBe('/relative');
  });

  test('Edit and Remove call back', () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    render(<LinkCard href="https://example.com" onEdit={onEdit} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledOnce();
  });

  test.each(['javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,x'])(
    'does not offer to open %j',
    (href) => {
      render(<LinkCard href={href} onEdit={() => {}} onRemove={() => {}} />);
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.getByRole('button', { name: 'Remove link' })).toBeTruthy();
    },
  );
});
