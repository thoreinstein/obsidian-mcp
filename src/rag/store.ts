import * as lancedb from '@lancedb/lancedb';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { glob } from 'glob';
import matter from 'gray-matter';
import md5 from 'md5';
import { Embedder, MODEL_SLUG } from './embedder.js';
import { buildEmbeddingInputs, ChunkingOptions, ChunkMetadata, extractNoteMeta } from './chunking.js';
import { withCommitRetry } from './retry.js';
import { planBatches } from './batching.js';
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
const DB_PATH = path.join(DATA_DIR, `lancedb${MODEL_SLUG}`);
const HASH_PATH = path.join(DATA_DIR, `file-hashes${MODEL_SLUG}.json`);
const META_PATH = path.join(DATA_DIR, `index-meta${MODEL_SLUG}.json`);

// LanceDB keeps 7 days of versions by default; every write adds one, so the
// index grows to many times its live size. Keep 1h so another client's
// in-flight reads of a recent version still find their files.
const VERSION_RETENTION_MS = 60 * 60 * 1000;

/** indexFile/removeFile compact and prune old versions once per this many writes. */
export const OPTIMIZE_EVERY_WRITES = 20;

function optimizeOptions() {
  return { cleanupOlderThan: new Date(Date.now() - VERSION_RETENTION_MS) };
}

interface NoteChunk extends ChunkMetadata {
  vector: number[];
}

export class VaultIndexer {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private writesSinceOptimize = 0;
  private ftsReady = false;

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
            await withCommitRetry(() => this.table!.add(data));
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

