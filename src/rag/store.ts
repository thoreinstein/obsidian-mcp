import * as lancedb from '@lancedb/lancedb';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { glob } from 'glob';
import matter from 'gray-matter';
import md5 from 'md5';
import { Embedder } from './embedder.js';
import { buildEmbeddingInputs, ChunkingOptions, ChunkMetadata, extractNoteMeta } from './chunking.js';
import { buildWhereClause, dedupeByPath, rrfMerge, SearchFilters } from '../utils.js';

function chunkingOptionsFromEnv(): ChunkingOptions {
  const minRaw = Number(process.env.OBSIDIAN_RAG_MIN_CHUNK_CHARS ?? '40');
  const maxRaw = Number(process.env.OBSIDIAN_RAG_MAX_CHUNK_CHARS ?? '1800');
  const targetRaw = Number(process.env.OBSIDIAN_RAG_TARGET_CHUNK_CHARS ?? '700');
  const min = Number.isFinite(minRaw) && minRaw > 0 ? Math.floor(minRaw) : 40;
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : 1800;
  const target = Number.isFinite(targetRaw) && targetRaw > min ? Math.floor(targetRaw) : 700;
  return { minChunkChars: min, maxChunkChars: max, targetChunkChars: target };
}

// Canonical data dir shared by every client of this server (gemini, claude, pi).
const DATA_DIR = process.env.OBSIDIAN_MCP_DATA_DIR || path.join(os.homedir(), '.config', 'obsidian-mcp');
const DB_PATH = path.join(DATA_DIR, 'lancedb');
const HASH_PATH = path.join(DATA_DIR, 'file-hashes.json');

interface NoteChunk extends ChunkMetadata {
  vector: number[];
}

export class VaultIndexer {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;

  constructor() {}

  private async getDb() {
    if (!this.db) {
      this.db = await lancedb.connect(DB_PATH);
    }
    return this.db;
  }

  private async getTable() {
    const db = await this.getDb();
    const tableNames = await db.tableNames();
    if (tableNames.includes('notes')) {
      this.table = await db.openTable('notes');
    }
    return this.table;
  }

  private async createOrGetTable(data?: any[]) {
    const db = await this.getDb();
    const tableNames = await db.tableNames();

    if (tableNames.includes('notes')) {
        this.table = await db.openTable('notes');
        if (data && data.length > 0) {
            await this.table.add(data);
        }
    } else {
        if (!data || data.length === 0) {
            // Cannot create empty table easily without schema in some versions,
            // but let's wait until we have data.
            return null;
        }
        this.table = await db.createTable('notes', data);
    }
    return this.table;
  }

  private async embedWithFallback(
    embedder: Embedder,
    texts: string[],
    meta: ChunkMetadata[]
  ): Promise<NoteChunk[]> {
    if (texts.length === 0) return [];

    try {
      const vectors = await embedder.embedBatch(texts);
      return meta.slice(0, vectors.length).map((item, idx) => ({
        ...item,
        vector: vectors[idx]
      }));
    } catch (batchErr) {
      console.error(`Failed to embed batch of ${texts.length} chunks; retrying one-by-one:`, batchErr);
    }

    const recovered: NoteChunk[] = [];
    for (let i = 0; i < texts.length; i++) {
      try {
        const vector = await embedder.embed(texts[i]);
        recovered.push({
          ...meta[i],
          vector
        });
      } catch (singleErr) {
        console.error(`Failed to embed chunk ${meta[i]?.id ?? i}:`, singleErr);
      }
    }
    return recovered;
  }

