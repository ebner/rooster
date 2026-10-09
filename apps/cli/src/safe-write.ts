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
  statSync,
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
  /**
   * Every directory from here (exclusive) down to the file's own must be a real directory,
   * never a link; missing ones are created one by one. Without it the directories may be
   * reached through links (a dotfiles `~/.cursor`), and only the file's own directory is
   * pinned.
   */
  noLinksBelow?: string;
  /** Tests: runs after the temp file is written and before the final checks. */
  beforeCommit?: () => void;
}

export interface WriteResult {
  backup: string | null;
}

/**
 * The same file as read: identity, content markers, and the permissions and owner (a chmod
 * in between must not be undone by writing the old mode back).
 */
function sameFile(a: Stats, b: Stats): boolean {
  return (
    a.ino === b.ino &&
    a.dev === b.dev &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid
  );
}

type Write = (fd: number, buffer: Buffer, offset: number, length: number) => number;

/**
 * All of `data`, or an error: `write(2)` may write less than asked without failing (a full
 * disk, `ulimit -f`), and a short file must never be renamed into place.
 */
export function writeAll(fd: number, data: Buffer, write: Write = writeSync): void {
  let offset = 0;
  while (offset < data.length) {
    const written = write(fd, data, offset, data.length - offset);
    if (!(written > 0)) {
      const error = new Error('short write') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    }
    offset += written;
  }
}

/** Creates `path` exclusively (never through a link) with exactly `mode`; returns its identity. */
function writeExclusive(path: string, content: string, mode: number): Stats {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    mode,
  );
  try {
    // The umask must not loosen or tighten what the file had.
    fchmodSync(fd, mode);
    writeAll(fd, Buffer.from(content, 'utf8'));
    fsyncSync(fd);
    return fstatSync(fd);
  } finally {
    closeSync(fd);
  }
}

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

interface DirIdentity {
  path: string;
  dev: number;
  ino: number;
}

/**
 * The directories a write goes through, pinned by identity. Under `noLinksBelow` each one is
 * checked (and created) step by step and must not be a link; otherwise only the file's own
 * directory, as it resolves (links followed).
 */
function pinDirectories(dir: string, noLinksBelow: string | undefined): DirIdentity[] {
  if (noLinksBelow === undefined) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = statSync(dir);
    if (!stat.isDirectory()) throw new UnsafePathError(dir, 'notFile');
    return [{ path: dir, dev: stat.dev, ino: stat.ino }];
  }
  const rel = relative(noLinksBelow, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new UnsafePathError(dir, 'notFile');
  // The base itself may be reached through links (a dotfiles `~/.claude/skills`).
  mkdirSync(noLinksBelow, { recursive: true, mode: 0o700 });
  const pinned: DirIdentity[] = [];
  let current = noLinksBelow;
  for (const part of rel === '' ? [] : rel.split(sep)) {
    current = join(current, part);
    let stat = lstatOrNull(current);
    if (stat === null) {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink()) throw new UnsafePathError(current, 'symlink');
    if (!stat.isDirectory()) throw new UnsafePathError(current, 'notFile');
    pinned.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return pinned;
}

function checkPinned(pinned: readonly DirIdentity[], followLinks: boolean): void {
  for (const dir of pinned) {
    const now = followLinks ? statSync(dir.path, { throwIfNoEntry: false }) : lstatOrNull(dir.path);
    if (now === undefined || now === null || now.isSymbolicLink()) {
      throw new UnsafePathError(dir.path, now?.isSymbolicLink() === true ? 'symlink' : 'changed');
    }
    if (now.dev !== dir.dev || now.ino !== dir.ino) throw new UnsafePathError(dir.path, 'changed');
  }
}

const unlinkQuietly = (path: string) => {
  try {
    unlinkSync(path);
  } catch {
    // Already gone or unreachable; the original error is what matters.
  }
};

/**
 * Replaces `path` with `content` atomically: a new temp file in the same directory (created
 * exclusively, never through a link, every byte written and fsynced), then renamed over the
 * target. The rename replaces a path, not what a link points to.
 *
 * Nothing is written when, since `previous` was read, the target changed in any way (content,
 * mode, owner), appeared, or became a link; nor when a directory on the way was swapped (its
 * identity is pinned before the temp file is written and checked again just before the
 * rename), and a backup made for the attempt is removed again. Node has no `renameat`, so the
 * last check and the rename are two steps; the window between them is as small as it gets.
 */
export function writeFileAtomic(path: string, content: string, options: WriteOptions): WriteResult {
  const dir = dirname(path);
  const pinned = pinDirectories(dir, options.noLinksBelow);
  const mode = options.previous === null ? options.newMode : options.previous.stat.mode & 0o777;

  const checkTarget = () => {
    const now = lstatOrNull(path);
    if (options.previous === null) {
      if (now !== null) throw new UnsafePathError(path, 'changed');
      return;
    }
    if (now === null || now.isSymbolicLink() || !sameFile(now, options.previous.stat)) {
      throw new UnsafePathError(path, now?.isSymbolicLink() === true ? 'symlink' : 'changed');
    }
  };
  const checkAll = () => {
    checkPinned(pinned, options.noLinksBelow === undefined);
    checkTarget();
  };
  checkAll();

  let backup: string | null = null;
  const temp = join(dir, `.${basename(path)}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  let tempWritten = false;
  try {
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
    const written = writeExclusive(temp, content, mode);
    tempWritten = true;
    options.beforeCommit?.();
    checkAll();
    // The temp file must still be the one written, where it was written.
    const at = lstatOrNull(temp);
    if (at === null || at.dev !== written.dev || at.ino !== written.ino) {
      throw new UnsafePathError(temp, 'changed');
    }
    renameSync(temp, path);
  } catch (error) {
    if (tempWritten) unlinkQuietly(temp);
    if (backup !== null) unlinkQuietly(backup);
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
