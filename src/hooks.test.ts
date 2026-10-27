import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hookNotePath } from './hooks.js';

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
  vault = path.join(tmp, 'vault');
  fs.mkdirSync(path.join(vault, 'Engineering'), { recursive: true });
  fs.mkdirSync(path.join(vault, '.obsidian'));
  fs.writeFileSync(path.join(vault, 'Engineering', 'ok.md'), '# ok\n');
  fs.writeFileSync(path.join(vault, '.obsidian', 'app.json'), '{}');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('hookNotePath', () => {
  it('returns the relative path for an absolute path inside the vault', async () => {
    expect(await hookNotePath(vault, path.join(vault, 'Engineering', 'ok.md'))).toBe('Engineering/ok.md');
  });
  it('returns the relative path for a vault-relative path', async () => {
    expect(await hookNotePath(vault, 'Engineering/ok.md')).toBe('Engineering/ok.md');
  });
  it('returns null for a path outside the vault', async () => {
    const outside = path.join(tmp, 'other', 'README.md');
    expect(await hookNotePath(vault, outside)).toBeNull();
  });
  it('returns null for non-note files', async () => {
    expect(await hookNotePath(vault, path.join(vault, '.obsidian', 'app.json'))).toBeNull();
  });
  it('handles a symlinked vault root with an absolute path through the real directory', async () => {
    const link = path.join(tmp, 'link');
    fs.symlinkSync(vault, link);
    const real = fs.realpathSync(vault);
    expect(await hookNotePath(link, path.join(real, 'Engineering', 'ok.md'))).toBe('Engineering/ok.md');
  });
});
