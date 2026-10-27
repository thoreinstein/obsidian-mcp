# Changelog

## Unreleased

### Breaking

- Requires Node >= 22.
- `obsidian_set_vault` no longer persists anything: it only switches among the configured vaults for the current session. Vaults come from `OBSIDIAN_VAULT_PATHS`, `OBSIDIAN_VAULT_PATH` or the config file; any other `vault_path` is rejected with `Vault not allowed`.
- Write tools refuse non-note files (only `.md`, `.base`, `.canvas`) and any path with a dot-segment such as `.obsidian/`.
- `force_reindex` is CLI-only (`node dist/index.js obsidian_rag_index --force_reindex`); the MCP tool rejects it.
- `obsidian_update_frontmatter` single-key `value` must be a string; use `updates` for arrays and objects.
- `obsidian_get_note_outline` returns frontmatter dates as written instead of as timestamps.
- `obsidian_read_note` caps output at 100,000 characters by default (`max_chars`, `0` = no cap).
- The first run after upgrading rebuilds the index, because the embedder changed (about 5 minutes for 3,000 notes on an Apple M-series machine).

### Security

- Vault roots are an allowlist; callers can no longer name arbitrary directories.
- Write tools are limited to note files and refuse dot-paths; symlink targets are checked; paths are normalized before policy checks and indexing.
- Regex search runs in a worker with a 2 s budget.
- Tool arguments are validated against their schemas; `limit` is clamped to 1..100.
- Hook file paths are resolved against the vault; non-notes exit 0 instead of being processed.
- Index errors no longer include absolute paths.

### Fixed

- Docs: `validate_frontmatter` was never an MCP tool (the README mis-listed it); it is the CLI hook `validate_frontmatter --hook`.
- Writes are atomic (temp file and rename), refuse stale edits, write through symlinks and keep the note's mode; `obsidian_move_note` applies the write policy to notes it rewrites and reports ones it skipped.
- Daily notes are created exclusively, so a note Obsidian creates at the same moment is kept.
- The index is crash-safe and bound to one vault; emptied or deleted notes leave the index; LanceDB commit conflicts are retried.
- Embedding batches are capped at 6,000 characters, which bounds peak memory on long chunks (rebuild peak 4.9 GB to 1.48 GB).
- Chunk text keeps line breaks; embedding input is unchanged.
- `obsidian_get_backlinks` resolves `file_path` to the exact note.
- Bare-name links with several candidates resolve deterministically: same folder as the linking note, then fewest path segments, then alphabetical.
- Silent failures now surface: daily-note creation, short embedding batches, stdin read before EOF, index errors.
- Background index refusals are logged.
- Frontmatter and section tools only accept markdown notes.
- `obsidian_insert_at_heading` says when it creates the heading.
- Server identity and tool descriptions corrected; `OBSIDIAN_MCP_LOG=debug` gates noisy logs.

### Changed

- Embeddings use `@huggingface/transformers` 4 with a pinned model revision and a shared cache at `~/.cache/obsidian-mcp/models`; a cached model loads without the network.
- The index meta records the embedder; an index built by another embedder is rebuilt.
- `obsidian_list_notes` results are sorted; `obsidian_get_backlinks` lists at most 200 notes; `obsidian_get_broken_links` lists at most 200.
- Dependencies upgraded: ONNX Runtime 1.30, LanceDB 0.40, vitest 5, js-yaml 4, MCP SDK 1.32. `sharp` is stubbed out of the bundle.
- Packaging: `files` list, repository metadata, CI on Node 22 and 24 (Linux and macOS).
- CLI and hook handling moved into a testable `runCli`; exit codes unchanged.

### Added

- `obsidian_list_notes` `offset`.
- `obsidian_rag_query` `max_distance`.
- `obsidian_read_note` `max_chars`.
- Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
- `obsidian_get_backlinks` accepts `file_path`.
- `OBSIDIAN_MCP_OFFLINE`, `OBSIDIAN_MCP_MODEL_DIR`, `OBSIDIAN_MCP_LOG`, `OBSIDIAN_RAG_MODEL_REVISION`, `OBSIDIAN_RAG_EMBED_BATCH_CHARS`.
- `SECURITY.md`; README sections for hooks and environment variables.

### Performance

- Vault scans read notes concurrently and skip files that cannot link to the target: search 270 to 105 ms, backlinks 150 to 80 ms, broken links 330 to 100 ms, orphans 340 to 103 ms on a 3,200-note vault.
- Hashing uses Node crypto instead of the `md5` package; startup index 1.0 s to 0.35 s.
- `gray-matter` no longer caches every parsed note.
- LanceDB is optimized every 20 single-note writes instead of on each write.
- Full rebuild with ONNX Runtime 1.30 took 297 s instead of 647 s; retrieval quality is unchanged (recall@5 0.850, MRR 0.767).
