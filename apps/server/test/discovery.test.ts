// AC-9.5: the discovery documents (11 §6.1). The Server Card is validated against the published
// JSON Schema (vendored in fixtures/); the AI Catalog and the skills index publish no schema, so
// they are checked against zod mirrors of their specification texts (sources cited below).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv, addFormats } from '@modelcontextprotocol/server/validators/ajv';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BASE_URL, tempDir } from './helpers.ts';
import { listCtx } from './list-helpers.ts';

/**
 * Server Card JSON Schema, https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json,
 * as generated in https://github.com/modelcontextprotocol/experimental-ext-server-card
 * (`schema.json`, commit 526201bb, the SEP-2127 snapshot).
 */
const serverCardSchema = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'mcp-server-card.schema.json'), 'utf8'),
) as { $schema?: string; $defs: Record<string, unknown> };

function validateServerCard(card: unknown): string[] {
  // Draft 2020-12 document; the keywords it uses ($defs, $ref, pattern, format) validate the
  // same under Ajv's default dialect, which is what the SDK bundles.
  const { $schema: _dialect, ...rest } = serverCardSchema;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile({ ...rest, $ref: '#/$defs/ServerCard' });
  return validate(card) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

/**
 * AI Catalog, https://github.com/Agent-Card/ai-catalog `specification/ai-catalog.md` (specVersion
 * 1.0): "Top-Level Structure", "Host Info", "Catalog Entry" (exactly one of `url`/`data`).
 */
const aiCatalogEntry = z
  .object({
    identifier: z.string().min(1),
    type: z.string().min(1),
    url: z.url().optional(),
    data: z.unknown().optional(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    version: z.string().optional(),
    updatedAt: z.iso.datetime().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((e) => (e.url === undefined) !== (e.data === undefined), 'exactly one of url or data');
const aiCatalogSchema = z.object({
  specVersion: z.string().regex(/^\d+\.\d+$/),
  host: z
    .object({
      displayName: z.string().min(1),
      identifier: z.string().optional(),
      documentationUrl: z.url().optional(),
      logoUrl: z.string().optional(),
    })
    .optional(),
  entries: z.array(aiCatalogEntry),
});

/**
 * Agent Skills Discovery v0.2.0, https://github.com/cloudflare/agent-skills-discovery-rfc
 * (README, "Discovery Index" and "Integrity and Verification"); names per the Agent Skills
 * naming rules quoted there.
 */
const skillsIndexSchema = z.object({
  $schema: z.literal('https://schemas.agentskills.io/discovery/0.2.0/schema.json'),
  skills: z.array(
    z.object({
      name: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      type: z.enum(['skill-md', 'archive']),
      description: z.string().min(1).max(1024),
      url: z.string().min(1),
      digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    }),
  ),
});

const DISCOVERY_PATHS = [
  '/mcp/server-card',
  '/.well-known/mcp/server-card.json',
  '/.well-known/ai-catalog.json',
  '/.well-known/agent-skills/index.json',
  '/.well-known/agent-skills/rooster/SKILL.md',
  '/llms.txt',
];

const get = (ctx: ReturnType<typeof listCtx>, url: string, headers: Record<string, string> = {}) =>
  ctx.app.request(url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url, { headers });

describe('AC-9.5 discovery documents', () => {
  it('leads an agent from the instance URL to the MCP endpoint and the skill', async () => {
    const ctx = listCtx();
    const catalogRes = await get(ctx, '/.well-known/ai-catalog.json');
    expect(catalogRes.status).toBe(200);
    expect(catalogRes.headers.get('content-type')).toBe('application/ai-catalog+json');
    const catalog = aiCatalogSchema.parse(await catalogRes.json());
    expect(catalog.specVersion).toBe('1.0');

    const cardEntry = catalog.entries.find((e) => e.type === 'application/mcp-server-card+json');
    expect(cardEntry?.identifier).toBe('urn:air:localhost:mcp:rooster');
    if (cardEntry?.url === undefined) throw new Error('no server card entry');
    const cardRes = await get(ctx, cardEntry.url, { accept: 'application/mcp-server-card+json' });
    expect(cardRes.status).toBe(200);
    expect(cardRes.headers.get('content-type')).toBe('application/mcp-server-card+json');
    const card = (await cardRes.json()) as {
      name: string;
      remotes: { type: string; url: string; supportedProtocolVersions: string[] }[];
    };
    expect(card.name).toBe('io.github.ebner/rooster');
    expect(card.remotes).toEqual([
      expect.objectContaining({ type: 'streamable-http', url: `${BASE_URL}/mcp` }),
    ]);
    expect(card.remotes[0]?.supportedProtocolVersions).toContain('2026-07-28');

    const skillEntry = catalog.entries.find((e) => e.type === 'application/agent-skills+md');
    expect(skillEntry?.url).toBe(`${BASE_URL}/.well-known/agent-skills/rooster/SKILL.md`);

    // Every catalog entry resolves on this instance.
    for (const entry of catalog.entries) {
      if (entry.url === undefined) continue;
      expect((await get(ctx, entry.url)).status, entry.url).toBe(200);
    }
  });

  it('validates the Server Card against the published schema', async () => {
    const ctx = listCtx();
    for (const path of ['/mcp/server-card', '/.well-known/mcp/server-card.json']) {
      const card = (await (await get(ctx, path)).json()) as Record<string, unknown>;
      expect(validateServerCard(card), path).toEqual([]);
      expect(card).toMatchObject({
        $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
        name: 'io.github.ebner/rooster',
        version: '0.0.0-test',
        title: 'rooster',
        websiteUrl: BASE_URL,
        icons: expect.arrayContaining([
          expect.objectContaining({ src: `${BASE_URL}/icons/icon-512.png` }),
        ]),
        _meta: {
          'io.github.ebner/authentication': {
            type: 'oauth2',
            protectedResourceMetadata: `${BASE_URL}/.well-known/oauth-protected-resource/mcp`,
          },
        },
      });
    }
    // The validator is not vacuous.
    expect(validateServerCard({ name: 'no-slash' })).not.toEqual([]);
  });

  it('indexes the skill with the sha256 digest of the exact bytes served', async () => {
    const ctx = listCtx();
    const indexRes = await get(ctx, '/.well-known/agent-skills/index.json');
    expect(indexRes.headers.get('content-type')).toBe('application/json');
    const index = skillsIndexSchema.parse(await indexRes.json());
    expect(index.skills).toHaveLength(1);
    const [skill] = index.skills as [(typeof index.skills)[number]];
    expect(skill.name).toBe('rooster');
    expect(skill.type).toBe('skill-md');

    const res = await get(ctx, skill.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(skill.digest);
    const md = bytes.toString('utf8');
    expect(md.startsWith('---\nname: rooster\n')).toBe(true);
    expect(md).toContain(BASE_URL);
  });

  it('serves llms.txt with what rooster is and the links an agent needs', async () => {
    const ctx = listCtx();
    const res = await get(ctx, '/llms.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    const text = await res.text();
    expect(text.startsWith('# rooster\n\n> ')).toBe(true);
    for (const link of [
      `${BASE_URL}/mcp`,
      `${BASE_URL}/.well-known/agent-skills/rooster/SKILL.md`,
      `${BASE_URL}/api/v1/openapi.json`,
      `${BASE_URL}/api/docs`,
      'rooster mcp setup',
    ]) {
      expect(text).toContain(link);
    }
  });

  it('allows any origin to read the documents, caches them and honours If-None-Match', async () => {
    const ctx = listCtx();
    for (const path of DISCOVERY_PATHS) {
      const res = await get(ctx, path);
      expect(res.headers.get('access-control-allow-origin'), path).toBe('*');
      expect(res.headers.get('access-control-expose-headers'), path).toBe('ETag');
      expect(res.headers.get('cache-control'), path).toBe('public, max-age=3600');
      const etag = res.headers.get('etag');
      expect(etag, path).toMatch(/^"[A-Za-z0-9_-]+"$/);
      const again = await get(ctx, path, { 'if-none-match': `W/${etag}` });
      expect(again.status, path).toBe(304);
      expect(await again.text()).toBe('');
      const head = await ctx.app.request(path, { method: 'HEAD' });
      expect(head.status, path).toBe(200);
      const preflight = await ctx.app.request(path, { method: 'OPTIONS' });
      expect(preflight.status, path).toBe(204);
      expect(preflight.headers.get('access-control-allow-methods')).toContain('GET');
    }
  });

  it('reveals no data: the documents are the same before and after users and tasks exist', async () => {
    const ctx = listCtx();
    const before = await Promise.all(DISCOVERY_PATHS.map(async (p) => (await get(ctx, p)).text()));
    const alice = ctx.user('alice.secret@example.com', 'Alice Secret');
    await alice.ok('POST', '/api/v1/orgs/personal/tasks', { title: 'Secret plan' }, 201);
    const after = await Promise.all(DISCOVERY_PATHS.map(async (p) => (await get(ctx, p)).text()));
    expect(after).toEqual(before);
    expect(after.join('\n')).not.toMatch(/secret/i);
  });
});

describe('AC-9.5 ROOSTER_AGENT_DISCOVERY=off', () => {
  it('answers 404 for the best-effort documents, never the web app, and keeps the OAuth metadata', async () => {
    const web = tempDir();
    try {
      mkdirSync(web.path, { recursive: true });
      writeFileSync(join(web.path, 'index.html'), '<!doctype html><title>shell</title>');
      const off = listCtx({
        env: { ROOSTER_AGENT_DISCOVERY: 'off', ROOSTER_WEB_DIR: web.path },
      });
      for (const path of DISCOVERY_PATHS) {
        const res = await get(off, path);
        expect(res.status, path).toBe(404);
        expect(await res.text(), path).not.toContain('shell');
      }
      expect((await get(off, '/.well-known/oauth-protected-resource/mcp')).status).toBe(200);
      expect((await get(off, '/.well-known/oauth-protected-resource')).status).toBe(200);
      // The endpoint itself stays.
      expect((await off.app.request('/mcp', { method: 'POST' })).status).toBe(401);
    } finally {
      web.cleanup();
    }
  });
});
