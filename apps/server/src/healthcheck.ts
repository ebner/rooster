// Docker HEALTHCHECK for the distroless image (no shell, no curl): exit 0 when /readyz is 200.
const port = process.env.PORT ?? '3000';

try {
  const res = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(3000) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
