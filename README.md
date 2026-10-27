# obsidian-mcp

MCP server for Obsidian vault integration with local RAG (semantic search) — extracted from the former gemini-obsidian and obsidian-rag host plugins so any MCP client can share one server and one index.

## Features

- **Semantic Search (RAG)**: natural-language questions over your notes, indexed with LanceDB + local embeddings
- **Graph Traversal**: backlinks and outgoing wikilinks
- **Link Repair**: audit broken wikilinks, surgical in-note replacements
- **Journaling**: daily note fetch, timestamped append to headings
- **Management**: create/move/rename notes, YAML frontmatter updates (single or batch), section editing
- **Fuzzy Search**: find files by name or content

## Tools

`obsidian_list_notes`, `obsidian_read_note`, `obsidian_search_notes`, `obsidian_rag_index`, `obsidian_rag_query`, `obsidian_set_vault`, `obsidian_create_note`, `obsidian_append_note`, `obsidian_get_daily_note`, `obsidian_get_backlinks`, `obsidian_get_links`, `obsidian_move_note`, `obsidian_update_frontmatter`, `obsidian_append_daily_log`, `obsidian_replace_section`, `obsidian_insert_at_heading`, `obsidian_replace_in_note`, `obsidian_get_broken_links`, `obsidian_get_orphans`, `obsidian_get_note_outline`, `obsidian_get_related`

Each tool is also callable one-shot from the CLI: `node dist/index.js obsidian_rag_index`. CLI-only, not MCP tools: `validate_frontmatter --hook`, `obsidian_rag_index --hook`, `obsidian_rag_index --force_reindex`, `obsidian_rag_eval --file <queries.json>` (scores retrieval against a set of queries). A CLI call exits 0 with the result on stdout, or 1 with the error message on stderr.

Notable parameters:

- `obsidian_rag_query`: `folder`, `type`, `status`, `after` filter results; each hit is labelled with folder, date, status and type
- `obsidian_list_notes`: `type` and `status` filter by frontmatter; results are sorted and 100 are returned per call, `offset` (default 0) pages through them
- `obsidian_read_note`: `heading` returns one section, `frontmatter_only` returns just the YAML
- `obsidian_read_note`: `max_chars` (default 100000, `0` = no cap) truncates a full-note or `heading` result with a marker naming the total
- `obsidian_get_backlinks`: `file_path` resolves that exact note (path-style and bare links); `file_name` matches by bare name; lists at most 200 notes, then `...and <n> more.`
- A bare-name link (`[[name]]`, no `/`) with several candidate notes resolves to the one in the linking note's folder, else the one with the fewest path segments, else the alphabetically first path. `[[folder/name]]` links match the exact path, case-insensitively
- Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so clients can tell read-only from destructive tools
- `obsidian_search_notes`: `regex`, `folder`, `limit` (filename and content hits both count toward the limit)
- `obsidian_get_note_outline`: frontmatter, headings, wikilinks and word count
- `obsidian_get_related`: outgoing links, backlinks and semantically similar notes
- `obsidian_get_orphans`: notes nothing links to; `subfolder` limits the notes reported, `linked_from` counts only links from one prefix (e.g. `MOCs/`)
- `obsidian_move_note`: rewrites wikilinks that point at the moved note unless `update_links` is false; refuses an existing destination
- `limit` on `obsidian_search_notes`, `obsidian_rag_query` and `obsidian_get_related` is clamped to 1..100
- `obsidian_search_notes` with `regex: true` has a 2 s time budget and errors `Regex search timed out after 2000 ms`
- `obsidian_rag_index`: `force_reindex` is CLI-only (`node dist/index.js obsidian_rag_index --force_reindex`); the MCP tool rejects it
- `obsidian_rag_query`: `max_distance` (CLI `--max-distance`) drops semantic hits with vector distance above n; keyword hits are kept; no default
- Tool arguments are validated against each tool's schema; `obsidian_update_frontmatter` single-key `value` must be a string (JSON-stringify arrays and objects, or use `updates`)

## Install

```sh
git clone https://github.com/thoreinstein/obsidian-mcp
cd obsidian-mcp && npm install
```

`npm install` builds `dist/` through the `prepare` script. Requires Node >= 22. On Linux x64, set `ONNXRUNTIME_NODE_INSTALL=skip` before `npm install`: `onnxruntime-node` 1.30 otherwise downloads a 236 MB CUDA package this server never uses.

The build bundles everything except the native packages `@lancedb/lancedb` and `onnxruntime-node`, which stay external and are the only `dependencies` installed by `npm install`. `onnxruntime-node` is pinned to the exact version `@huggingface/transformers` requires. The bundled packages, `@huggingface/transformers` among them, live in `devDependencies` because they are compiled into `dist/index.js`. Image pipelines are unused, so the build replaces `sharp` with an empty stub and never loads it. The `overrides` in this repo's `package.json` apply only when this repo is the installing root. Installed as a dependency or globally, LanceDB's optional `@huggingface/transformers` 3.0.2 still pulls `sharp` 0.33.5 (which has security advisories) and `onnxruntime-node` 1.19.2; this server never loads either. To dedupe in your own project, add `"overrides": { "@huggingface/transformers": "4.3.1" }` to its `package.json`.

