import { create } from 'zustand';

interface AnnouncerState {
  message: string;
  /** Re-announces identical messages. */
  key: number;
}

const useAnnouncer = create<AnnouncerState>()(() => ({ message: '', key: 0 }));

/** 02 §15: screen-reader announcements for moves, selection counts and drag and drop. */
export function announce(message: string): void {
  useAnnouncer.setState((s) => ({ message, key: s.key + 1 }));
}

export function lastAnnouncement(): string {
  return useAnnouncer.getState().message;
}

/** The polite live region of the list. */
export function ListLiveRegion() {
  const { message, key } = useAnnouncer();
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="list-live">
      <span key={key}>{message}</span>
    </div>
  );
}
