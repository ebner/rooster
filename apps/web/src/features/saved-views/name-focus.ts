/**
 * A request to focus (and select) a view's name in its header: the palette's "Rename view", and
 * a view just saved from a filter (its suggested name is meant to be replaced). It waits for
 * the header when the view is still opening.
 */
let requested = false;
const listeners = new Set<() => void>();

export function requestViewNameFocus(): void {
  requested = true;
  for (const listener of listeners) listener();
}

/** Takes the pending request (true once per request). */
export function takeNameFocus(): boolean {
  const was = requested;
  requested = false;
  return was;
}

export function subscribeNameFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