## Configure

Point an MCP client at it:

```json
{
  "mcpServers": {
    "obsidian-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/obsidian-mcp/dist/index.js"]
    }
  }
}
```

Allowed vaults: the server only operates on vaults it is configured with. Roots come from, in order:

1. `OBSIDIAN_VAULT_PATHS` env var (several absolute paths, separated by the platform path delimiter, `:` on macOS/Linux)
2. `OBSIDIAN_VAULT_PATH` env var
3. `vault_paths` (array) in the config file (see below)
4. `vault_path` in the config file

Relative entries are ignored. The default vault is the first root that exists. A `vault_path` argument on a tool, and `obsidian_set_vault`, must name one of these roots (matched by real path, so symlinks and trailing slashes are fine); anything else is rejected with `Vault not allowed`. `obsidian_set_vault` only switches the default for the current session and never writes the config file.

The RAG index belongs to one vault: the first vault that indexes it. Indexing another vault fails with `Index belongs to vault ...`. To index a second vault, point `OBSIDIAN_MCP_DATA_DIR` at a separate directory.

## Vault files

The server reads these optional files from the vault; nothing vault-specific is hard-coded.

- Write tools only create or edit `.md`, `.base` and `.canvas` files and refuse any path with a segment starting with `.` (e.g. `.obsidian/`)
- Dot-directories (`.obsidian/`, `.git/`, `.trash/`) are never indexed, searched, listed or link-checked by vault-wide scans, unless a dot-directory is named explicitly as `subfolder`/`folder`
- The daily note tools (`obsidian_get_daily_note`, `obsidian_append_daily_log`) are exempt from `readonly` and from frontmatter validation
- `.obsidian/daily-notes.json`: `folder` and `format` decide where the daily note lives
- `AGENTS.md`: appended to the server instructions (truncated if long) and served in full as the `obsidian://vault-guide` resource
- `.obsidian-mcp-schema.json`: frontmatter rules enforced on create and frontmatter update, and by the `validate_frontmatter --hook` CLI hook (see [Claude Code hooks](#claude-code-hooks)):

```json
{
  "exclude": ["engram/"],
  "readonly": ["engram/", ".manifest.json"],
  "rules": [
    { "prefix": "Engineering/", "required": ["type"], "allowed": { "type": ["plan", "pattern"] } }
  ]
}
```

`exclude` lists path prefixes skipped by validation. `readonly` lists path prefixes no write tool may change, create, or move notes into or out of; the daily note tools are exempt (above). The first rule whose `prefix` matches the path applies (`""` matches all), with `required` fields and `allowed` values per field.

## Claude Code hooks

Two CLI modes read a Claude Code hook payload (JSON with `tool_input.file_path`, and `content` for a Write) on stdin. Both resolve `file_path` (absolute or vault-relative) against the vault and ignore anything that is not a `.md` note inside it.

- `validate_frontmatter --hook`: checks the written `content` against `.obsidian-mcp-schema.json`. Exit 2 with `[obsidian-mcp] Blocked: "<path>" has invalid frontmatter: ...` on stderr when it breaks a rule, which makes Claude Code block the write. Exit 0 for everything else: valid content, no schema or an unreadable one, empty or invalid stdin, no `content` (an Edit carries none, so only Writes are checked), a path outside the vault. Paths under the schema's `exclude` prefixes pass.
- `obsidian_rag_index --hook`: reindexes the one note named by `file_path`. Exit 0 on success and on every no-op (empty or invalid stdin, no `file_path`, no vault, a non-note path). When indexing is refused or fails it prints `{"success":false,"message":...}` on stdout and still exits 0, so the hook never blocks or reports an error to Claude Code; see stderr or `OBSIDIAN_MCP_LOG=debug` for why.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "node /path/to/obsidian-mcp/dist/index.js validate_frontmatter --hook" }] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit|MultiEdit", "hooks": [{ "type": "command", "command": "node /path/to/obsidian-mcp/dist/index.js obsidian_rag_index --hook" }] }
    ]
  }
}
```

The vault comes from `tool_input.vault_path` if present (the `obsidian_rag_index` hook also honors `--vault_path`), else the configured default vault.

## Data paths

Canonical, shared by all clients:

- Config: `~/.config/obsidian-mcp/config.json`
- LanceDB index: `~/.config/obsidian-mcp/lancedb/`
- File-hash cache: `~/.config/obsidian-mcp/file-hashes.json`
- Index owner: `~/.config/obsidian-mcp/index-meta.json` (the vault the index belongs to and the embedder that built it)
- Embedding model cache: `~/.cache/obsidian-mcp/models/` (`$XDG_CACHE_HOME/obsidian-mcp/models/` when `XDG_CACHE_HOME` is set; override with `OBSIDIAN_MCP_MODEL_DIR`)

Override the directory with `OBSIDIAN_MCP_DATA_DIR`, the config file with `OBSIDIAN_MCP_CONFIG`.

The LanceDB directory keeps an hour of table versions (older ones are cleaned up on optimize), so it is larger on disk than the live data.

The embedding model defaults to `Xenova/all-MiniLM-L6-v2`, pinned to revision `751bff37182d3f1213fa05d7196b954e230abad9` and loaded as `q8`; set `OBSIDIAN_RAG_MODEL` to use another. Other models use revision `main` unless `OBSIDIAN_RAG_MODEL_REVISION` is set. Non-default models get their own index (`lancedb-<model>/`, `file-hashes-<model>.json`, with `/` in the model name replaced by `__`), so switching models never mixes embeddings. Reindex after switching.

The model downloads once (about 23 MB) into the model cache on first use. Once the cache holds the model, it loads from there without the network. Set `OBSIDIAN_MCP_OFFLINE=1` to forbid the first download too: with an incomplete cache, loading then fails with an error naming the cache directory.

The index meta records the embedder that built it (`transformers@4/<model>@<revision>/q8`). An index built by another embedder, including every index built before the move to `@huggingface/transformers` 4, is rebuilt in full by the next `obsidian_rag_index` (the server's startup index does this). The first start after upgrading from an older embedder therefore runs a full rebuild: about 5 minutes at full CPU for a 3,000-note vault on an Apple M-series machine. Until it finishes, queries log a warning and search returns partial results, and single-note reindexing is refused. `node dist/index.js obsidian_rag_index --force_reindex` runs the rebuild on demand (the MCP tool rejects `force_reindex`).

Embedding batches hold at most `OBSIDIAN_RAG_EMBED_BATCH_SIZE` chunks (default 48) and `OBSIDIAN_RAG_EMBED_BATCH_CHARS` characters (default 6000); the character cap bounds peak memory on long chunks.

The index rebuilds incrementally from scratch on first use, so migrating from the old plugin locations needs no manual step.

The MCP server runs an incremental index in the background when it starts, so notes edited outside the server (in Obsidian, by exporters, by hand) are picked up on every client restart. Writes through the server's own tools reindex the note immediately.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `OBSIDIAN_VAULT_PATHS` | unset | Allowed vault roots, absolute, separated by the platform path delimiter |
| `OBSIDIAN_VAULT_PATH` | unset | One allowed vault root |
| `OBSIDIAN_MCP_CONFIG` | `~/.config/obsidian-mcp/config.json` | Config file |
| `OBSIDIAN_MCP_DATA_DIR` | `~/.config/obsidian-mcp` | Index, file hashes and index meta |
| `OBSIDIAN_MCP_MODEL_DIR` | `$XDG_CACHE_HOME/obsidian-mcp/models` | Embedding model cache |
| `XDG_CACHE_HOME` | `~/.cache` | Base of the default model cache |
| `OBSIDIAN_MCP_OFFLINE` | unset | `1` forbids model downloads |
| `OBSIDIAN_MCP_LOG` | unset | `debug` enables debug logs on stderr |
| `OBSIDIAN_RAG_MODEL` | `Xenova/all-MiniLM-L6-v2` | Embedding model |
| `OBSIDIAN_RAG_MODEL_REVISION` | pinned revision for the default model, else `main` | Model revision |
| `OBSIDIAN_RAG_MIN_CHUNK_CHARS` | 40 | Smallest chunk kept |
| `OBSIDIAN_RAG_TARGET_CHUNK_CHARS` | 700 | Chunk size aimed for (must exceed the minimum) |
| `OBSIDIAN_RAG_MAX_CHUNK_CHARS` | 1800 | Largest chunk |
| `OBSIDIAN_RAG_EMBED_BATCH_SIZE` | 48 | Chunks per embedding batch (max 256) |
| `OBSIDIAN_RAG_EMBED_BATCH_CHARS` | 6000 | Characters per embedding batch |
| `ONNXRUNTIME_NODE_INSTALL` | unset | Install time only, read by `onnxruntime-node`: `skip` avoids its CUDA download (see Install) |

Invalid or non-positive numeric values fall back to the default.

## Development

```sh
npm run type-check && npm test && npm run build
```

Tests need the network once, to download the embedding model. Set `OBSIDIAN_MCP_OFFLINE=1` to skip the two tests that need it.

See [SECURITY.md](SECURITY.md) for the trust model and [CHANGELOG.md](CHANGELOG.md) for changes.
