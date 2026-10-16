import { pipeline, Pipeline } from '@xenova/transformers';

export const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const MODEL_NAME = process.env.OBSIDIAN_RAG_MODEL || DEFAULT_MODEL;

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
  private pipe: Pipeline | null = null;
  private modelName = MODEL_NAME;

  private constructor() {}

  public static getInstance(): Embedder {
    if (!Embedder.instance) {
      Embedder.instance = new Embedder();
    }
    return Embedder.instance;
  }

  private async getPipeline(): Promise<Pipeline> {
    if (!this.pipe) {
      console.error('Loading embedding model...');
      this.pipe = await pipeline('feature-extraction', this.modelName) as unknown as Pipeline;
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
