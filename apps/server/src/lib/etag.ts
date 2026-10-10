/** Whether an `If-None-Match` header names the ETag (weak comparison, RFC 9110 §13.1.2). */
export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === '*') return true;
  return header
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .includes(etag);
}
