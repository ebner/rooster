import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Serves a fetch handler (the server's Hono app) on an ephemeral port: a real HTTP hop, so
 * the CLI runs exactly as against a remote instance.
 */
export async function serveFetch(
  handler: (request: Request) => Response | Promise<Response>,
): Promise<{ url: string; close: () => Promise<void> }> {
  let origin = '';
  const server: Server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        headers.append(req.rawHeaders[i] as string, req.rawHeaders[i + 1] as string);
      }
      const method = req.method ?? 'GET';
      const request = new Request(`${origin}${req.url ?? '/'}`, {
        method,
        headers,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
      });
      const response = await handler(request);
      const out: [string, string][] = [];
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') out.push([key, value]);
      });
      for (const cookie of response.headers.getSetCookie()) out.push(['set-cookie', cookie]);
      res.writeHead(response.status, out.flat());
      // Streamed, not buffered: `GET /api/v1/events` (SSE) never ends on its own.
      if (response.body === null) res.end();
      else {
        const reader = response.body.getReader();
        res.on('close', () => void reader.cancel().catch(() => {}));
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      }
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
