import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Integration tests: real LanceDB + real MiniLM model, isolated in a temp data dir.
let dataDir: string;
let vaultA: string;
let vaultB: string;
let indexer: any;

const NOTES: Record<string, string> = {
  'a.md': '# Alpha\nThe alpha note describes how the rollout of the search ranking proceeds.\n',
  'b.md': '# Beta\nThe beta note describes the retry pattern with exponential backoff and jitter.\n',
  'c.md': '# Gamma\nThe gamma note describes tenant login behaviour after the upgrade went out.\n',
};

async function writeNotes(dir: string) {
  for (const [rel, content] of Object.entries(NOTES)) {
    await fs.writeFile(path.join(dir, rel), content);
  }
}

let metaFile: string;
let hashFile: string;

async function findFile(prefix: string) {
  const names = await fs.readdir(dataDir);
  const hit = names.find(n => n.startsWith(prefix) && n.endsWith('.json'));
  return hit ? path.join(dataDir, hit) : path.join(dataDir, `${prefix}.json`);
}

async function crashOnSecondWrite(fn: () => Promise<unknown>) {
  const orig = (indexer as any).writeHashes.bind(indexer);
  const spy = vi.spyOn(indexer as any, 'writeHashes')
    .mockImplementationOnce(orig)
    .mockImplementationOnce(async () => { throw new Error('simulated crash'); });
  try {
    await expect(fn()).rejects.toThrow('simulated crash');
  } finally {
    spy.mockRestore();
  }
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'robust-test-data-'));
  vaultA = await fs.mkdtemp(path.join(os.tmpdir(), 'robust-test-vaultA-'));
  vaultB = await fs.mkdtemp(path.join(os.tmpdir(), 'robust-test-vaultB-'));
  process.env.OBSIDIAN_MCP_DATA_DIR = dataDir;
  await writeNotes(vaultA);
  await writeNotes(vaultB);
  const { VaultIndexer } = await import('./store.js');
  indexer = new VaultIndexer();
  const res = await indexer.indexVault(vaultA, true);
  expect(res.success).toBe(true);
  metaFile = await findFile('index-meta');
  hashFile = await findFile('file-hashes');
}, 120_000);

afterAll(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(vaultA, { recursive: true, force: true });
  await fs.rm(vaultB, { recursive: true, force: true });
});

describe('index ownership', () => {
  it('adopts an index with no meta file', async () => {
    await fs.rm(metaFile, { force: true });
    const res = await indexer.indexVault(vaultA);
    expect(res.message).toMatch(/up to date/);
    const meta = JSON.parse(await fs.readFile(metaFile, 'utf-8'));
    expect(meta.vault).toBe(await fs.realpath(vaultA));
  }, 120_000);

  it('refuses to index a different vault', async () => {
    await expect(indexer.indexVault(vaultB)).rejects.toThrow(/Index belongs to vault/);
    const res = await indexer.indexFile(vaultB, 'a.md');
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Index belongs to vault/);
    const hits = await indexer.search('alpha rollout search ranking');
    expect(hits[0].path).toBe('a.md');
  }, 120_000);
});

