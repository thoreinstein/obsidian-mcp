import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Integration tests: real LanceDB + real MiniLM model, isolated in a temp data dir.
let dataDir: string;
let vault: string;
let indexer: any;

const NOTES: Record<string, string> = {
  'tickets/fraas.md': '---\ntitle: Ticket notes\n---\n# Ticket\nInvestigated FRAAS-36446 where the tenant login loop broke after the upgrade.\n',
  'working/plan.md': '---\ntype: plan\n---\n# Rollout plan\nSteps to roll the new search ranking out to every agent safely.\n',
  'Engineering/pattern.md': '---\ntype: pattern\n---\n# Retry pattern\nUse exponential backoff with jitter when calling flaky remote services.\n',
  // Distractors: look like the exact tokens to the embedding model but share no full-text token with them.
  'tickets/near.md': '# FRAAS36445\nFRAAS36445 FRAAS36447 FRAAS36440 FRAAS36446X\n',
  'codes.md': '# Codes\nQXJ-UNIQ ZQX-UNIQ QXJ-UNIQ ZQX-UNIQ QXJ-UNIQ ZQX-UNIQ\n',
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
    const hits = await indexer.search('FRAAS-36446');
    expect(hits[0].path).toBe('tickets/fraas.md');
  }, 120_000);

  it('does not throw on query-syntax characters', async () => {
    const hits = await indexer.search('forge ema --dry-run "quoted" a:b');
    expect(Array.isArray(hits)).toBe(true);
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
    const hits = await indexer.search('FRAAS-36446');
    expect(hits[0].path).toBe('tickets/fraas.md');
  }, 120_000);

  it('finds a token from a note added by indexFile', async () => {
    await fs.writeFile(path.join(vault, 'new.md'), '# New\nAn added note about grocery shopping lists. Ref ZQXJ-UNIQUE.\n');
    const res = await indexer.indexFile(vault, 'new.md');
    expect(res.success).toBe(true);
    const hits = await indexer.search('ZQXJ-UNIQUE');
    expect(hits[0].path).toBe('new.md');
  }, 120_000);
});
