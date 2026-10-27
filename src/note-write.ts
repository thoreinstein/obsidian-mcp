import * as fs from 'fs/promises';
import * as path from 'path';

let tmpCounter = 0;

/** Thrown when a note changed on disk between being read and being written. */
export class StaleNoteError extends Error {}

/** Read a note and its mtime so a later write can detect that the note changed in between. */
export async function readForEdit(abs: string): Promise<{ content: string; mtimeMs: number }> {
  // Stat first: a write landing between the two calls then reads as stale instead of pairing new mtime with old content.
  const { mtimeMs } = await fs.stat(abs);
  const content = await fs.readFile(abs, 'utf-8');
  return { content, mtimeMs };
}

/**
 * Write via a temp file in the same directory, then rename over the note, so a crash never leaves a truncated note.
 * Symlinked notes are written through. With `expectedMtimeMs`, refuses when the note changed since it was read.
 * The note keeps its permission bits, but a rename gives it a new inode: hard links and xattrs are not preserved.
 */
export async function writeAtomic(
  abs: string,
  content: string,
  opts: { expectedMtimeMs?: number; displayPath: string },
): Promise<void> {
  // Write through symlinks: replace the real target, not the link.
  abs = await fs.realpath(abs).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return abs; // new note: nothing to resolve
    throw e;
  });
  const existing = await fs.stat(abs).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' && opts.expectedMtimeMs === undefined) return null; // new note
    throw e;
  });
  if (opts.expectedMtimeMs !== undefined && existing!.mtimeMs !== opts.expectedMtimeMs) {
    throw new StaleNoteError(`Note changed on disk since it was read: ${opts.displayPath}. Re-read it and retry.`);
  }
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.tmp-${process.pid}-${tmpCounter++}`);
  try {
    await fs.writeFile(tmp, content, 'utf-8');
    if (existing) await fs.chmod(tmp, existing.mode & 0o7777);
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}
