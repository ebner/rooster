import type { ExportFormat } from '@rooster/core/schemas';

/**
 * `GET /orgs/:orgId/export?format=json|markdown` (06 §2.8, FR-SET-5). The server answers with
 * `Content-Disposition: attachment`, so a plain same-origin link downloads it with the session
 * cookie; nothing goes through the query cache.
 */
export function exportUrl(orgId: string, format: ExportFormat): string {
  const params = new URLSearchParams({ format });
  return `/api/v1/orgs/${encodeURIComponent(orgId)}/export?${params.toString()}`;
}