  /** The only code that writes the hash file. */
  private async writeHashes(hashes: Record<string, string>) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(HASH_PATH, JSON.stringify(hashes));
  }

  private async readHashes(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await fs.readFile(HASH_PATH, 'utf-8'));
    } catch {
      return {};
    }
  }

  /** An index belongs to one vault. A missing meta file is adopted by the first vault that indexes. */
  private async assertIndexVault(vaultPath: string) {
    const requested = await fs.realpath(vaultPath);
    let recorded: string | undefined;
    try {
      recorded = JSON.parse(await fs.readFile(META_PATH, 'utf-8')).vault;
    } catch { /* missing or unreadable: adopt */ }
    if (!recorded) {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(META_PATH, JSON.stringify({ vault: requested }));
      return;
    }
    if (recorded !== requested) {
      throw new Error(`Index belongs to vault ${recorded}; refusing to index ${requested}. Point OBSIDIAN_MCP_DATA_DIR at a separate directory to index another vault.`);
    }
  }

  public async indexFile(vaultPath: string, relativePath: string) {
    const embedder = Embedder.getInstance();
    const filePath = path.join(vaultPath, relativePath);

    try {
      await this.assertIndexVault(vaultPath);
      const content = await fs.readFile(filePath, 'utf-8');
      const { mtime } = await fs.stat(filePath);
      const { data, content: body } = matter(content);

      const meta = extractNoteMeta(relativePath, data, body, mtime);
      const { textsToEmbed, chunkMetadata } = buildEmbeddingInputs(relativePath, body, chunkingOptionsFromEnv(), meta);

      if (textsToEmbed.length === 0) {
          // Emptied note: its old chunks must leave the index. (An embedding failure below must not.)
          const table = await this.getTable();
          if (table) await withCommitRetry(() => table.delete(`path = '${relativePath.replace(/'/g, "''")}'`));
          await this.forgetHash(relativePath);
          await this.countWrite();
          return { success: true, chunks: 0, message: 'No content to index; removed existing chunks.' };
      }

      {
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
              const table = this.table = await db.openTable('notes');
              // Delete old chunks for this file
              await withCommitRetry(() => table.delete(`path = '${relativePath.replace(/'/g, "''")}'`));
              await withCommitRetry(() => table.add(chunkRows));
          }
          await this.countWrite();
          if (!this.ftsReady) {
              if (!(await this.hasFtsIndex(this.table))) await this.ensureFtsIndex(this.table);
              this.ftsReady = true;
          }
          await this.setHash(relativePath, md5(content));
          console.error(`Indexed ${chunks.length} chunks for ${relativePath}.`);
          return { success: true, chunks: chunks.length };
      }
    } catch (err) {
      console.error(`Failed to index file ${filePath}:`, err);
      return { success: false, message: String(err) };
    }
  }

  public async removeFile(relativePath: string) {
    const table = await this.getTable();
    if (!table) return;
    await withCommitRetry(() => table.delete(`path = '${relativePath.replace(/'/g, "''")}'`));
    await this.forgetHash(relativePath);
    await this.countWrite();
  }

  private async setHash(relativePath: string, hash: string) {
    await this.writeHashes({ ...(await this.readHashes()), [relativePath]: hash });
  }

  private async forgetHash(relativePath: string) {
    const hashes = await this.readHashes();
    if (!(relativePath in hashes)) return;
    delete hashes[relativePath];
    await this.writeHashes(hashes);
  }

  /** Compact and prune old versions every OPTIMIZE_EVERY_WRITES single-note writes, not on each one. */
  private async countWrite() {
    if (++this.writesSinceOptimize < OPTIMIZE_EVERY_WRITES) return;
    this.writesSinceOptimize = 0;
    const table = this.table ?? await this.getTable();
    if (table) await withCommitRetry(() => table.optimize(optimizeOptions()));
  }

  public async indexVault(vaultPath: string, force: boolean = false) {
    await this.assertIndexVault(vaultPath);
    const embedder = Embedder.getInstance();
    const db = await this.getDb();

    // Find all markdown files
    const files = await glob('**/*.md', { cwd: vaultPath, absolute: true });
    console.error(`Found ${files.length} notes in ${vaultPath}`);

    // Load previous file hashes for incremental indexing
    const previousHashes = force ? {} : await this.readHashes();

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
    const batchCharsRaw = Number(process.env.OBSIDIAN_RAG_EMBED_BATCH_CHARS ?? '12000');
    const batchChars = Number.isFinite(batchCharsRaw) && batchCharsRaw > 0 ? Math.floor(batchCharsRaw) : 12000;
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
      await this.writeHashes(currentHashes);
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
      // Drop hashes of changed paths first: a crash leaves them unhashed, so the next run redoes them.
      // Deleted paths stay hashed until their rows are gone, so a crash mid-delete is retried.
      const dropped = new Set(changedPaths);
      await this.writeHashes(Object.fromEntries(Object.entries(previousHashes).filter(([p]) => !dropped.has(p))));
      if (pathsToDelete.length > 0) {
        const DELETE_BATCH = 100;
        for (let i = 0; i < pathsToDelete.length; i += DELETE_BATCH) {
          const batch = pathsToDelete.slice(i, i + DELETE_BATCH);
          const escaped = batch.map(p => `'${p.replace(/'/g, "''")}'`);
          const table = this.table;
          await withCommitRetry(() => table.delete(`path IN (${escaped.join(', ')})`));
        }
      }
      tableInitialized = true;
    } else {
      // A crash mid-rebuild must not leave stale hashes that make the next run trust a partial table.
      await this.writeHashes({});
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
          this.ftsReady = false;
          try {
            await db.dropTable('notes');
          } catch (e) { /* ignore if not exists */ }
          this.table = await db.createTable('notes', chunkRows);
          tableInitialized = true;
        } else {
          if (!this.table) {
            this.table = await db.openTable('notes');
          }
          const table = this.table;
          await withCommitRetry(() => table.add(chunkRows));
        }

        indexedChunks += chunks.length;
      };

      // Accumulate ~5 embedding batches before writing to reduce per-write overhead
      const WRITE_ACCUMULATE = 5;
      let pendingChunks: NoteChunk[] = [];
      let batchesSinceWrite = 0;
      let pendingWrite: Promise<void> | null = null;

      for (const [start, end] of planBatches(sortedTexts.map(t => t.length), batchSize, batchChars)) {
        const batchTexts = sortedTexts.slice(start, end);
        const batchMeta = sortedMeta.slice(start, end);

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
      const table = this.table;
      await withCommitRetry(() => table.optimize(optimizeOptions()));
      this.writesSinceOptimize = 0;
      if (!canIncremental || !(await this.hasFtsIndex(this.table))) await this.ensureFtsIndex(this.table);
    }

    // Save updated hashes
    await this.writeHashes(currentHashes);

    if (canIncremental) {
      console.error(`Incremental update: ${indexedChunks} chunks embedded, ${deletedPaths.length} files removed.`);
    } else {
      console.error(`Indexed ${indexedChunks} chunks.`);
    }
    return { success: true, chunks: indexedChunks };
  }

  /** Build (or rebuild) the full-text index on chunk text. */
  private async ensureFtsIndex(table: lancedb.Table) {
    await withCommitRetry(() => table.createIndex('text', { config: lancedb.Index.fts(), replace: true }));
    this.ftsReady = true;
  }

  private async hasFtsIndex(table: lancedb.Table) {
    const indices = await table.listIndices();
    return indices.some(i => i.indexType === 'FTS' && i.columns.includes('text'));
  }

  /** `maxDistance` drops vector hits farther than this `_distance`; full-text hits are never dropped. */
  public async search(query: string, opts: { limit?: number; maxDistance?: number } & SearchFilters = {}) {
    const { limit = 5, maxDistance, ...filters } = opts;
    const where = buildWhereClause(filters);
    const table = await this.getTable();
    if (!table) {
        return [];
    }

    const embedder = Embedder.getInstance();
    const vector = await embedder.embed(query, 'query');

    // Over-fetch so there are still `limit` distinct notes after collapsing chunks of the same note.
    const fetchLimit = limit * 5;
    let vecQuery = table.vectorSearch(vector);
    if (where) vecQuery = vecQuery.where(where);
    let vec = await vecQuery.limit(fetchLimit).toArray();
    if (maxDistance !== undefined) vec = vec.filter((r: any) => r._distance <= maxDistance);

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
