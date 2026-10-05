import { useCallback, useEffect, useState } from 'react';

export const sidebarStorageKey = 'rooster.sidebar.collapsed';

function readStored(): boolean | null {
  try {
    const value = globalThis.localStorage?.getItem(sidebarStorageKey);
    return value === '1' ? true : value === '0' ? false : null;
  } catch {
    // Storage can be unavailable (privacy modes); fall back to the breakpoint default.
    return null;
  }
}

function writeStored(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(sidebarStorageKey, collapsed ? '1' : '0');
  } catch {
    // Not persisting is acceptable: the toggle still works for this page view.
  }
}

/** 02 §2 breakpoints: the rail is the default below the desktop width (1200 px). */
const railByDefaultQuery = '(max-width: 1199.98px)';

function railByDefault(): boolean {
  return globalThis.matchMedia?.(railByDefaultQuery).matches ?? false;
}

/**
 * The sidebar's rail state (02 §2). An explicit choice is persisted per device;
 * without one, tablets start with the rail and desktops with the full sidebar.
 */
export function useSidebarCollapsed(): [collapsed: boolean, toggle: () => void] {
  const [stored, setStored] = useState<boolean | null>(readStored);
  const [narrow, setNarrow] = useState(railByDefault);

  useEffect(() => {
    const query = globalThis.matchMedia?.(railByDefaultQuery);
    if (!query) return;
    const onChange = () => setNarrow(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const collapsed = stored ?? narrow;
  const toggle = useCallback(() => {
    const next = !collapsed;
    writeStored(next);
    setStored(next);
  }, [collapsed]);

  return [collapsed, toggle];
}
