import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

/**
 * Writing files that belong to other apps (an MCP client's config) or that agents load (a
 * skill): never through a symlink, never half-written, never losing what was there.
 */

export type UnsafeReason = 'symlink' | 'notFile' | 'changed' | 'tooLarge';

/** A path this module will not write through; the command explains it (exit 5). */
export class UnsafePathError extends Error {
  constructor(
    readonly path: string,
    readonly reason: UnsafeReason,
  ) {
    super(`${reason}: ${path}`);
    this.name = 'UnsafePathError';
  }
}

/** A regular file as read: its text and the identity it had, to detect a swap before rename. */
export interface ReadFile {
  text: string;
  stat: Stats;
}

/** `O_NOFOLLOW` where the platform has it (not on Windows, where symlinks are rare). */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

/**
 * Every existing component from `base` (exclusive) down to `path` must be a real directory or,
 * for the last one, a real file: a symlink anywhere below `base` is refused. Used where the
 * tree may be someone else's, e.g. a cloned repository for `--project`.
 */
export function assertNoSymlinksBelow(base: string, path: string): void {
  const rel = relative(base, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new UnsafePathError(path, 'notFile');
  }
  let current = base;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    const stat = lstatOrNull(current);
    if (stat === null) return;
    if (stat.isSymbolicLink()) throw new UnsafePathError(current, 'symlink');
  }
}

/** The file at `path` if it exists: refused when it is a symlink or not a regular file. */
export function readRegularFile(path: string, maxBytes = 1024 * 1024): ReadFile | null {
  const stat = lstatOrNull(path);
  if (stat === null) return null;
  if (stat.isSymbolicLink()) throw new UnsafePathError(path, 'symlink');
  if (!stat.isFile()) throw new UnsafePathError(path, 'notFile');
  if (stat.size > maxBytes) throw new UnsafePathError(path, 'tooLarge');
  const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    // The path must still name what was checked (no swap between lstat and open).
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) {
      throw new UnsafePathError(path, 'changed');
    }
    return { text: readFileSync(fd, 'utf8'), stat: opened };
  } finally {
    closeSync(fd);
  }
}

export interface WriteOptions {
  /** What `readRegularFile` returned before (null: the file must still not exist). */
  previous: ReadFile | null;
  /** Mode of a new file; an existing file keeps its own permission bits. */
  newMode: number;
  /** Copy the previous content next to the file first (`<name>.<stamp>.bak`). */
  backup: boolean;
  /** Clock for the backup name. */
  now: number;
}

export interface WriteResult {
  backup: string | null;
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function writeExclusive(path: string, content: string, mode: number): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    mode,
  );
  try {
    // The umask must not loosen or tighten what the file had.
    fchmodSync(fd, mode);
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

/**
 * Replaces `path` with `content` atomically: a new temp file in the same directory (created
 * exclusively, never through a link), fsynced, then renamed over the target. The rename
 * replaces a path, not what a link points to. If the target changed since `previous` was
 * read (or appeared, or became a link), nothing is written.
 */
export function writeFileAtomic(path: string, content: string, options: WriteOptions): WriteResult {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mode = options.previous === null ? options.newMode : options.previous.stat.mode & 0o777;

  const check = () => {
    const now = lstatOrNull(path);
    if (options.previous === null) {
      if (now !== null) throw new UnsafePathError(path, 'changed');
      return;
    }
    if (now === null || now.isSymbolicLink() || !sameFile(now, options.previous.stat)) {
      throw new UnsafePathError(path, now?.isSymbolicLink() === true ? 'symlink' : 'changed');
    }
  };
  check();

  let backup: string | null = null;
  if (options.backup && options.previous !== null && options.previous.text !== content) {
    for (let attempt = 0; backup === null; attempt++) {
      const candidate = `${path}.${stamp(options.now)}${attempt === 0 ? '' : `-${attempt}`}.bak`;
      try {
        writeExclusive(candidate, options.previous.text, mode);
        backup = candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 20) throw error;
      }
    }
  }

  const temp = join(dir, `.${basename(path)}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  writeExclusive(temp, content, mode);
  try {
    check();
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Already gone (renamed) or unreachable; the original error is what matters.
    }
    throw error;
  }
  try {
    const dirFd = openSync(dir, constants.O_RDONLY);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Directory fsync is best effort (not supported on every platform).
  }
  return { backup };
}
