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

`obsidian_list_notes`, `obsidian_read_note`, `obsidian_search_notes`, `obsidian_rag_index`, `obsidian_rag_query`, `obsidian_set_vault`, `obsidian_create_note`, `obsidian_append_note`, `obsidian_get_daily_note`, `obsidian_get_backlinks`, `obsidian_get_links`, `obsidian_move_note`, `obsidian_update_frontmatter`, `obsidian_append_daily_log`, `obsidian_replace_section`, `obsidian_insert_at_heading`, `obsidian_replace_in_note`, `obsidian_get_broken_links`, `validate_frontmatter`

Each tool is also callable one-shot from the CLI: `node dist/index.js obsidian_rag_index`.

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

Vault path resolution order:

1. `obsidian_set_vault` tool / `vault_path` argument (persisted)
2. `OBSIDIAN_VAULT_PATH` env var
3. Config file (see below), with fallback to legacy `~/.gemini-obsidian.config.json` / `~/.obsidian-rag.config.json`

## Data paths

Canonical, shared by all clients:

- Config: `~/.config/obsidian-mcp/config.json`
- LanceDB index: `~/.config/obsidian-mcp/lancedb/`
- File-hash cache: `~/.config/obsidian-mcp/file-hashes.json`

Override the directory with `OBSIDIAN_MCP_DATA_DIR`, the config file with `OBSIDIAN_MCP_CONFIG`.

The index rebuilds incrementally from scratch on first use, so migrating from the old plugin locations needs no manual step.

## Development

```sh
npm run type-check && npm test && npm run build
```
