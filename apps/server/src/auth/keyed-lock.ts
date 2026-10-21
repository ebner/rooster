/**
 * Serialises async work per key within this process (rooster runs one server process). The
 * refresh-token exchange uses it so that checking a token for reuse and the provider rotating
 * it happen as one step: a concurrent second use waits, then sees the rotated token (a retry
 * within the refresh grace, or reuse).
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      // The last waiter clears the key, so the map holds only keys in use.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
