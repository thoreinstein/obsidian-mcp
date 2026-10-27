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

`obsidian_list_notes`, `obsidian_read_note`, `obsidian_search_notes`, `obsidian_rag_index`, `obsidian_rag_query`, `obsidian_set_vault`, `obsidian_create_note`, `obsidian_append_note`, `obsidian_get_daily_note`, `obsidian_get_backlinks`, `obsidian_get_links`, `obsidian_move_note`, `obsidian_update_frontmatter`, `obsidian_append_daily_log`, `obsidian_replace_section`, `obsidian_insert_at_heading`, `obsidian_replace_in_note`, `obsidian_get_broken_links`, `obsidian_get_orphans`, `obsidian_get_note_outline`, `obsidian_get_related`, `validate_frontmatter`

Each tool is also callable one-shot from the CLI: `node dist/index.js obsidian_rag_index`. `obsidian_rag_eval --file <queries.json>` is CLI-only and scores retrieval against a set of queries.

Notable parameters:

- `obsidian_rag_query`: `folder`, `type`, `status`, `after` filter results; each hit is labelled with folder, date, status and type
- `obsidian_list_notes`: `type` and `status` filter by frontmatter
- `obsidian_read_note`: `heading` returns one section, `frontmatter_only` returns just the YAML
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
cd obsidian-mcp && npm install && npm run build
```

Native deps (`@lancedb/lancedb`, `onnxruntime-node`, `sharp`) must be built locally — run `npm install` in the repo.

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
- `.obsidian/daily-notes.json`: `folder` and `format` decide where the daily note lives
- `AGENTS.md`: appended to the server instructions (truncated if long) and served in full as the `obsidian://vault-guide` resource
- `.obsidian-mcp-schema.json`: frontmatter rules enforced on create and frontmatter update, and by `validate_frontmatter`:

```json
{
  "exclude": ["engram/"],
  "readonly": ["engram/", ".manifest.json"],
  "rules": [
    { "prefix": "Engineering/", "required": ["type"], "allowed": { "type": ["plan", "pattern"] } }
  ]
}
```

`exclude` lists path prefixes skipped by validation. `readonly` lists path prefixes no write tool may change, create, or move notes into or out of; the daily note tools are exempt. The first rule whose `prefix` matches the path applies (`""` matches all), with `required` fields and `allowed` values per field.

## Data paths

Canonical, shared by all clients:

- Config: `~/.config/obsidian-mcp/config.json`
- LanceDB index: `~/.config/obsidian-mcp/lancedb/`
- File-hash cache: `~/.config/obsidian-mcp/file-hashes.json`
- Index owner: `~/.config/obsidian-mcp/index-meta.json` (the vault the index belongs to)

Override the directory with `OBSIDIAN_MCP_DATA_DIR`, the config file with `OBSIDIAN_MCP_CONFIG`.

The embedding model defaults to `Xenova/all-MiniLM-L6-v2`; set `OBSIDIAN_RAG_MODEL` to use another. Non-default models get their own index (`lancedb-<model>/`, `file-hashes-<model>.json`, with `/` in the model name replaced by `__`), so switching models never mixes embeddings. Reindex after switching.

Embedding batches hold at most `OBSIDIAN_RAG_EMBED_BATCH_SIZE` chunks (default 48) and `OBSIDIAN_RAG_EMBED_BATCH_CHARS` characters (default 6000); the character cap bounds peak memory on long chunks.

The index rebuilds incrementally from scratch on first use, so migrating from the old plugin locations needs no manual step.

The MCP server runs an incremental index in the background when it starts, so notes edited outside the server (in Obsidian, by exporters, by hand) are picked up on every client restart. Writes through the server's own tools reindex the note immediately.

## Development

```sh
npm run type-check && npm test && npm run build
```
