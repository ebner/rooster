/**
 * AC-8.4: every API response in the e2e suite validates against the OpenAPI document. The
 * e2e servers run with `ROOSTER_VALIDATE_RESPONSES=1` (playwright.config.ts), which checks
 * each `/api/v1` response and records mismatches; this global teardown, which runs while the
 * servers are still up, fails the run when any was recorded.
 */

/** Origins of the API servers under test, set by playwright.config.ts. */
export const RESPONSE_CONTRACT_SERVERS_ENV = 'ROOSTER_E2E_API_ORIGINS';

interface Violation {
  method: string;
  path: string;
  route: string | null;
  status: number;
  kind: string;
  message: string;
  issues?: { path: string; message: string }[];
}

function format(origin: string, v: Violation): string {
  const issues = (v.issues ?? []).map((i) => `\n      ${i.path || '(body)'}: ${i.message}`);
  return `  ${origin} ${v.method} ${v.path} → ${v.status} (${v.route ?? 'no route'}): ${v.kind}, ${v.message}${issues.join('')}`;
}

interface Report {
  checked: number;
  violations: Violation[];
}

async function reportOf(origin: string): Promise<Report | null> {
  try {
    const res = await fetch(`${origin}/__test/response-violations`);
    if (!res.ok) throw new Error(`${res.status}`);
    return (await res.json()) as Report;
  } catch {
    // The server never started (e.g. its project was not selected) or is already gone.
    return null;
  }
}

// biome-ignore lint/style/noDefaultExport: Playwright loads globalTeardown as a default export.
export default async function responseContractTeardown(): Promise<void> {
  const origins = (process.env[RESPONSE_CONTRACT_SERVERS_ENV] ?? '').split(',').filter(Boolean);
  const lines: string[] = [];
  let answered = 0;
  let checked = 0;
  for (const origin of origins) {
    const report = await reportOf(origin);
    if (report === null) continue;
    answered += 1;
    checked += report.checked;
    lines.push(...report.violations.map((v) => format(origin, v)));
  }
  if (answered === 0 && origins.length > 0) {
    throw new Error(`AC-8.4: no API server answered at ${origins.join(', ')}`);
  }
  if (lines.length > 0) {
    throw new Error(
      `AC-8.4: ${lines.length} of ${checked} API responses did not match the OpenAPI document:\n${lines.join('\n')}`,
    );
  }
  process.stdout.write(`AC-8.4: ${checked} API responses matched the OpenAPI document.\n`);
}
