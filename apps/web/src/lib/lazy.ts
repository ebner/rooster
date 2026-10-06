import { type ComponentType, type LazyExoticComponent, lazy } from 'react';

/**
 * `React.lazy` with a `preload()` that starts (and shares) the chunk download. 10 §4: UI that
 * only appears on interaction (popovers, the editor) stays out of the initial bundle and is
 * warmed while the app is idle, so the first open does not wait on the network.
 */
export function lazyWithPreload<P extends object>(
  load: () => Promise<ComponentType<P>>,
): LazyExoticComponent<ComponentType<P>> & { preload: () => Promise<ComponentType<P>> } {
  let pending: Promise<ComponentType<P>> | null = null;
  let loaded: ComponentType<P> | null = null;
  const preload = () => {
    pending ??= load().then(
      (component) => {
        loaded = component;
        return component;
      },
      (error: unknown) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  };
  // Once the chunk is in (prefetched at idle), hand React a thenable that resolves
  // synchronously: `lazy` then renders on the first pass instead of suspending for a frame.
  const factory = () =>
    loaded
      ? ({
          // biome-ignore lint/suspicious/noThenProperty: a deliberate synchronous thenable for `lazy`
          then: (resolve: (m: { default: ComponentType<P> }) => void) =>
            resolve({ default: loaded as ComponentType<P> }),
        } as unknown as Promise<{ default: ComponentType<P> }>)
      : preload().then((component) => ({ default: component }));
  return Object.assign(lazy(factory), { preload });
}

/** Runs `preloads` once the browser is idle (or after 2 s where idle callbacks don't exist). */
export function preloadWhenIdle(preloads: readonly (() => Promise<unknown>)[]): void {
  const run = () => {
    for (const preload of preloads) void preload().catch(() => undefined);
  };
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(run, { timeout: 5000 });
  } else {
    setTimeout(run, 2000);
  }
}
