import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Integration test: real LanceDB + real MiniLM model, own temp data dir and vault.
let dataDir: string;
let vault: string;
let indexer: any;

const NOTES: Record<string, string> = {
  'k8s-a.md': '# Pods\nKubernetes pods run containers on cluster nodes managed by the kubelet.\n',
  'k8s-b.md': '# Deployments\nKubernetes deployments manage replica sets of pods across the cluster.\n',
  'pasta.md': '# Carbonara\nBoil spaghetti, then toss with eggs, pecorino cheese and crispy guanciale.\n',
};

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'related-test-data-'));
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'related-test-vault-'));
  process.env.OBSIDIAN_MCP_DATA_DIR = dataDir;
  for (const [rel, content] of Object.entries(NOTES)) {
    await fs.writeFile(path.join(vault, rel), content);
  }
  const { VaultIndexer } = await import('./store.js');
  indexer = new VaultIndexer();
  expect((await indexer.indexVault(vault, true)).success).toBe(true);
}, 120_000);

afterAll(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(vault, { recursive: true, force: true });
});

describe('VaultIndexer.similarNotes', () => {
  it('ranks the topical neighbour first and excludes the note itself', async () => {
    const hits = await indexer.similarNotes('k8s-a.md', 2);
    expect(hits[0].path).toBe('k8s-b.md');
    expect(hits.map((h: any) => h.path)).not.toContain('k8s-a.md');
  }, 120_000);

  it('returns [] for a note that is not indexed', async () => {
    expect(await indexer.similarNotes('missing.md', 3)).toEqual([]);
  }, 120_000);
});
