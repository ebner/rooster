/** A `tools/call` request found in a POST body, as the SDK will dispatch it. */
export interface ToolCallRequest {
  /** The JSON-RPC id, echoed on an error the HTTP layer answers instead of the SDK. */
  id: string | number | null;
  name: string;
  args: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every `tools/call` in a parsed JSON-RPC body: a single message or a batch (2025-03-26 clients
 * may batch). The SDK is handed the **same parsed value** (`parsedBody`), so what is checked
 * here is exactly what runs; a malformed call (no string `name`) is left to the SDK, which
 * rejects it without running anything.
 */
export function toolCallsOf(body: unknown): ToolCallRequest[] {
  const messages = Array.isArray(body) ? body : [body];
  const calls: ToolCallRequest[] = [];
  for (const message of messages) {
    if (!isObject(message) || message.method !== 'tools/call') continue;
    const params = message.params;
    if (!isObject(params) || typeof params.name !== 'string') continue;
    const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
    calls.push({ id, name: params.name, args: params.arguments });
  }
  return calls;
}

/** The id to echo on an HTTP-layer error: the single request's id, else null (JSON-RPC 2.0). */
export function echoId(body: unknown): string | number | null {
  if (!isObject(body)) return null;
  const id = body.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/** A JSON-RPC error body for answers the HTTP layer gives before the SDK sees the request. */
export function jsonRpcError(
  code: number,
  message: string,
  id: string | number | null = null,
): { jsonrpc: '2.0'; error: { code: number; message: string }; id: string | number | null } {
  return { jsonrpc: '2.0', error: { code, message }, id };
}
