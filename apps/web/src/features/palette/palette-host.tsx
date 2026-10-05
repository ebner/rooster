import { useRouter } from '@tanstack/react-router';
import { lazy, Suspense, useEffect } from 'react';
import { useRecentTaskRecorder } from './recent-tasks';
import { usePaletteStore } from './store';

/**
 * 10 §4: the palette is its own chunk, out of the initial bundle. It is fetched when the browser
 * is idle after start-up (or on the first open), so it also opens offline (02 §12) when the
 * service worker has not cached it yet.
 */
const loadPalette = () => import('./palette-root');
const PaletteRoot = lazy(() => loadPalette().then((module) => ({ default: module.PaletteRoot })));

function usePrefetchPalette(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const prefetch = () => void loadPalette().catch(() => undefined);
    if (typeof globalThis.requestIdleCallback === 'function') {
      const handle = globalThis.requestIdleCallback(prefetch, { timeout: 5000 });
      return () => globalThis.cancelIdleCallback(handle);
    }
    const timer = setTimeout(prefetch, 2000);
    return () => clearTimeout(timer);
  }, [enabled]);
}

function Recorder() {
  useRecentTaskRecorder();
  return null;
}

/**
 * Mounted once by the app shell: records opened tasks for the palette's recents and renders the
 * lazy palette once it has been opened. Outside the router (shell unit tests) it renders nothing.
 */
export function PaletteHost() {
  const router = useRouter({ warn: false });
  const loaded = usePaletteStore((s) => s.loaded);
  usePrefetchPalette(Boolean(router));
  if (!router) return null;
  return (
    <>
      <Recorder />
      {loaded && (
        <Suspense fallback={null}>
          <PaletteRoot />
        </Suspense>
      )}
    </>
  );
}
