import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { env } from '@huggingface/transformers';
import { MODEL_NAME, MODEL_REVISION, loadExtractor, modelCacheDir } from './embedder.js';

// Own file, so no load by model id has run in this process: transformers memoizes its file probes,
// and an earlier successful probe would hide a network request this test must prove never happens.
const pinned = path.join(MODEL_NAME, MODEL_REVISION);

beforeAll(() => {
  // Fill the shared cache (no-op when it is already complete) in a child process, keeping this one cold.
  const script = `require(${JSON.stringify(require.resolve('@huggingface/transformers'))}).env.cacheDir = ${JSON.stringify(modelCacheDir())};
    require(${JSON.stringify(require.resolve('@huggingface/transformers'))}).pipeline('feature-extraction', ${JSON.stringify(MODEL_NAME)}, { dtype: 'q8', revision: ${JSON.stringify(MODEL_REVISION)} }).then(() => process.exit(0), e => { console.error(e); process.exit(1); });`;
  execFileSync(process.execPath, ['-e', script], { stdio: 'ignore' });
}, 120_000);

describe('embedder without network', () => {
  it('loads from a complete cache with no network', async () => {
    // A cache holding only the pinned revision: no `main` copies for the unrevisioned probes to find.
    const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'embedder-cache-'));
    await fs.cp(path.join(modelCacheDir(), pinned), path.join(cache, pinned), { recursive: true });
    const saved = { host: env.remoteHost, modelDir: process.env.OBSIDIAN_MCP_MODEL_DIR };
    env.remoteHost = 'http://127.0.0.1:9/';
    process.env.OBSIDIAN_MCP_MODEL_DIR = cache;
    try {
      const extractor = await loadExtractor();
      const out = await extractor('offline check', { pooling: 'mean', normalize: true });
      expect(out.dims).toEqual([1, 384]);
    } finally {
      env.remoteHost = saved.host;
      if (saved.modelDir === undefined) delete process.env.OBSIDIAN_MCP_MODEL_DIR;
      else process.env.OBSIDIAN_MCP_MODEL_DIR = saved.modelDir;
      await fs.rm(cache, { recursive: true, force: true });
    }
  }, 120_000);
});
