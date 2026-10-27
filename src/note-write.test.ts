import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readForEdit, writeAtomic, StaleNoteError } from './note-write.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'note-write-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('writeAtomic', () => {
  it('replaces content and leaves no temp file', async () => {
    const abs = path.join(dir, 'x.md');
    await fs.writeFile(abs, 'old');
    const { mtimeMs } = await readForEdit(abs);
    await writeAtomic(abs, 'new', { expectedMtimeMs: mtimeMs, displayPath: 'x.md' });
    expect(await fs.readFile(abs, 'utf-8')).toBe('new');
    expect(await fs.readdir(dir)).toEqual(['x.md']);
  });

  it('refuses when the note changed after it was read', async () => {
    const abs = path.join(dir, 'x.md');
    await fs.writeFile(abs, 'old');
    const { mtimeMs } = await readForEdit(abs);
    const future = new Date(Date.now() + 5000);
    await fs.utimes(abs, future, future);
    await expect(writeAtomic(abs, 'new', { expectedMtimeMs: mtimeMs, displayPath: 'x.md' }))
      .rejects.toThrow('Note changed on disk since it was read: x.md. Re-read it and retry.');
    expect(await fs.readFile(abs, 'utf-8')).toBe('old');
    expect(await fs.readdir(dir)).toEqual(['x.md']);
  });

  it('removes its temp file when rename fails', async () => {
    const abs = path.join(dir, 'x.md');
    await fs.mkdir(abs);
    await expect(writeAtomic(abs, 'new', { displayPath: 'x.md' })).rejects.toThrow();
    expect((await fs.readdir(dir)).filter(f => f.includes('.tmp-'))).toEqual([]);
  });

  it('writes through a symlink', async () => {
    const real = path.join(dir, 'real.md'), link = path.join(dir, 'link.md');
    await fs.writeFile(real, 'old');
    await fs.symlink(real, link);
    const { mtimeMs } = await readForEdit(link);
    await writeAtomic(link, 'new', { expectedMtimeMs: mtimeMs, displayPath: 'link.md' });
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(real, 'utf-8')).toBe('new');
    expect((await fs.readdir(dir)).filter(f => f.includes('.tmp-'))).toEqual([]);
  });

  it('keeps the note mode', async () => {
    const abs = path.join(dir, 'x.md');
    await fs.writeFile(abs, 'old');
    await fs.chmod(abs, 0o600);
    await writeAtomic(abs, 'new', { displayPath: 'x.md' });
    expect((await fs.stat(abs)).mode & 0o777).toBe(0o600);
  });

  it('throws StaleNoteError for a changed note', async () => {
    const abs = path.join(dir, 'x.md');
    await fs.writeFile(abs, 'old');
    const { mtimeMs } = await readForEdit(abs);
    await fs.utimes(abs, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    await expect(writeAtomic(abs, 'new', { expectedMtimeMs: mtimeMs, displayPath: 'x.md' })).rejects.toBeInstanceOf(StaleNoteError);
  });
});