  public async indexFile(vaultPath: string, relativePath: string) {
    const embedder = Embedder.getInstance();
    const filePath = path.join(vaultPath, relativePath);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const { mtime } = await fs.stat(filePath);
      const { data, content: body } = matter(content);

      const meta = extractNoteMeta(relativePath, data, body, mtime);
      const { textsToEmbed, chunkMetadata } = buildEmbeddingInputs(relativePath, body, chunkingOptionsFromEnv(), meta);

      if (textsToEmbed.length > 0) {
          const chunks = await this.embedWithFallback(embedder, textsToEmbed, chunkMetadata);
          if (chunks.length === 0) {
              return { success: false, message: `Failed to embed content for ${relativePath}.` };
          }
          const chunkRows = chunks as unknown as Record<string, unknown>[];

          const db = await this.getDb();
          const tableNames = await db.tableNames();
          if (!tableNames.includes('notes')) {
              this.table = await db.createTable('notes', chunkRows);
          } else {
              this.table = await db.openTable('notes');
              // Delete old chunks for this file
              await this.table.delete(`path = '${relativePath.replace(/'/g, "''")}'`);
              await this.table.add(chunkRows);
          }
          await this.table.optimize();
          if (!(await this.hasFtsIndex(this.table))) await this.ensureFtsIndex(this.table);
          console.error(`Indexed ${chunks.length} chunks for ${relativePath}.`);
          return { success: true, chunks: chunks.length };
      }
      return { success: false, message: "No content to index or table not available." };
    } catch (err) {
      console.error(`Failed to index file ${filePath}:`, err);
      return { success: false, message: String(err) };
    }
  }

  public async removeFile(relativePath: string) {
    const table = await this.getTable();
    if (!table) return;
    await table.delete(`path = '${relativePath.replace(/'/g, "''")}'`);
  }

  public async indexVault(vaultPath: string, force: boolean = false) {
    const embedder = Embedder.getInstance();
    const db = await this.getDb();

    // Find all markdown files
    const files = await glob('**/*.md', { cwd: vaultPath, absolute: true });
    console.error(`Found ${files.length} notes in ${vaultPath}`);

    // Load previous file hashes for incremental indexing
    let previousHashes: Record<string, string> = {};
    if (!force) {
      try {
        previousHashes = JSON.parse(await fs.readFile(HASH_PATH, 'utf-8'));
      } catch { /* no previous hashes — will do full index */ }
    }

    const tableNames = await db.tableNames();
    const tableExists = tableNames.includes('notes');
    if (tableExists && !force) {
      // Tables built before chunks carried note metadata can't take new rows; rebuild.
      const schema = await (await db.openTable('notes')).schema();
      if (!schema.fields.some(f => f.name === 'title') || !schema.fields.some(f => f.name === 'heading')) {
        console.error('Index schema predates note metadata or heading chunks; forcing full re-index.');
        force = true;
      }
    }
    const hasPreviousHashes = Object.keys(previousHashes).length > 0;
    const canIncremental = tableExists && hasPreviousHashes && !force;

    const batchSizeRaw = Number(process.env.OBSIDIAN_RAG_EMBED_BATCH_SIZE ?? '48');
    const batchSize = Number.isFinite(batchSizeRaw) && batchSizeRaw > 0 ? Math.min(Math.floor(batchSizeRaw), 256) : 48;
    const useProgressBar = process.stderr.isTTY === true;
    const progressInterval = 100;

    // ── Phase 1: Read all files, compute hashes, build chunks for changed files ──
    const allTexts: string[] = [];
    const allMeta: ChunkMetadata[] = [];
    const currentHashes: Record<string, string> = {};
    const changedPaths: string[] = [];
    let filesRead = 0;
    let skippedFiles = 0;

    const renderReadProgress = () => {
      if (files.length === 0) return;
      if (useProgressBar) {
        const percent = Math.min(100, Math.floor((filesRead / files.length) * 100));
        const width = 30;
        const filled = Math.round((percent / 100) * width);
        const bar = `${'='.repeat(filled)}${'-'.repeat(width - filled)}`;
        process.stderr.write(
          `\rReading [${bar}] ${percent}% ${filesRead}/${files.length} files`
        );
        if (filesRead === files.length) process.stderr.write('\n');
        return;
      }
      if (filesRead % progressInterval === 0 || filesRead === files.length) {
        console.error(`Reading progress: ${filesRead}/${files.length} files`);
      }
    };

    const FILE_READ_CONCURRENCY = 50;
    for (let i = 0; i < files.length; i += FILE_READ_CONCURRENCY) {
      const batch = files.slice(i, i + FILE_READ_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (filePath) => {
          try {
            const content = await fs.readFile(filePath, 'utf-8');
            const relativePath = path.relative(vaultPath, filePath);
            const contentHash = md5(content);
            currentHashes[relativePath] = contentHash;

            // Skip unchanged files in incremental mode
            if (canIncremental && previousHashes[relativePath] === contentHash) {
              return null;
            }

            changedPaths.push(relativePath);
            const { mtime } = await fs.stat(filePath);
            const { data, content: body } = matter(content);
            const meta = extractNoteMeta(relativePath, data, body, mtime);
            return buildEmbeddingInputs(relativePath, body, chunkingOptionsFromEnv(), meta);
          } catch (err) {
            console.error(`Failed to process file ${filePath}:`, err);
            return null;
          }
        })
      );

      for (const result of results) {
        if (result) {
          for (let j = 0; j < result.textsToEmbed.length; j++) {
            allTexts.push(result.textsToEmbed[j]);
            allMeta.push(result.chunkMetadata[j]);
          }
        } else {
          skippedFiles++;
        }
      }

      filesRead += batch.length;
      renderReadProgress();
    }

    // Determine deleted files (in previous hashes but not in current file set)
    const deletedPaths = Object.keys(previousHashes).filter(p => !(p in currentHashes));

    if (canIncremental) {
      console.error(`Incremental: ${changedPaths.length} changed, ${deletedPaths.length} deleted, ${skippedFiles} unchanged`);
    } else {
      console.error(`Full index: ${allTexts.length} chunks from ${files.length} files`);
    }

    // Early exit: nothing changed
    if (canIncremental && allTexts.length === 0 && deletedPaths.length === 0) {
      console.error('Index is up to date, no changes detected.');
      // Indexes built before hybrid search have no full-text index yet.
      const table = await db.openTable('notes');
      if (!(await this.hasFtsIndex(table))) await this.ensureFtsIndex(table);
      await fs.writeFile(HASH_PATH, JSON.stringify(currentHashes));
      return { success: true, chunks: 0, message: 'Index up to date, no changes detected.' };
    }

    if (!canIncremental && allTexts.length === 0) {
      return { success: false, message: "No content found to index." };
    }

    // ── Phase 2: Update index ─────────────────────────────────────────

    let indexedChunks = 0;
    let tableInitialized = false;

    // For incremental mode: delete old chunks for changed/deleted files, keep existing table
    if (canIncremental) {
      this.table = await db.openTable('notes');
      const pathsToDelete = [...changedPaths, ...deletedPaths];
      if (pathsToDelete.length > 0) {
        const DELETE_BATCH = 100;
        for (let i = 0; i < pathsToDelete.length; i += DELETE_BATCH) {
          const batch = pathsToDelete.slice(i, i + DELETE_BATCH);
          const escaped = batch.map(p => `'${p.replace(/'/g, "''")}'`);
          await this.table.delete(`path IN (${escaped.join(', ')})`);
        }
      }
      tableInitialized = true;
    }

    // Embed new/changed chunks (or all chunks for full reindex)
    if (allTexts.length > 0) {
      // Sort chunks by text length to reduce ONNX padding waste
      const sortedIndices = allTexts.map((_, i) => i);
      sortedIndices.sort((a, b) => allTexts[a].length - allTexts[b].length);
      const sortedTexts = sortedIndices.map(i => allTexts[i]);
      const sortedMeta = sortedIndices.map(i => allMeta[i]);

      let chunksEmbedded = 0;

      const renderEmbedProgress = () => {
        const total = sortedTexts.length;
        if (total === 0) return;
        if (useProgressBar) {
          const percent = Math.min(100, Math.floor((chunksEmbedded / total) * 100));
          const width = 30;
          const filled = Math.round((percent / 100) * width);
          const bar = `${'='.repeat(filled)}${'-'.repeat(width - filled)}`;
          process.stderr.write(
            `\rEmbedding [${bar}] ${percent}% ${chunksEmbedded}/${total} chunks`
          );
          if (chunksEmbedded === total) process.stderr.write('\n');
          return;
        }
        if (chunksEmbedded % (batchSize * 5) === 0 || chunksEmbedded === total) {
          console.error(`Embedding progress: ${chunksEmbedded}/${total} chunks`);
        }
      };

      const persistChunks = async (chunks: NoteChunk[]) => {
        if (chunks.length === 0) return;
        const chunkRows = chunks as unknown as Record<string, unknown>[];

        if (!tableInitialized) {
          try {
            await db.dropTable('notes');
          } catch (e) { /* ignore if not exists */ }
          this.table = await db.createTable('notes', chunkRows);
          tableInitialized = true;
        } else {
          if (!this.table) {
            this.table = await db.openTable('notes');
          }
          await this.table.add(chunkRows);
        }

        indexedChunks += chunks.length;
      };

      // Accumulate ~5 embedding batches before writing to reduce per-write overhead
      const WRITE_ACCUMULATE = 5;
      let pendingChunks: NoteChunk[] = [];
      let batchesSinceWrite = 0;
      let pendingWrite: Promise<void> | null = null;

      for (let i = 0; i < sortedTexts.length; i += batchSize) {
        const batchTexts = sortedTexts.slice(i, i + batchSize);
        const batchMeta = sortedMeta.slice(i, i + batchSize);

        const embeddedChunks = await this.embedWithFallback(embedder, batchTexts, batchMeta);
        pendingChunks.push(...embeddedChunks);
        batchesSinceWrite++;
        chunksEmbedded += batchTexts.length;
        renderEmbedProgress();

        if (batchesSinceWrite >= WRITE_ACCUMULATE) {
          if (pendingWrite) await pendingWrite;
          const chunksToWrite = pendingChunks;
          pendingChunks = [];
          batchesSinceWrite = 0;
          pendingWrite = persistChunks(chunksToWrite);
        }
      }

      // Flush remaining chunks
      if (pendingWrite) await pendingWrite;
      if (pendingChunks.length > 0) {
        await persistChunks(pendingChunks);
      }
    }

    // Compact fragments and clean up old versions to prevent stale references
    if (this.table) {
      await this.table.optimize();
      if (!canIncremental || !(await this.hasFtsIndex(this.table))) await this.ensureFtsIndex(this.table);
    }

    // Save updated hashes
    await fs.writeFile(HASH_PATH, JSON.stringify(currentHashes));

    if (canIncremental) {
      console.error(`Incremental update: ${indexedChunks} chunks embedded, ${deletedPaths.length} files removed.`);
    } else {
      console.error(`Indexed ${indexedChunks} chunks.`);
    }
    return { success: true, chunks: indexedChunks };
  }

  /** Build (or rebuild) the full-text index on chunk text. */
  private async ensureFtsIndex(table: lancedb.Table) {
    await table.createIndex('text', { config: lancedb.Index.fts(), replace: true });
  }

  private async hasFtsIndex(table: lancedb.Table) {
    const indices = await table.listIndices();
    return indices.some(i => i.indexType === 'FTS' && i.columns.includes('text'));
  }

  public async search(query: string, opts: { limit?: number } & SearchFilters = {}) {
    const { limit = 5, ...filters } = opts;
    const where = buildWhereClause(filters);
    const table = await this.getTable();
    if (!table) {
        return [];
    }

    const embedder = Embedder.getInstance();
    const vector = await embedder.embed(query);

    // Over-fetch so there are still `limit` distinct notes after collapsing chunks of the same note.
    const fetchLimit = limit * 5;
    let vecQuery = table.vectorSearch(vector);
    if (where) vecQuery = vecQuery.where(where);
    const vec = await vecQuery.limit(fetchLimit).toArray();

    let fts: any[] = [];
    try {
      let ftsQuery = table.query().fullTextSearch(query);
      if (where) ftsQuery = ftsQuery.where(where);
      fts = await ftsQuery.limit(fetchLimit).toArray();
    } catch (err) {
      console.error('Full-text search failed; using vector results only:', err);
    }

    return dedupeByPath(rrfMerge([vec, fts]), limit);
  }

  /** Notes semantically closest to one indexed note, using the mean of its chunk vectors. */
  public async similarNotes(relativePath: string, limit: number) {
    const table = await this.getTable();
    if (!table) return [];

    const rows = await table.query().where(`path = '${relativePath.replace(/'/g, "''")}'`).toArray();
    if (rows.length === 0) return [];

    const vectors = rows.map((r: any) => Array.from(r.vector as ArrayLike<number>));
    const mean = vectors[0].map((_, i) => vectors.reduce((sum, v) => sum + v[i], 0) / vectors.length);
    const norm = Math.sqrt(mean.reduce((sum, x) => sum + x * x, 0));
    const query = norm > 0 ? mean.map(x => x / norm) : mean;

    // Over-fetch: the note's own chunks crowd the top hits and several chunks may share a note.
    const hits = await table.vectorSearch(query).limit((limit + rows.length) * 5).toArray();
    return dedupeByPath(hits.filter((h: any) => h.path !== relativePath), limit).map((h: any) => ({
      path: h.path as string,
      title: (h.title ?? '') as string,
      date: (h.date ?? '') as string,
      status: (h.status ?? '') as string,
      type: (h.type ?? '') as string,
    }));
  }
}
