import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Integration tests: real LanceDB + real MiniLM model, isolated in a temp data dir.
let dataDir: string;
let vault: string;
let indexer: any;

const NOTES: Record<string, string> = {
  'tickets/abcd.md': '---\ntitle: Ticket notes\n---\n# Ticket\nInvestigated ABCD-24680 where the tenant login loop broke after the upgrade.\n',
  'working/plan.md': '---\ntype: plan\n---\n# Rollout plan\nSteps to roll the new search ranking out to every agent safely.\n',
  'Engineering/pattern.md': '---\ntype: pattern\n---\n# Retry pattern\nUse exponential backoff with jitter when calling flaky remote services.\n',
  // Distractors: look like the exact tokens to the embedding model but share no full-text token with them.
  'tickets/near.md': '# ABCD24679\nABCD24679 ABCD24681 ABCD24670 ABCD24680X\n',
  'codes.md': '# Codes\nQXJ-UNIQ ZQX-UNIQ QXJ-UNIQ ZQX-UNIQ QXJ-UNIQ ZQX-UNIQ\n',
  // Folder names with LIKE/SQL metacharacters ('_' and "'") for the folder filter.
  'idx_team/a.md': '# Team A\nNotes from the team sync about the search ranking rollout.\n',
  'idxXteam/b.md': '# Team X\nNotes from the other team sync about the search ranking rollout.\n',
  "O'Brien notes/c.md": '# Brien\nPersonal notes on the search ranking rollout and agent tooling.\n',
  'old/dated.md': '---\ndate: 2025-01-01\n---\n# New year\nOld retrospective on the search ranking and agent tooling from last year.\n',
};

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'store-test-data-'));
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'store-test-vault-'));
  process.env.OBSIDIAN_MCP_DATA_DIR = dataDir;
  for (const [rel, content] of Object.entries(NOTES)) {
    await fs.mkdir(path.join(vault, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(vault, rel), content);
  }
  const { VaultIndexer } = await import('./store.js');
  indexer = new VaultIndexer();
  const res = await indexer.indexVault(vault, true);
  expect(res.success).toBe(true);
}, 120_000);

afterAll(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(vault, { recursive: true, force: true });
});

describe('VaultIndexer.search (hybrid)', () => {
  it('ranks an exact token match first', async () => {
    const hits = await indexer.search('ABCD-24680');
    expect(hits[0].path).toBe('tickets/abcd.md');
  }, 120_000);

  it('maxDistance drops far vector rows but keeps full-text rows', async () => {
    const all = await indexer.search('search ranking rollout', { limit: 10 });
    expect(all.length).toBeGreaterThan(1);
    // Nothing is this close, so only full-text hits survive.
    const ftsOnly = await indexer.search('ABCD-24680', { limit: 10, maxDistance: 0.0001 });
    expect(ftsOnly.map((h: any) => h.path)).toEqual(['tickets/abcd.md']);
    const none = await indexer.search('zzqq unrelated words', { limit: 10, maxDistance: 0.0001 });
    expect(none).toEqual([]);
  }, 120_000);

  it('maxDistance keeps vector rows within the bound', async () => {
    const all = await indexer.search('search ranking rollout', { limit: 10 });
    const loose = await indexer.search('search ranking rollout', { limit: 10, maxDistance: 100 });
    expect(loose.map((h: any) => h.path)).toEqual(all.map((h: any) => h.path));
  }, 120_000);

  it('runs full-text search on query-syntax characters without falling back', async () => {
    const errSpy = vi.spyOn(console, 'error');
    try {
      const hits = await indexer.search('forge ema --dry-run "quoted" a:b');
      expect(Array.isArray(hits)).toBe(true);
      const fallbackLogs = errSpy.mock.calls.filter(c => String(c[0]).includes('Full-text search failed'));
      expect(fallbackLogs).toEqual([]);
    } finally {
      errSpy.mockRestore();
    }
  }, 120_000);

  it('falls back to vector results and logs when full-text search errors', async () => {
    const lancedb = await import('@lancedb/lancedb');
    const ftsSpy = vi.spyOn(lancedb.Query.prototype, 'fullTextSearch').mockImplementation(() => {
      throw new Error('forced FTS failure');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const hits = await indexer.search('exponential backoff retry');
      expect(ftsSpy).toHaveBeenCalled();
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].path).toBe('Engineering/pattern.md');
      expect(errSpy.mock.calls.some(c => String(c[0]).includes('Full-text search failed'))).toBe(true);
    } finally {
      ftsSpy.mockRestore();
      errSpy.mockRestore();
    }
  }, 120_000);

  it.each([
    ['idx_team', 'idx_team/'],
    ["O'Brien notes", "O'Brien notes/"],
  ])('folder filter %s matches only that folder', async (folder, prefix) => {
    const hits = await indexer.search('team sync notes search ranking rollout', { folder, limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h: any) => h.path.startsWith(prefix))).toBe(true);
  }, 120_000);

  it('filters by type', async () => {
    const hits = await indexer.search('retry backoff plan', { type: 'pattern' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h: any) => h.type === 'pattern')).toBe(true);
  }, 120_000);

  it('filters by folder', async () => {
    const hits = await indexer.search('search ranking', { folder: 'working' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h: any) => h.path.startsWith('working/'))).toBe(true);
  }, 120_000);

  it('filters by date', async () => {
    const hits = await indexer.search('search ranking retrospective', { after: '2026-01-01', limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h: any) => h.path === 'old/dated.md')).toBe(false);
  }, 120_000);

  it('adds the full-text index to an index built before hybrid search', async () => {
    const lancedb = await import('@lancedb/lancedb');
    const table = await (await lancedb.connect(path.join(dataDir, 'lancedb'))).openTable('notes');
    const indices = await table.listIndices();
    expect(indices.map(i => i.indexType)).toContain('FTS');
    for (const idx of indices) await table.dropIndex(idx.name);
    const res = await indexer.indexVault(vault);
    expect(res.message).toMatch(/up to date/);
    const hits = await indexer.search('ABCD-24680');
    expect(hits[0].path).toBe('tickets/abcd.md');
  }, 120_000);

  it('finds a token from a note added by indexFile', async () => {
    await fs.writeFile(path.join(vault, 'new.md'), '# New\nAn added note about grocery shopping lists. Ref ZQXJ-UNIQUE.\n');
    const res = await indexer.indexFile(vault, 'new.md');
    expect(res.success).toBe(true);
    const hits = await indexer.search('ZQXJ-UNIQUE');
    expect(hits[0].path).toBe('new.md');
  }, 120_000);
});

describe('VaultIndexer version cleanup', () => {
  it('prunes versions older than the retention window on write', async () => {
    const lancedb = await import('@lancedb/lancedb');
    const table = await (await lancedb.connect(path.join(dataDir, 'lancedb'))).openTable('notes');
    expect((await table.listVersions()).length).toBeGreaterThan(2);
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 2 * 60 * 60 * 1000);
    try {
      await fs.writeFile(path.join(vault, 'prune.md'), '# Prune\nA note written to trigger version cleanup. Ref PRUNE-UNIQ.\n');
      const res = await indexer.indexFile(vault, 'prune.md');
      expect(res.success).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
    await table.checkoutLatest();
    expect((await table.listVersions()).length).toBeLessThanOrEqual(2);
    const hits = await indexer.search('PRUNE-UNIQ');
    expect(hits[0].path).toBe('prune.md');
  }, 120_000);
});
