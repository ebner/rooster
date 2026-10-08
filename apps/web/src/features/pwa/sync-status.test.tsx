import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useSyncStore } from '../../state/sync-store';
import { SyncStatus } from './sync-status';
import { setUpdateController, type UpdateController, useUpdateStore } from './update-controller';

afterEach(() => {
  setUpdateController(null);
  useUpdateStore.setState({ available: false, deferred: false });
  useSyncStore.setState({ online: true, pending: 0, failures: 0, sessionExpired: false });
});

describe('SyncStatus update chip (FR-PWA-6)', () => {
  test('nothing when all is saved and no update waits', () => {
    const { container } = render(<SyncStatus />);
    expect(container.innerHTML).toBe('');
  });

  test('the chip shows next to the pill and asks the controller to reload', () => {
    const request = vi.fn();
    setUpdateController({ request } as unknown as UpdateController);
    useSyncStore.setState({ online: false, pending: 0 });
    useUpdateStore.setState({ available: true });
    render(<SyncStatus className="extra" />);
    expect(screen.getByRole('status', { name: 'Sync status' })).toBeTruthy();
    const chip = screen.getByRole('button', { name: 'Update – a new version is available' });
    expect(chip.parentElement?.className).toContain('extra');
    fireEvent.click(chip);
    expect(request).toHaveBeenCalledOnce();
  });

  test('a deferred reload says so on the chip', () => {
    useUpdateStore.setState({ available: true, deferred: true });
    render(<SyncStatus />);
    expect(screen.getByRole('button', { name: 'Reloading when saved…' })).toBeTruthy();
    act(() => useUpdateStore.setState({ available: false, deferred: false }));
    expect(screen.queryByRole('button')).toBeNull();
  });
});
