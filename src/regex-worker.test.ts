import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { grepVault } from './regex-worker.js';

let vp: string;
const files = ['a.md', 'sub/hello.md'];

beforeEach(async () => {
  vp = await fs.mkdtemp(path.join(os.tmpdir(), 'regex-worker-'));
  await fs.writeFile(path.join(vp, 'a.md'), 'Hello there\nnothing\n  heLLLo again  \n');
  await fs.mkdir(path.join(vp, 'sub'));
  await fs.writeFile(path.join(vp, 'sub', 'hello.md'), 'x\nhelo no\nhello b');
});

afterEach(async () => {
  await fs.rm(vp, { recursive: true, force: true });
});

describe('grepVault', () => {
  it('matches the in-process output format and ordering', async () => {
    const r = await grepVault(vp, files, 'hel+o', 'i', 50);
    expect(r).toEqual({
      lines: [
        'a.md:1: Hello there',
        'a.md:3: heLLLo again',
        'sub/hello.md (filename match)',
        'sub/hello.md:2: helo no',
        'sub/hello.md:3: hello b',
      ],
      extra: 0,
      extraFiles: 0,
    });
  });

  it('counts lines past the limit', async () => {
    const r = await grepVault(vp, files, 'hel+o', 'i', 2);
    expect(r.lines).toEqual(['a.md:1: Hello there', 'a.md:3: heLLLo again']);
    expect(r.extra).toBe(3);
    expect(r.extraFiles).toBe(1);
  });

  it('times out on catastrophic backtracking, then still works', async () => {
    await fs.writeFile(path.join(vp, 'evil.md'), 'a'.repeat(40) + '!');
    const start = Date.now();
    await expect(grepVault(vp, ['evil.md'], '^(a+)+$', 'i', 50, 300)).rejects.toThrow('timed out after 300 ms');
    expect(Date.now() - start).toBeLessThan(2000);
    const r = await grepVault(vp, files, 'hel+o', 'i', 50);
    expect(r.lines).toHaveLength(5);
  });
});
