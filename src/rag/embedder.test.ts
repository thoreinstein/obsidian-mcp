import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { EMBEDDER_ID, Embedder, modelCacheDir } from './embedder.js';

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
});