describe('crash safety', () => {
  it('an interrupted incremental pass re-embeds changed notes next run', async () => {
    await fs.writeFile(path.join(vaultA, 'a.md'), '# Alpha\nThe alpha note now mentions CRASHTOKEN-1 somewhere in this sentence.\n');
    await crashOnSecondWrite(() => indexer.indexVault(vaultA));
    const res = await indexer.indexVault(vaultA);
    expect(res.success).toBe(true);
    expect(res.chunks).toBeGreaterThan(0);
    const hits = await indexer.search('CRASHTOKEN-1');
    expect(hits[0].path).toBe('a.md');
    const table = await (indexer as any).getTable();
    const rows = await table.query().where(`path = 'a.md'`).toArray();
    const ids = rows.map((r: any) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 120_000);

  it('an interrupted full rebuild forces a full rebuild next run', async () => {
    await crashOnSecondWrite(() => indexer.indexVault(vaultA, true));
    const res = await indexer.indexVault(vaultA);
    expect(res.message ?? '').not.toMatch(/up to date/);
    const table = await (indexer as any).getTable();
    const total = await table.countRows();
    expect(res.chunks).toBe(total);
    const hashes = JSON.parse(await fs.readFile(hashFile, 'utf-8'));
    expect(Object.keys(hashes).sort()).toEqual(Object.keys(NOTES).sort());
  }, 120_000);
});

describe('single-note write path', () => {
  async function rowsFor(rel: string) {
    const table = await (indexer as any).getTable();
    return table.query().where(`path = '${rel}'`).toArray();
  }

  it('an emptied note leaves search', async () => {
    await fs.writeFile(path.join(vaultA, 'n.md'), '# N\nThis note carries the unusual marker EMPTYTOKEN-1 inside a sentence.\n');
    expect((await indexer.indexFile(vaultA, 'n.md')).success).toBe(true);
    expect((await indexer.search('EMPTYTOKEN-1'))[0].path).toBe('n.md');

    await fs.writeFile(path.join(vaultA, 'n.md'), '# N\n');
    const res = await indexer.indexFile(vaultA, 'n.md');
    expect(res).toMatchObject({ success: true, chunks: 0 });
    expect(await rowsFor('n.md')).toHaveLength(0);
    const hits = await indexer.search('EMPTYTOKEN-1');
    expect(hits.map((h: any) => h.path)).not.toContain('n.md');
    const hashes = JSON.parse(await fs.readFile(hashFile, 'utf-8'));
    expect(hashes['n.md']).toBeUndefined();
  }, 120_000);

  it('indexFile keeps the hash file current', async () => {
    await indexer.indexVault(vaultA);
    await fs.writeFile(path.join(vaultA, 'b.md'), '# Beta\nThe beta note now talks about circuit breakers and bulkheads in depth.\n');
    expect((await indexer.indexFile(vaultA, 'b.md')).success).toBe(true);
    const res = await indexer.indexVault(vaultA);
    expect(res.message).toMatch(/up to date/);
  }, 120_000);

  it('a single indexFile does not optimize', async () => {
    const table = await (indexer as any).getTable();
    const before = (await table.listVersions()).length;
    await fs.writeFile(path.join(vaultA, 'c.md'), '# Gamma\nThe gamma note was edited to mention quarterly capacity planning exercises.\n');
    expect((await indexer.indexFile(vaultA, 'c.md')).success).toBe(true);
    await table.checkoutLatest();
    expect((await table.listVersions()).length - before).toBeLessThanOrEqual(2);
  }, 120_000);
});

describe('delete crash safety', () => {
  it('an interrupted delete of removed notes is retried next run', async () => {
    await fs.writeFile(path.join(vaultA, 'b.md'), '# Beta\nThe beta note now carries GONETOKEN-1 in a sentence about gone things.\n');
    expect((await indexer.indexVault(vaultA)).success).toBe(true);
    expect((await indexer.search('GONETOKEN-1'))[0].path).toBe('b.md');

    await fs.rm(path.join(vaultA, 'b.md'));
    const table = await (indexer as any).getTable();
    const proto = Object.getPrototypeOf(table);
    const spy = vi.spyOn(proto, 'delete').mockImplementationOnce(async () => { throw new Error('simulated delete crash'); });
    try {
      await expect(indexer.indexVault(vaultA)).rejects.toThrow('simulated delete crash');
    } finally {
      spy.mockRestore();
    }

    const res = await indexer.indexVault(vaultA);
    expect(res.success).toBe(true);
    const after = await (indexer as any).getTable();
    expect(await after.query().where(`path = 'b.md'`).toArray()).toHaveLength(0);
    const hits = await indexer.search('GONETOKEN-1');
    expect(hits.map((h: any) => h.path)).not.toContain('b.md');
  }, 120_000);
});
