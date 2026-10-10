import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { apiCall } from '../../../apps/web/e2e/support/auth';
import { DEMO } from './demo-env';

/** Thin JSON helpers over the public API, plus the hand-off file between seeding and shots. */

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export async function api<T = Record<string, unknown>>(
  page: Page,
  method: Method,
  path: string,
  data?: unknown,
): Promise<T> {
  const res = await apiCall(page, method, `/api/v1${path}`, data);
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? {} : await res.json()) as T;
}

/** A multipart upload (attachments, avatars): one part named `file`. */
export async function upload(
  page: Page,
  method: 'POST' | 'PUT',
  path: string,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  const res = await page.request.fetch(`/api/v1${path}`, {
    method,
    headers: { Origin: new URL(page.url()).origin },
    multipart: { file },
  });
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return res.json();
}

/** The viewer's calendar date in the demo timezone, and date arithmetic on floating dates. */
export function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: DEMO.timezone }).format(new Date());
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The first date on or after `iso` that falls on one of `weekdays` (0 = Sunday). */
export function nextWeekday(iso: string, weekdays: number[], from = 0): string {
  for (let i = from; i < from + 7; i += 1) {
    const candidate = addDays(iso, i);
    if (weekdays.includes(new Date(`${candidate}T12:00:00Z`).getUTCDay())) return candidate;
  }
  throw new Error('unreachable');
}

/** What the seed hands to the shot specs. */
export interface DemoState {
  people: Record<string, { id: string; email: string; name: string }>;
  orgs: { personal: string; studio: string; studioSlug: string; garden: string };
  tasks: Record<string, string>;
}

const statePath = () => {
  const dir = process.env.ROOSTER_DOCS_DATA_DIR;
  if (!dir) throw new Error('ROOSTER_DOCS_DATA_DIR unset');
  return resolve(dir, 'demo-state.json');
};

export function saveState(state: DemoState): void {
  writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

export function loadState(): DemoState {
  return JSON.parse(readFileSync(statePath(), 'utf8')) as DemoState;
}
