import * as fs from 'fs/promises';
import * as path from 'path';

let tmpCounter = 0;

/** Read a note and its mtime so a later write can detect that the note changed in between. */
export async function readForEdit(abs: string): Promise<{ content: string; mtimeMs: number }> {
  const content = await fs.readFile(abs, 'utf-8');
  return { content, mtimeMs: (await fs.stat(abs)).mtimeMs };
}

/**
 * Write via a temp file in the same directory, then rename over the note, so a crash never leaves a truncated note.
 * With `expectedMtimeMs`, refuses when the note changed since it was read.
 */
export async function writeAtomic(
  abs: string,
  content: string,
  opts: { expectedMtimeMs?: number; displayPath: string },
): Promise<void> {
  if (opts.expectedMtimeMs !== undefined && (await fs.stat(abs)).mtimeMs !== opts.expectedMtimeMs) {
    throw new Error(`Note changed on disk since it was read: ${opts.displayPath}. Re-read it and retry.`);
  }
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.tmp-${process.pid}-${tmpCounter++}`);
  try {
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}
