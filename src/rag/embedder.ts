import { env, pipeline, FeatureExtractionPipeline } from '@huggingface/transformers';
import * as os from 'os';
import * as path from 'path';

export const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
export const MODEL_NAME = process.env.OBSIDIAN_RAG_MODEL || DEFAULT_MODEL;
const MODEL_REVISION = process.env.OBSIDIAN_RAG_MODEL_REVISION || (MODEL_NAME === DEFAULT_MODEL ? DEFAULT_REVISION : 'main');

/** Recorded in the index meta; an index built by any other embedder is rebuilt, never mixed. */
export const EMBEDDER_ID = `transformers@4/${MODEL_NAME}@${MODEL_REVISION}/q8`;

/** Shared model cache, outside the install directory and the per-index data dir. */
export function modelCacheDir(): string {
  if (process.env.OBSIDIAN_MCP_MODEL_DIR) return process.env.OBSIDIAN_MCP_MODEL_DIR;
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cacheHome, 'obsidian-mcp', 'models');
}

const PREFIXES: Record<string, { query: string; document: string }> = {
  'Xenova/bge-small-en-v1.5': { query: 'Represent this sentence for searching relevant passages: ', document: '' },
  'nomic-ai/nomic-embed-text-v1.5': { query: 'search_query: ', document: 'search_document: ' },
};

export type EmbedKind = 'query' | 'document';

/** Suffix for per-model data paths; empty for the default model so existing indexes keep working. */
export const MODEL_SLUG = MODEL_NAME === DEFAULT_MODEL ? '' : '-' + MODEL_NAME.replace(/\//g, '__');

function withPrefix(text: string, kind: EmbedKind): string {
  return (PREFIXES[MODEL_NAME]?.[kind] ?? '') + text;
}

export class Embedder {
  private static instance: Embedder;
  private pipe: FeatureExtractionPipeline | null = null;
  private modelName = MODEL_NAME;

  private constructor() {}

  public static getInstance(): Embedder {
    if (!Embedder.instance) {
      Embedder.instance = new Embedder();
    }
    return Embedder.instance;
  }

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.pipe) {
      console.error('Loading embedding model...');
      env.cacheDir = modelCacheDir();
      env.allowRemoteModels = process.env.OBSIDIAN_MCP_OFFLINE !== '1';
      // Offline, transformers 4.3.1 probes for the tokenizer without the revision and misses the pinned
      // cache entry, so load the cached revision directory as a local model instead.
      const source = env.allowRemoteModels ? this.modelName : path.join(env.cacheDir, this.modelName, MODEL_REVISION);
      this.pipe = await pipeline('feature-extraction', source, { dtype: 'q8', revision: MODEL_REVISION });
      console.error('Model loaded.');
    }
    return this.pipe!;
  }

  public async embed(text: string, kind: EmbedKind = 'document'): Promise<number[]> {
    const pipe = await this.getPipeline();
    const output = await pipe(withPrefix(text, kind), { pooling: 'mean', normalize: true });
    // Output is a Tensor, we need to convert to array
    return Array.from(output.data);
  }

  public async embedBatch(texts: string[], kind: EmbedKind = 'document'): Promise<number[][]> {
    const pipe = await this.getPipeline();
    const output = await pipe(texts.map(t => withPrefix(t, kind)), { pooling: 'mean', normalize: true });
    // Output is a Tensor with dimensions [batch_size, embedding_dim]
    // We need to reshape the flat data array into an array of arrays
    const embeddingDim = output.dims[1];
    const embeddings: number[][] = [];
    for (let i = 0; i < output.dims[0]; i++) {
        embeddings.push(Array.from(output.data.slice(i * embeddingDim, (i + 1) * embeddingDim)));
    }
    return embeddings;
  }
}
