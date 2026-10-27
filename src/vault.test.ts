import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadAllowedRoots, createVaultResolver } from './vault.js';

let tmp: string;
let a: string;
let b: string;
let other: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  a = path.join(tmp, 'a');
  b = path.join(tmp, 'b');
  other = path.join(tmp, 'other');
  for (const d of [a, b, other]) fs.mkdirSync(d);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('createVaultResolver', () => {
  it('returns the allowed root for the exact path', () => {
    expect(createVaultResolver([a]).getVaultPath(a)).toBe(a);
  });

  it('returns the configured spelling for a symlink and a trailing slash', () => {
    const link = path.join(tmp, 'link');
    fs.symlinkSync(a, link);
    const v = createVaultResolver([a]);
    expect(v.getVaultPath(link)).toBe(a);
    expect(v.getVaultPath(a + path.sep)).toBe(a);
  });

  it('rejects a non-allowed directory', () => {
    expect(() => createVaultResolver([a]).getVaultPath(other)).toThrow(/Vault not allowed/);
    expect(() => createVaultResolver([a]).getVaultPath(os.tmpdir())).toThrow(/Vault not allowed/);
  });

  it('rejects a relative path', () => {
    expect(() => createVaultResolver([a]).getVaultPath('.')).toThrow(/Vault not allowed/);
  });

  it('defaults to the first allowed root that exists', () => {
    const missing = path.join(tmp, 'missing');
    expect(createVaultResolver([missing, b, a]).getVaultPath()).toBe(b);
  });

  it('setVaultPath rejects non-allowed dirs and keeps the default', async () => {
    const v = createVaultResolver([a, b]);
    await expect(v.setVaultPath(other)).rejects.toThrow(/Vault not allowed/);
    expect(v.getVaultPath()).toBe(a);
  });

  it('setVaultPath switches the default to another allowed root', async () => {
    const v = createVaultResolver([a, b]);
    await v.setVaultPath(b);
    expect(v.getVaultPath()).toBe(b);
  });

  it('throws the not-set error naming the config path when no roots', () => {
    const v = createVaultResolver([], '/x/config.json');
    expect(() => v.getVaultPath()).toThrow(/Vault path is not set.*OBSIDIAN_VAULT_PATH.*\/x\/config\.json/);
  });

  it('throws the not-set error when no allowed root exists', () => {
    expect(() => createVaultResolver([path.join(tmp, 'missing')]).getVaultPath()).toThrow(/Vault path is not set/);
  });
});

describe('loadAllowedRoots', () => {
  it('merges env and config in documented order', () => {
    const env = { OBSIDIAN_VAULT_PATHS: ['/p1', '/p2'].join(path.delimiter), OBSIDIAN_VAULT_PATH: '/e' };
    const config = { vault_path: '/c1', vault_paths: ['/c2', '/c3'] };
    expect(loadAllowedRoots(env, config)).toEqual(['/p1', '/p2', '/e', '/c2', '/c3', '/c1']);
  });

  it('handles missing env and null config', () => {
    expect(loadAllowedRoots({}, null)).toEqual([]);
  });

  it('drops relative entries', () => {
    expect(loadAllowedRoots({ OBSIDIAN_VAULT_PATH: 'rel/dir' }, { vault_path: '/abs' })).toEqual(['/abs']);
  });
});
