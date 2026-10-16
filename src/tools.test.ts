import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runTool, TOOL_DEFINITIONS, UnknownToolError, type ToolContext } from './tools.js';

let vp: string;
let ctx: ToolContext;
let reindex: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vp = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-test-'));
  await fs.writeFile(path.join(vp, 'a.md'), 'hello a');
  await fs.mkdir(path.join(vp, 'sub'));
  await fs.writeFile(path.join(vp, 'sub', 'b.md'), 'hello b');
  reindex = vi.fn();
  ctx = {
    getVaultPath: (o?: string) => o || vp,
    setVaultPath: vi.fn(async () => {}),
    indexer: {} as any,
    reindex: reindex as any,
  };
});

afterEach(async () => {
  await fs.rm(vp, { recursive: true, force: true });
});

describe('runTool', () => {
  it('reads a note', async () => {
    expect(await runTool('obsidian_read_note', { file_path: 'a.md' }, ctx)).toBe('hello a');
  });
  it('lists notes in a subfolder', async () => {
    const out = await runTool('obsidian_list_notes', { subfolder: 'sub' }, ctx);
    expect(out).toContain('sub/b.md');
    expect(out).not.toContain('a.md');
  });
  it('creates a note and reindexes', async () => {
    await runTool('obsidian_create_note', { file_path: 'c.md', content: 'x' }, ctx);
    expect(await fs.readFile(path.join(vp, 'c.md'), 'utf-8')).toBe('x');
    expect(reindex).toHaveBeenCalledWith(vp, 'c.md');
  });
  it('rejects unknown tools', async () => {
    await expect(runTool('nope', {}, ctx)).rejects.toBeInstanceOf(UnknownToolError);
  });
  it('coerces CLI string force_reindex', async () => {
    const indexVault = vi.fn(async () => ({ ok: true }));
    ctx.indexer = { indexVault } as any;
    await runTool('obsidian_rag_index', { force_reindex: 'true' }, ctx);
    expect(indexVault).toHaveBeenCalledWith(vp, true);
  });
  it('passes RAG filters and prints Section only for headed hits', async () => {
    const search = vi.fn(async () => [
      { path: 'working/p.md', heading: 'Plan > Steps', text: 'do it', date: '2026-10-01', status: '', type: 'plan' },
      { path: 'top.md', heading: '', text: 'intro', date: '', status: '', type: '' },
    ]);
    ctx.indexer = { search } as any;
    const out = await runTool('obsidian_rag_query', { query: 'q', limit: '3', folder: 'working', type: 'plan', after: '2026-01-01' }, ctx);
    expect(search).toHaveBeenCalledWith('q', { limit: 3, folder: 'working', type: 'plan', status: undefined, after: '2026-01-01' });
    expect(out).toContain('File: working/p.md\nMeta: working · 2026-10-01 · type: plan\nSection: Plan > Steps\nContent: do it');
    expect(out).toContain('File: top.md\nMeta: (root)\nContent: intro');
    expect(out).not.toContain('Relevance');
  });
});

describe('TOOL_DEFINITIONS', () => {
  it('has unique names', () => {
    const names = TOOL_DEFINITIONS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
