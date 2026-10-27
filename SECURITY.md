# Security

## Trust model

obsidian-mcp runs as a stdio process for one local user, with that user's file permissions. There is no authentication, no network listener and no multi-user mode.

Vault content is untrusted input. Any note, including one synced or imported from elsewhere, can carry text that reaches an agent through the read and search tools and tries to steer it (prompt injection). The server's controls limit what such an agent can do with these tools; they do not stop it from using them.

## What the server enforces

- Vault allowlist: it only operates on vaults named in `OBSIDIAN_VAULT_PATHS`, `OBSIDIAN_VAULT_PATH` or the config file. A tool's `vault_path` and `obsidian_set_vault` must name one of them (matched by real path); `obsidian_set_vault` switches the default for the session only and never writes the config file.
- Write policy: write tools only create or edit `.md`, `.base` and `.canvas` files, refuse any path with a segment starting with `.` (such as `.obsidian/`), and refuse paths under the vault schema's `readonly` prefixes. Paths are normalized before the checks, and the target of a symlink is checked as well as the link. `obsidian_move_note` applies the same policy to every note whose links it rewrites and reports the ones it skipped. The daily note tools are exempt from `readonly` and from frontmatter validation.
- Atomic, stale-checked writes: a write goes to a temporary file and is renamed into place, keeping the note's mode. If the note changed since it was read, the write is refused instead of overwriting the change.
- Regex time budget: `obsidian_search_notes` with `regex: true` runs in a worker thread that is killed after 2 s.
- Argument validation: tool arguments are checked against each tool's schema, and `limit` is clamped to 1..100. Large outputs are capped (`read_note` `max_chars`, 100,000 by default; 200 backlinks; 200 broken links; 100 notes per `list_notes` call).
- `force_reindex` is CLI-only: the MCP tool rejects it, so an agent cannot trigger a full rebuild.
- Network: none, except the one-time download of the embedding model (about 23 MB) from Hugging Face into the model cache, at a pinned revision. Once the model is cached it loads without the network. With `OBSIDIAN_MCP_OFFLINE=1` the server never downloads and fails with an error if the cache is incomplete.
- Hooks: `validate_frontmatter --hook` and `obsidian_rag_index --hook` only act on `.md` notes inside the vault.

## What it does not protect against

- An agent with these tools can still rewrite, move or append to any allowed note. A prompt-injected agent can damage notes outside the `readonly` prefixes. Keep `readonly` for notes that must not change, and keep backups or version control of the vault.
- The write policy does not read note content. Text an agent writes into a note is stored as written.
- Review approvals for destructive tools. Keep auto-approve off for tools annotated `destructiveHint`.
- A process running as the same user can read and change the index, config and hash files directly.
- Installed as a dependency or globally, LanceDB's optional `@huggingface/transformers` 3 tree pulls `sharp` and `onnxruntime-node` versions with known advisories. This server never loads them. See the Install section of the [README](README.md).

## Reporting a vulnerability

Use a GitHub security advisory: open the repository's Security tab at https://github.com/thoreinstein/obsidian-mcp and choose "Report a vulnerability". Do not open a public issue for it.
