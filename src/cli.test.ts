import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from './cli.js';
import type { ToolContext } from './tools.js';

let tmp: string;
let vaultDir: string;
let out: string[];
let err: string[];
let indexFile: ReturnType<typeof vi.fn>;
let ctx: ToolContext;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-')));
  vaultDir = path.join(tmp, 'vault');
  fs.mkdirSync(path.join(vaultDir, 'Notes'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, '.obsidian-mcp-schema.json'), '{"rules":[{"prefix":"","required":["type"]}]}');
  fs.writeFileSync(path.join(vaultDir, 'Notes', 'a.md'), '# a\n');
  out = [];
  err = [];
  indexFile = vi.fn(async () => ({ success: true, message: 'ok' }));
  ctx = {
    getVaultPath: () => vaultDir,
    setVaultPath: vi.fn(async () => {}),
    indexer: { indexFile, search: vi.fn(async () => []) } as any,
    reindex: vi.fn(),
  };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(argv: string[], stdin = '') {
  return runCli(argv, {
    ctx,
    vault: { getVaultPath: () => vaultDir },
    readStdin: async () => stdin,
    out: s => out.push(s),
    err: s => err.push(s),
  });
}

const hookInput = (file_path: string, content: string) => JSON.stringify({ tool_input: { file_path, content } });

describe('runCli', () => {
  it('returns null for an unknown first arg', async () => {
    expect(await run(['serve'])).toBeNull();
    expect(await run([])).toBeNull();
    expect(ctx.allowForceReindex).toBeUndefined();
  });

  it('prints a tool result and returns 0', async () => {
    expect(await run(['obsidian_list_notes'])).toBe(0);
    expect(out.join('\n')).toContain('Notes/a.md');
    expect(err).toEqual([]);
  });

  it('prints a tool error to err and returns 1', async () => {
    expect(await run(['obsidian_read_note', '--file_path', 'Notes/missing.md'])).toBe(1);
    expect(err.length).toBe(1);
    expect(err[0]).toContain('missing.md');
    expect(out).toEqual([]);
  });

  it('applies one-shot ctx overrides', async () => {
    const original = ctx.reindex;
    await run(['obsidian_list_notes']);
    expect(ctx.allowForceReindex).toBe(true);
    ctx.reindex('v', 'r');
    expect(original).not.toHaveBeenCalled();
  });

  it('validate_frontmatter without --hook is a no-op returning 0', async () => {
    expect(await run(['validate_frontmatter'])).toBe(0);
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  describe('validate_frontmatter --hook', () => {
    it('blocks an in-vault note missing a required field', async () => {
      const code = await run(['validate_frontmatter', '--hook'], hookInput(path.join(vaultDir, 'Notes', 'b.md'), '---\ntitle: x\n---\nbody'));
      expect(code).toBe(2);
      expect(err[0]).toContain('[obsidian-mcp] Blocked: "Notes/b.md"');
    });
    it('passes a valid note', async () => {
      const code = await run(['validate_frontmatter', '--hook'], hookInput(path.join(vaultDir, 'Notes', 'b.md'), '---\ntype: note\n---\nbody'));
      expect(code).toBe(0);
      expect(err).toEqual([]);
    });
    it('ignores a file outside the vault', async () => {
      expect(await run(['validate_frontmatter', '--hook'], hookInput(path.join(tmp, 'other.md'), 'no frontmatter'))).toBe(0);
      expect(err).toEqual([]);
    });
    it('exits 0 on non-JSON stdin', async () => {
      expect(await run(['validate_frontmatter', '--hook'], 'not json')).toBe(0);
    });
    it('exits 0 on empty stdin', async () => {
      expect(await run(['validate_frontmatter', '--hook'], '')).toBe(0);
    });
  });

  describe('obsidian_rag_index --hook', () => {
    it('indexes an in-vault absolute path by its relative path', async () => {
      const code = await run(['obsidian_rag_index', '--hook'], JSON.stringify({ tool_input: { file_path: path.join(vaultDir, 'Notes', 'a.md') } }));
      expect(code).toBe(0);
      expect(indexFile).toHaveBeenCalledWith(vaultDir, 'Notes/a.md');
      expect(out.join('')).toContain('"success":true');
    });
    it('skips a path outside the vault', async () => {
      const code = await run(['obsidian_rag_index', '--hook'], JSON.stringify({ tool_input: { file_path: path.join(tmp, 'other.md') } }));
      expect(code).toBe(0);
      expect(indexFile).not.toHaveBeenCalled();
    });
  });

  describe('obsidian_rag_eval', () => {
    it('requires --file', async () => {
      expect(await run(['obsidian_rag_eval'])).toBe(1);
      expect(err).toEqual(['obsidian_rag_eval requires --file <queries.json>']);
    });
  });
});
