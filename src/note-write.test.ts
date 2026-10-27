import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { readForEdit, writeAtomic } from './note-write.js';

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
});
