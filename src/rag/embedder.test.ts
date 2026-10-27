import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { pipeline } from '@huggingface/transformers';
import { EMBEDDER_ID, Embedder, MODEL_NAME, MODEL_REVISION, loadExtractor, modelCacheDir, modelSource } from './embedder.js';

describe('embedder', () => {
  it('modelCacheDir honors OBSIDIAN_MCP_MODEL_DIR and XDG_CACHE_HOME', () => {
    const saved = { model: process.env.OBSIDIAN_MCP_MODEL_DIR, xdg: process.env.XDG_CACHE_HOME };
    try {
      process.env.OBSIDIAN_MCP_MODEL_DIR = '/tmp/models-here';
      process.env.XDG_CACHE_HOME = '/tmp/xdg';
      expect(modelCacheDir()).toBe('/tmp/models-here');
      delete process.env.OBSIDIAN_MCP_MODEL_DIR;
      expect(modelCacheDir()).toBe(path.join('/tmp/xdg', 'obsidian-mcp', 'models'));
      delete process.env.XDG_CACHE_HOME;
      expect(modelCacheDir()).toBe(path.join(os.homedir(), '.cache', 'obsidian-mcp', 'models'));
    } finally {
      for (const [key, value] of [['OBSIDIAN_MCP_MODEL_DIR', saved.model], ['XDG_CACHE_HOME', saved.xdg]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('EMBEDDER_ID names transformers 4, the model, the pinned revision and q8', () => {
    expect(EMBEDDER_ID).toBe('transformers@4/Xenova/all-MiniLM-L6-v2@751bff37182d3f1213fa05d7196b954e230abad9/q8');
  });

  it('embeds to 384 normalized dims', async () => {
    const vector = await Embedder.getInstance().embed('tmux pane layout');
    expect(vector).toHaveLength(384);
    const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-3);
  }, 120_000);

  it('modelSource picks the cached directory for the revision, else the model id, else throws offline', () => {
    const cache = '/cache';
    expect(modelSource(cache, 'org/m', 'abc123', true, true)).toBe(path.join(cache, 'org/m', 'abc123'));
    expect(modelSource(cache, 'org/m', 'abc123', true, false)).toBe(path.join(cache, 'org/m', 'abc123'));
    expect(modelSource(cache, 'org/m', 'main', true, false)).toBe(path.join(cache, 'org/m'));
    expect(modelSource(cache, 'org/m', 'abc123', false, true)).toBe('org/m');
    expect(() => modelSource(cache, 'org/m', 'abc123', false, false)).toThrow(path.join(cache, 'org/m', 'abc123'));
    expect(() => modelSource(cache, 'org/m', 'main', false, false)).toThrow(path.join(cache, 'org/m'));
  });

  it('loading by model id and from the local cache gives identical vectors', async () => {
    await Embedder.getInstance().embed('warm the cache');
    const text = 'tmux pane layout';
    const byId = await pipeline('feature-extraction', MODEL_NAME, { dtype: 'q8', revision: MODEL_REVISION });
    const local = await loadExtractor();
    const a = await byId(text, { pooling: 'mean', normalize: true });
    const b = await local(text, { pooling: 'mean', normalize: true });
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
  }, 120_000);
});
