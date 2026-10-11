export interface ShotMeta {
  /** Device pixels per CSS pixel. */
  scale: number;
  /** The window width in CSS px. */
  viewport: number;
}
export const VIEWPORT_KEY: string;
export function writeShotMeta(png: Buffer, meta: ShotMeta): Buffer;
export function readShotMeta(png: Buffer): ShotMeta | null;
