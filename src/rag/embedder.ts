import { env, pipeline, FeatureExtractionPipeline } from '@huggingface/transformers';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
export const MODEL_NAME = process.env.OBSIDIAN_RAG_MODEL || DEFAULT_MODEL;
export const MODEL_REVISION = process.env.OBSIDIAN_RAG_MODEL_REVISION || (MODEL_NAME === DEFAULT_MODEL ? DEFAULT_REVISION : 'main');

/** Recorded in the index meta; an index built by any other embedder is rebuilt, never mixed. */
export const EMBEDDER_ID = `transformers@4/${MODEL_NAME}@${MODEL_REVISION}/q8`;

/** Shared model cache, outside the install directory and the per-index data dir. */
export function modelCacheDir(): string {
  if (process.env.OBSIDIAN_MCP_MODEL_DIR) return process.env.OBSIDIAN_MCP_MODEL_DIR;
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(cacheHome, 'obsidian-mcp', 'models');
}

/** Files a cached model needs to load as a local model (q8 weights). */
const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

/** Where transformers caches a model: `main` has no revision segment. */
function localModelDir(cacheDir: string, model: string, revision: string): string {
  return revision === 'main' ? path.join(cacheDir, model) : path.join(cacheDir, model, revision);
}

/**
 * A complete cached model loads as a local directory, which never touches the network
 * (transformers 4.3.1 probes for the tokenizer remotely, ignoring the revision, when loading by id).
 * Otherwise load by id to fill the cache, or fail when downloads are off.
 */
export function modelSource(cacheDir: string, model: string, revision: string, complete: boolean, allowRemote: boolean): string {
  const dir = localModelDir(cacheDir, model, revision);
  if (complete) return dir;
  if (allowRemote) return model;
  throw new Error(`Embedding model ${model}@${revision} is not in the model cache at ${dir}, and OBSIDIAN_MCP_OFFLINE=1 forbids downloading it.`);
}

async function isComplete(dir: string): Promise<boolean> {
  const found = await Promise.all(MODEL_FILES.map(f => fs.access(path.join(dir, f)).then(() => true, () => false)));
  return found.every(Boolean);
}

export async function loadExtractor(): Promise<FeatureExtractionPipeline> {
  const cacheDir = env.cacheDir = modelCacheDir();
  env.allowRemoteModels = process.env.OBSIDIAN_MCP_OFFLINE !== '1';
  const complete = await isComplete(localModelDir(cacheDir, MODEL_NAME, MODEL_REVISION));
  const source = modelSource(cacheDir, MODEL_NAME, MODEL_REVISION, complete, env.allowRemoteModels);
  return source === MODEL_NAME
    ? pipeline('feature-extraction', source, { dtype: 'q8', revision: MODEL_REVISION })
    : pipeline('feature-extraction', source, { dtype: 'q8' });
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
      this.pipe = await loadExtractor();
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
