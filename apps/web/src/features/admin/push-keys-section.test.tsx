import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { PushKeysSection } from './push-keys-section';

describe('Admin → Push keys', () => {
  test('regenerating asks inline first and can be cancelled', async () => {
    const onRegenerate = vi.fn(async () => {});
    render(<PushKeysSection onRegenerate={onRegenerate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate push keys' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/pause push on every device/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('push-keys-confirm')).toBeNull();
    expect(onRegenerate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate push keys' }));
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate keys' }));
    await vi.waitFor(() => expect(onRegenerate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(screen.queryByTestId('push-keys-confirm')).toBeNull());
  });

  test('a failure keeps the confirmation open with an error', async () => {
    render(
      <PushKeysSection
        onRegenerate={vi.fn(async () => Promise.reject(new Error('x')))}
        defaultExpanded
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate keys' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
