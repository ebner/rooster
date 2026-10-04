import type { Server } from 'node:http';

export interface ClosableServer {
  /**
   * Stops accepting connections, waits until every in-flight response has finished (at most
   * `graceMs`), then closes the remaining sockets. Resolves `true` when it drained in time.
   */
  close(graceMs: number): Promise<boolean>;
}

/**
 * `server.close()` alone waits for every open socket, including keep-alive and
 * pre-connected browser sockets that carry no request, so it would always hit the grace
 * timeout. Counting responses lets shutdown finish as soon as real work is done.
 */
export function trackConnections(server: Server): ClosableServer {
  let active = 0;
  let onDrained: (() => void) | undefined;

  server.on('request', (_req, res) => {
    active++;
    res.once('close', () => {
      active--;
      if (active === 0) onDrained?.();
    });
  });

  return {
    close(graceMs) {
      const closed = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      const drained = new Promise<boolean>((resolve) => {
        if (active === 0) resolve(true);
        else onDrained = () => resolve(true);
        setTimeout(() => resolve(false), graceMs).unref();
      });
      return drained.then(async (inTime) => {
        server.closeAllConnections();
        await closed;
        return inTime;
      });
    },
  };
}
