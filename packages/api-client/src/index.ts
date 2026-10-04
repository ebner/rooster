import createClient, { type Client, type ClientOptions } from 'openapi-fetch';
import type { components, paths } from './schema';

export type { components, paths };
export type RoosterClient = Client<paths>;

export type RoosterClientOptions = ClientOptions & {
  /** Identifies the calling client for activity attribution, e.g. `cli/1.2.0` (06 §1). */
  clientName?: string;
};

/** Typed client for the rooster REST API, generated from the server's OpenAPI document. */
export function createRoosterClient(options: RoosterClientOptions = {}): RoosterClient {
  const { clientName, headers, ...rest } = options;
  return createClient<paths>({
    ...rest,
    headers: {
      ...(headers as Record<string, string> | undefined),
      ...(clientName ? { 'X-Rooster-Client': clientName } : {}),
    },
  });
}
