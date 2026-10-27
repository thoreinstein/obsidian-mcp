import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { VaultIndexer } from './rag/store.js';
import matter from 'gray-matter';
import { grepVault } from './regex-worker.js';
import { noteOutline, scanHeadings, extractWikilinks, findSectionRange, replaceSection, insertAtHeading, listNotesPattern, compileSearch, findMatches, replaceInNote, applyFrontmatterUpdate, stripHeadingFromLink, formatResultMeta, resolveDailyNotePath, loadVaultSchema, buildLinkResolver, rewriteWikilinks, splitCode, validateFrontmatter, resolveVaultPath, FRONTMATTER_OPTIONS } from './utils.js';

export interface ToolContext {
  getVaultPath(override?: string): string;
  setVaultPath(p: string): Promise<void>;
  indexer: VaultIndexer;
  reindex(vaultPath: string, relativePath: string, removedPath?: string): void;
  allowForceReindex?: boolean;
}

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`Unknown tool: ${name}`);
    this.name = 'UnknownToolError';
  }
}

export const TOOL_DEFINITIONS: Array<{ name: string; description: string; inputSchema: object }> = [
  {
    name: 'obsidian_set_vault',
    description: 'Switch the default vault for this server session to one of the configured vaults. Does not persist.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a configured vault' },
      },
      required: ['path'],
    },
  },
  {
    name: 'obsidian_list_notes',
    description: 'List markdown files in the vault or a subdirectory, optionally filtered by frontmatter type and status.',
    inputSchema: {
      type: 'object',
      properties: {
        subfolder: { type: 'string', description: 'Optional subfolder to list' },
        type: { type: 'string', description: 'Only notes whose frontmatter type equals this' },
        status: { type: 'string', description: 'Only notes whose frontmatter status equals this' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
    },
  },
  {
    name: 'obsidian_read_note',
    description: 'Read the content of a specific note (Markdown). Optionally return only one section or only the frontmatter.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path to the note' },
        heading: { type: 'string', description: 'Return only this heading and its section body (first matching heading wins if the text repeats)' },
        frontmatter_only: { type: 'boolean', description: 'Return only the frontmatter as YAML (empty string if none)' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'obsidian_get_note_outline',
    description: 'Get a note outline: frontmatter, headings, wikilinks and word count. Heading line numbers are 1-based and relative to the body after the frontmatter.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path to the note' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'obsidian_create_note',
    description: 'Create a new note with the given content.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path for the new note (e.g. "Ideas/MyIdea.md")' },
        content: { type: 'string', description: 'Initial content of the note' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'obsidian_append_note',
    description: 'Append text to the end of an existing note.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path to the note' },
        content: { type: 'string', description: 'Text to append' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'obsidian_get_daily_note',
    description: 'Get (or create) today\'s daily note.',
    inputSchema: {
      type: 'object',
      properties: {
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
    },
  },
  {
    name: 'obsidian_search_notes',
    description: 'Grep the vault: returns path:line: text for each matching line (case-insensitive), plus filename matches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression (default false)' },
        folder: { type: 'string', description: 'Limit search to this vault subfolder' },
        limit: { type: 'number', description: 'Max matching lines to return (default 50)' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
      required: ['query'],
    },
  },
  {
    name: 'obsidian_rag_index',
    description: 'Index the vault for semantic search (RAG). If file_path is provided, only that file is re-indexed. Incremental by default — only re-embeds changed files.',
    inputSchema: {
      type: 'object',
      properties: {
        vault_path: { type: 'string', description: 'Optional vault path override' },
        file_path: { type: 'string', description: 'Relative path to a specific note to re-index' },
      },
    },
  },
  {
    name: 'obsidian_rag_query',
    description: 'Perform a semantic search on the indexed vault.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Question or query to ask your notes' },
        limit: { type: 'number', description: 'Number of notes to return (default 5)' },
        folder: { type: 'string', description: 'Only notes under this vault folder, e.g. "Engineering"' },
        type: { type: 'string', description: 'Only notes whose frontmatter type equals this' },
        status: { type: 'string', description: 'Only notes whose frontmatter status equals this' },
        after: { type: 'string', description: 'Only notes dated on or after this day (YYYY-MM-DD)' },
        max_distance: { type: 'number', description: 'Drop semantic hits whose vector distance exceeds this (lower is closer); keyword hits are kept. Unset keeps all.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'obsidian_get_backlinks',
    description: 'Find all notes that link to a specific note.',
    inputSchema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: 'Name of the note to find backlinks for (without extension)' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
      required: ['file_name'],
    },
  },
  {
    name: 'obsidian_get_related',
    description: 'Get links out, backlinks and semantically similar notes for a note in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path to the note' },
        limit: { type: 'number', description: 'Number of similar notes to return (default 5)' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'obsidian_get_links',
    description: 'Get all outgoing links from a specific note.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path to the note' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'obsidian_move_note',
    description: 'Move or rename a note and update wikilinks that point at it. Refuses an existing destination.',
    inputSchema: {
      type: 'object',
      properties: {
        source_path: { type: 'string', description: 'Current relative path of the note' },
        dest_path: { type: 'string', description: 'New relative path for the note (e.g. "Archive/OldNote.md")' },
        update_links: { type: 'boolean', description: 'Rewrite wikilinks that point at the note (default true). Read-only notes are left unchanged.' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
      required: ['source_path', 'dest_path'],
    },
  },
  {
    name: 'obsidian_update_frontmatter',
    description: 'Update YAML frontmatter of a note safely. Supports single key/value or batch updates.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path to the note' },
        key: { type: 'string', description: 'Frontmatter key to update (single-key mode)' },
        value: { type: 'string', description: 'New value for the key (JSON stringified if array/object; single-key mode)' },
        updates: { type: 'object', description: 'JSON object of key/value pairs to set at once (batch mode, alternative to key+value)' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'obsidian_append_daily_log',
    description: 'Append text to a specific heading in today\'s daily note.',
    inputSchema: {
      type: 'object',
      properties: {
        heading: { type: 'string', description: 'Heading to append under (e.g., "Work Log", "Ideas")' },
        content: { type: 'string', description: 'Text to append' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
      required: ['heading', 'content'],
    },
  },
  {
    name: 'obsidian_replace_section',
    description: 'Replace the body under a heading (up to the next heading of equal/higher level, or EOF). The heading line itself is preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path to the note' },
        heading: { type: 'string', description: 'Heading text to find (e.g. "Status")' },
        content: { type: 'string', description: 'New section body (replaces everything between heading and next same/higher-level heading)' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
      required: ['file_path', 'heading', 'content'],
    },
  },
  {
    name: 'obsidian_insert_at_heading',
    description: 'Insert content under a specific heading. If heading not found, appends it as a new ## section.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path to the note' },
        heading: { type: 'string', description: 'Heading text to find (e.g. "Notes")' },
        content: { type: 'string', description: 'Text to insert' },
        position: { type: 'string', enum: ['beginning', 'end'], description: 'Insert at beginning or end of section (default: end)' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
      required: ['file_path', 'heading', 'content'],
    },
  },
  {
    name: 'obsidian_replace_in_note',
    description: 'Replace the first occurrence of a specific text string in a note. Use for surgical inline edits, e.g. adding a wikilink to existing text.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Relative path to the note' },
        old_text: { type: 'string', description: 'Exact text to find and replace' },
        new_text: { type: 'string', description: 'Replacement text (default: empty string)' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
      required: ['file_path', 'old_text'],
    },
  },
  {
    name: 'obsidian_get_broken_links',
    description: 'Find all wikilinks in the vault (or a subfolder) that point to non-existent notes. Returns broken links grouped by source file.',
    inputSchema: {
      type: 'object',
      properties: {
        subfolder: { type: 'string', description: 'Limit scan to this subfolder (optional; default: entire vault)' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
    },
  },
  {
    name: 'obsidian_get_orphans',
    description: 'List notes that no other note links to. Use linked_from to count only links from one area, e.g. Engineering notes missing from every MOC.',
    inputSchema: {
      type: 'object',
      properties: {
        subfolder: { type: 'string', description: 'Only report notes in this subfolder' },
        linked_from: { type: 'string', description: 'Only count links from notes whose path starts with this prefix (e.g. "MOCs/")' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
    },
  },
];

// CLI args arrive as strings; MCP args are typed JSON. Accept both for booleans.
const isTrue = (v: unknown): boolean => v === true || v === 'true';

/** Relative paths of notes containing a wikilink to `target` (basename, no extension). */
async function findBacklinks(vp: string, target: string): Promise<string[]> {
  const linkRegex = new RegExp(`\\[\\[${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\]\\|#])`, 'i');
  const files = await glob('**/*.md', { cwd: vp });
  const backlinks: string[] = [];
  const batchSize = 50;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    await Promise.all(batch.map(async (f) => {
      try {
        const content = await fs.readFile(path.join(vp, f), 'utf-8');
        const prose = splitCode(content).filter(seg => !seg.code).map(seg => seg.text).join('\n');
        if (linkRegex.test(prose)) backlinks.push(f);
      } catch { }
    }));
  }
  return backlinks;
}

const isMarkdown = (rel: string) => rel.toLowerCase().endsWith('.md');

/** Throw before writing if the vault's schema file rejects this note's frontmatter. No schema means no validation. */
async function assertValidFrontmatter(vp: string, relPath: string, content: string): Promise<void> {
  if (!isMarkdown(relPath)) return;
  const schema = await loadVaultSchema(vp);
  if (!schema) return;
  const errors = validateFrontmatter(relPath, content, schema);
  if (errors.length > 0) throw new Error(`Frontmatter invalid for ${relPath}: ${errors.join('; ')}`);
}

/**
 * Write an edit to an existing note. Validates frontmatter only when the edit changed it, so body edits still work
 * on older notes whose frontmatter predates the schema.
 */
async function writeEdit(vp: string, relPath: string, filePath: string, before: string, after: string): Promise<void> {
  const fm = (text: string) => {
    try { return JSON.stringify(matter(text, FRONTMATTER_OPTIONS).data); } catch { return 'unparseable'; }
  };
  if (fm(before) !== fm(after)) await assertValidFrontmatter(vp, relPath, after);
  await fs.writeFile(filePath, after, 'utf-8');
}

/** Normalized, forward-slash vault-relative path of an absolute path inside the vault. */
export const vaultRel = (vp: string, abs: string) => path.relative(path.resolve(vp), abs).split(path.sep).join('/');

/**
 * True if `abs` falls under one of the `readonly` prefixes. Compares the real path (symlinks resolved through the
 * nearest existing ancestor) relative to the real vault root, case-insensitively, so `Engram/x.md`, `sub/../engram/x.md`
 * or a symlink into `engram/` can't slip past `engram/`.
 */
async function isReadonlyPath(vp: string, abs: string, readonly: string[]): Promise<boolean> {
  if (readonly.length === 0) return false;
  let existing = abs, rest = '';
  for (;;) {
    try { existing = await fs.realpath(existing); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(existing) === existing) throw e;
      rest = path.join(path.basename(existing), rest);
      existing = path.dirname(existing);
    }
  }
  const rel = vaultRel(await fs.realpath(vp), path.join(existing, rest)).toLowerCase();
  return readonly.some(p => rel.startsWith(p.toLowerCase()));
}

export const WRITABLE_EXTENSIONS = ['.md', '.base', '.canvas'];

/**
 * resolveVaultPath, then refuse the schema's `readonly` prefixes, hidden path segments (`.obsidian/`, `.git/`) and
 * non-note extensions. `rel` is the normalized vault-relative path: use it, not the raw input, for schema rules and reindexing.
 */
async function resolveWritablePath(vp: string, relPath: string): Promise<{ abs: string; rel: string }> {
  const abs = await resolveVaultPath(vp, relPath);
  const rel = vaultRel(vp, abs);
  if (await isReadonlyPath(vp, abs, (await loadVaultSchema(vp))?.readonly ?? [])) throw new Error(`Path is read-only: ${relPath}`);
  const checkName = (r: string) => {
    if (r.split('/').some(seg => seg.startsWith('.'))) throw new Error(`Hidden paths are not writable: ${relPath}`);
    if (!WRITABLE_EXTENSIONS.includes(path.extname(r).toLowerCase())) {
      throw new Error(`Not a writable note type: ${relPath} (allowed: ${WRITABLE_EXTENSIONS.join(', ')})`);
    }
  };
  checkName(rel);
  // An in-vault symlink must not smuggle a write into a hidden or non-note target.
  let realAbs: string | undefined;
  try { realAbs = await fs.realpath(abs); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (realAbs) checkName(vaultRel(await fs.realpath(vp), realAbs));
  return { abs, rel };
}

function validateArgs(name: string, args: Record<string, unknown>): void {
  const def = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!def) return;
  const bad = (reason: string): never => {
    throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for ${name}: ${reason}`);
  };
  const schema = def.inputSchema as {
    properties: Record<string, { type: string; enum?: string[] }>;
    required?: string[];
  };
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) bad(`missing required "${key}"`);
  }
  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    let ok: boolean;
    switch (prop.type) {
      case 'number':
        ok = (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
        break;
      case 'boolean':
        ok = typeof v === 'boolean' || v === 'true' || v === 'false';
        break;
      case 'object':
        ok = isPlainObject(v) || (typeof v === 'string' && (() => { try { return isPlainObject(JSON.parse(v)); } catch { return false; } })());
        break;
      default:
        ok = typeof v === prop.type;
    }
    if (!ok) bad(`"${key}" must be a ${prop.type}`);
    if (prop.enum && !prop.enum.includes(v as string)) bad(`"${key}" must be one of: ${prop.enum.join(', ')}`);
  }
  if (name === 'obsidian_update_frontmatter') {
    const has = (k: string) => args[k] !== undefined && args[k] !== null;
    if (!has('updates') && !(has('key') && has('value'))) bad('pass "updates" or both "key" and "value"');
  }
}

function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const clampLimit = (raw: unknown, fallback: number): number =>
  Math.min(Math.max(Math.floor(Number(raw)) || fallback, 1), 100);

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  validateArgs(name, args);
  const vaultArg = () => ctx.getVaultPath(args.vault_path as string | undefined);

  switch (name) {
    case 'obsidian_set_vault': {
      const p = String(args.path);
      await ctx.setVaultPath(p);
      return `Vault path set to: ${ctx.getVaultPath()}`;
    }
    case 'obsidian_list_notes': {
      const vp = vaultArg();
      if (args.subfolder) await resolveVaultPath(vp, String(args.subfolder));
      const pattern = listNotesPattern(args.subfolder ? String(args.subfolder) : undefined);
      let files = await glob(pattern, { cwd: vp });
      const want = { type: args.type, status: args.status };
      if (want.type || want.status) {
        const kept: string[] = [];
        for (const f of files) {
          const data = matter(await fs.readFile(path.join(vp, f), 'utf-8')).data;
          if ((!want.type || data.type === want.type) && (!want.status || data.status === want.status)) kept.push(f);
        }
        files = kept;
      }
      return JSON.stringify(files.slice(0, 100), null, 2) + (files.length > 100 ? `\n...and ${files.length - 100} more.` : '');
    }
    case 'obsidian_read_note': {
      const vp = vaultArg();
      const content = await fs.readFile(await resolveVaultPath(vp, String(args.file_path)), 'utf-8');
      if (args.frontmatter_only) {
        const data = matter(content, FRONTMATTER_OPTIONS).data;
        return Object.keys(data).length ? matter.stringify('', data, FRONTMATTER_OPTIONS) : '';
      }
      if (args.heading) {
        const heading = String(args.heading);
        const body = matter(content).content;
        const headings = scanHeadings(body);
        const idx = headings.findIndex(h => h.text === heading);
        if (idx === -1) throw new Error(`Heading "${heading}" not found. Headings: ${headings.map(h => h.text).join(', ')}`);
        const lines = body.split('\n');
        const next = headings.slice(idx + 1).find(h => h.level <= headings[idx].level);
        return lines.slice(headings[idx].line - 1, next ? next.line - 1 : undefined).join('\n');
      }
      return content;
    }
    case 'obsidian_get_note_outline': {
      const vp = vaultArg();
      const content = await fs.readFile(await resolveVaultPath(vp, String(args.file_path)), 'utf-8');
      return JSON.stringify(noteOutline(content), null, 2);
    }
    case 'obsidian_create_note': {
      const vp = vaultArg();
      const { abs: filePath, rel } = await resolveWritablePath(vp, String(args.file_path));
      const content = String(args.content || '');
      await assertValidFrontmatter(vp, rel, content);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      try {
        await fs.writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Note already exists: ${args.file_path}`);
        throw e;
      }
      if (isMarkdown(rel)) ctx.reindex(vp, rel);
      return `Created note: ${args.file_path}`;
    }
    case 'obsidian_append_note': {
      const vp = vaultArg();
      const { abs: filePath, rel } = await resolveWritablePath(vp, String(args.file_path));
      const content = String(args.content || '');
      let fileContent: string;
      try {
        fileContent = await fs.readFile(filePath, 'utf-8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Note not found: ${args.file_path}`);
        throw e;
      }
      await writeEdit(vp, rel, filePath, fileContent, fileContent + '\n' + content);
      if (isMarkdown(rel)) ctx.reindex(vp, rel);
      return `Appended to note: ${args.file_path}`;
    }
    case 'obsidian_get_daily_note': {
      const vp = vaultArg();
      const filePath = await resolveVaultPath(vp, await resolveDailyNotePath(vp, new Date()));
      const title = path.basename(filePath, '.md');
      try {
        return await fs.readFile(filePath, 'utf-8');
      } catch {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const content = `# ${title}\n\n`;
        await fs.writeFile(filePath, content, 'utf-8');
        return content;
      }
    }
    case 'obsidian_search_notes': {
      const vp = vaultArg();
      const re = compileSearch(String(args.query), isTrue(args.regex));
      const limit = clampLimit(args.limit, 50);
      const folder = args.folder ? String(args.folder) : undefined;
      if (folder) await resolveVaultPath(vp, folder);
      const files = (await glob(listNotesPattern(folder), { cwd: vp })).sort();
      if (isTrue(args.regex)) {
        const r = await grepVault(vp, files, String(args.query), re.flags, limit);
        if (r.extra) r.lines.push(`…truncated: ${r.extra} more matching lines in ${r.extraFiles} files`);
        return r.lines.join('\n');
      }
      const out: string[] = [];
      let shown = 0, extra = 0;
      const extraFiles = new Set<string>();
      for (const f of files) {
        if (re.test(path.basename(f))) {
          if (shown < limit) { out.push(`${f} (filename match)`); shown++; }
          else { extra++; extraFiles.add(f); }
        }
        let content: string;
        try { content = await fs.readFile(path.join(vp, f), 'utf-8'); } catch { continue; }
        for (const m of findMatches(content, re, {})) {
          if (shown < limit) { out.push(`${f}:${m.line}: ${m.text}`); shown++; }
          else { extra++; extraFiles.add(f); }
        }
      }
      if (extra) out.push(`…truncated: ${extra} more matching lines in ${extraFiles.size} files`);
      return out.join('\n');
    }
    case 'obsidian_rag_index': {
      const vp = vaultArg();
      const fp = args.file_path ? String(args.file_path) : null;
      const rel = fp ? vaultRel(vp, await resolveVaultPath(vp, fp)) : null;
      const force = isTrue(args.force_reindex) || isTrue(args.force);
      if (force && !ctx.allowForceReindex) {
        throw new McpError(ErrorCode.InvalidParams, 'force_reindex is CLI-only: run node dist/index.js obsidian_rag_index --force_reindex');
      }
      const result = rel ? await ctx.indexer.indexFile(vp, rel) : await ctx.indexer.indexVault(vp, force);
      return JSON.stringify(result);
    }
    case 'obsidian_rag_query': {
      const query = String(args.query);
      const limit = clampLimit(args.limit, 5);
      const opt = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v));
      // MCP sends max_distance; the CLI flag is --max-distance.
      const rawMax = args.max_distance ?? args['max-distance'];
      let maxDistance: number | undefined;
      if (rawMax !== undefined && rawMax !== null && rawMax !== '') {
        maxDistance = typeof rawMax === 'number' || typeof rawMax === 'string' ? Number(rawMax) : NaN;
        if (!Number.isFinite(maxDistance) || maxDistance <= 0) throw new Error('max_distance must be a positive number');
      }
      const results = await ctx.indexer.search(query, {
        limit,
        maxDistance,
        folder: opt(args.folder),
        type: opt(args.type),
        status: opt(args.status),
        after: opt(args.after),
      });
      return results.map((r: any) =>
        `---\nFile: ${r.path}\nMeta: ${formatResultMeta(r)}\n${r.heading ? `Section: ${r.heading}\n` : ''}Content: ${r.text}\n---`
      ).join('\n');
    }
    case 'obsidian_get_backlinks': {
      const vp = vaultArg();
      const target = String(args.file_name).replace(/\.md$/i, '');
      const backlinks = await findBacklinks(vp, target);
      if (backlinks.length === 0) return `No backlinks found for "[[${target}]]".`;
      return `Found ${backlinks.length} backlinks for "[[${target}]]":\n` + backlinks.map(f => `- ${f}`).join('\n');
    }
    case 'obsidian_get_related': {
      const vp = vaultArg();
      const filePath = String(args.file_path);
      const limit = clampLimit(args.limit, 5);
      const content = await fs.readFile(await resolveVaultPath(vp, filePath), 'utf-8');
      const resolveLink = buildLinkResolver(await glob('**/*', { cwd: vp, nodir: true }));
      const targets = [...new Set(extractWikilinks(content).map(stripHeadingFromLink).filter(Boolean))];
      const out = targets.map(t => `- [[${t}]] → ${resolveLink(t) ?? '(unresolved)'}`);
      const backlinks = await findBacklinks(vp, path.basename(filePath, '.md'));
      const similar = await ctx.indexer.similarNotes(filePath, limit);
      const list = (lines: string[]) => (lines.length ? lines.join('\n') : '(none)');
      return [
        '## Links out', list(out), '',
        '## Backlinks', list(backlinks.map(f => `- ${f}`)), '',
        '## Similar', list(similar.map(r => `- ${r.path} — ${formatResultMeta(r)}`)),
      ].join('\n');
    }
    case 'obsidian_get_links': {
      const vp = vaultArg();
      const content = await fs.readFile(await resolveVaultPath(vp, String(args.file_path)), 'utf-8');
      return JSON.stringify(extractWikilinks(content), null, 2);
    }
    case 'obsidian_move_note': {
      const vp = vaultArg();
      const { abs: source, rel: sourceRel } = await resolveWritablePath(vp, String(args.source_path));
      const { abs: dest, rel: destRel } = await resolveWritablePath(vp, String(args.dest_path));
      // fs.rename replaces an existing file. Same inode means a case-only rename on a case-insensitive filesystem.
      const destStat = await fs.stat(dest).catch(() => null);
      if (destStat && destStat.ino !== (await fs.stat(source)).ino) throw new Error(`Destination already exists: ${args.dest_path}`);
      const allFiles = await glob('**/*.md', { cwd: vp });
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(source, dest);
      if (isMarkdown(destRel)) ctx.reindex(vp, destRel, isMarkdown(sourceRel) ? sourceRel : undefined);
      const moved = `Moved ${args.source_path} to ${args.dest_path}`;
      if (args.update_links === false || args.update_links === 'false') return moved;

      const noExt = (abs: string) => vaultRel(vp, abs).replace(/\.md$/i, '');
      const from = { name: path.basename(source, '.md'), path: noExt(source) };
      const to = { name: path.basename(dest, '.md'), path: noExt(dest) };
      // A bare [[name]] only points at this note when no other note shares the name.
      const unique = allFiles.filter(f => path.basename(f, '.md').toLowerCase() === from.name.toLowerCase()).length === 1;
      const readonly = (await loadVaultSchema(vp))?.readonly ?? [];
      const updated: string[] = [], skipped: string[] = [];
      for (const f of await glob('**/*.md', { cwd: vp })) {
        const abs = path.join(vp, f);
        const content = await fs.readFile(abs, 'utf-8').catch(() => null);
        if (content === null) continue;
        const next = rewriteWikilinks(content, from, to, unique);
        if (next === content) continue;
        const rel = vaultRel(vp, abs);
        if (await isReadonlyPath(vp, abs, readonly)) { skipped.push(rel); continue; }
        await fs.writeFile(abs, next, 'utf-8');
        ctx.reindex(vp, rel);
        updated.push(rel);
      }
      const notes = (n: number, kind = '') => `${n} ${kind}${n === 1 ? 'note' : 'notes'}`;
      let out = `${moved}; updated links in ${notes(updated.length)}`;
      if (skipped.length) out += `; left links in ${notes(skipped.length, 'read-only ')} unchanged: ${skipped.join(', ')}`;
      return out;
    }
    case 'obsidian_update_frontmatter': {
      const vp = vaultArg();
      const { abs: filePath, rel } = await resolveWritablePath(vp, String(args.file_path));
      if (!isMarkdown(rel)) throw new Error(`Not a markdown note: ${args.file_path}`);
      const fileContent = await fs.readFile(filePath, 'utf-8');
      // CLI passes `updates` as a JSON string; MCP passes an object.
      const rawUpdates = typeof args.updates === 'string' ? JSON.parse(args.updates) : args.updates;
      const updateArg = (rawUpdates && typeof rawUpdates === 'object')
        ? { updates: rawUpdates as Record<string, unknown> }
        : { key: String(args.key), value: String(args.value) };
      const updated = applyFrontmatterUpdate(fileContent, updateArg);
      await assertValidFrontmatter(vp, rel, updated);
      await fs.writeFile(filePath, updated, 'utf-8');
      if (isMarkdown(rel)) ctx.reindex(vp, rel);
      return `Updated frontmatter in ${args.file_path}`;
    }
    case 'obsidian_replace_section': {
      const vp = vaultArg();
      const { abs: filePath, rel } = await resolveWritablePath(vp, String(args.file_path));
      if (!isMarkdown(rel)) throw new Error(`Not a markdown note: ${args.file_path}`);
      const heading = String(args.heading);
      const content = String(args.content);
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const range = findSectionRange(fileContent, heading);
      if (!range) throw new McpError(ErrorCode.InvalidParams, `Heading "${heading}" not found in ${args.file_path}`);
      await writeEdit(vp, rel, filePath, fileContent, replaceSection(fileContent, range, content));
      if (isMarkdown(rel)) ctx.reindex(vp, rel);
      return `Replaced section "${heading}" in ${args.file_path}`;
    }
    case 'obsidian_insert_at_heading': {
      const vp = vaultArg();
      const { abs: filePath, rel } = await resolveWritablePath(vp, String(args.file_path));
      if (!isMarkdown(rel)) throw new Error(`Not a markdown note: ${args.file_path}`);
      const heading = String(args.heading);
      const content = String(args.content);
      const position = (args.position || 'end') as 'beginning' | 'end';
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const range = findSectionRange(fileContent, heading);
      await writeEdit(vp, rel, filePath, fileContent, insertAtHeading(fileContent, heading, content, position, range));
      if (isMarkdown(rel)) ctx.reindex(vp, rel);
      return `Inserted content under "${heading}" in ${args.file_path}`;
    }
    case 'obsidian_append_daily_log': {
      const vp = vaultArg();
      const heading = String(args.heading);
      const content = String(args.content);
      const filePath = await resolveVaultPath(vp, await resolveDailyNotePath(vp, new Date()));
      const title = path.basename(filePath, '.md');
      let fileContent = '';
      try {
        fileContent = await fs.readFile(filePath, 'utf-8');
      } catch {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        fileContent = `# ${title}\n\n`;
      }
      const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const entry = `\n- [${timestamp}] ${content}`;
      const range = findSectionRange(fileContent, heading);
      if (range) {
        fileContent = fileContent.slice(0, range.headingEnd) + entry + fileContent.slice(range.headingEnd);
      } else {
        fileContent += `\n\n## ${heading}${entry}`;
      }
      await fs.writeFile(filePath, fileContent, 'utf-8');
      ctx.reindex(vp, path.relative(vp, filePath));
      return `Appended to daily note under "${heading}"`;
    }
    case 'obsidian_replace_in_note': {
      const vp = vaultArg();
      const { abs: filePath, rel } = await resolveWritablePath(vp, String(args.file_path));
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const updated = replaceInNote(fileContent, String(args.old_text), String(args.new_text ?? ''));
      await writeEdit(vp, rel, filePath, fileContent, updated);
      if (isMarkdown(rel)) ctx.reindex(vp, rel);
      return `Replaced text in ${args.file_path}`;
    }
    case 'obsidian_get_broken_links': {
      const vp = vaultArg();
      if (args.subfolder) await resolveVaultPath(vp, String(args.subfolder));
      const pattern = listNotesPattern(args.subfolder ? String(args.subfolder) : undefined);
      const files = await glob(pattern, { cwd: vp });
      const resolveLink = buildLinkResolver(await glob('**/*', { cwd: vp, nodir: true }));
      const targetMap = new Map<string, string[]>();
      for (const f of files) {
        const content = await fs.readFile(path.join(vp, f), 'utf-8').catch(() => '');
        for (const link of extractWikilinks(content)) {
          const target = stripHeadingFromLink(link);
          if (!target) continue;
          const arr = targetMap.get(target) ?? [];
          arr.push(f);
          targetMap.set(target, arr);
        }
      }
      const broken: Array<{ target: string; refs: string[] }> = [];
      for (const [target, refs] of targetMap) {
        if (!resolveLink(target)) broken.push({ target, refs });
      }
      if (broken.length === 0) return 'No broken links found.';
      const lines = broken.map(b => `[[${b.target}]] — in: ${b.refs.join(', ')}`).join('\n');
      return `Found ${broken.length} broken link(s):\n${lines}`;
    }
    case 'obsidian_get_orphans': {
      const vp = vaultArg();
      if (args.subfolder) await resolveVaultPath(vp, String(args.subfolder));
      const allFiles = await glob('**/*.md', { cwd: vp });
      const resolveLink = buildLinkResolver(allFiles);
      const linkedFrom = args.linked_from ? String(args.linked_from) : '';
      const linked = new Set<string>();
      for (const f of allFiles) {
        if (!f.startsWith(linkedFrom)) continue;
        const content = await fs.readFile(path.join(vp, f), 'utf-8').catch(() => '');
        for (const link of extractWikilinks(content)) {
          const target = resolveLink(stripHeadingFromLink(link));
          if (target && target !== f) linked.add(target);
        }
      }
      const candidates = await glob(listNotesPattern(args.subfolder ? String(args.subfolder) : undefined), { cwd: vp });
      const orphans = candidates.filter(f => !linked.has(f)).sort();
      if (orphans.length === 0) return 'No orphans found.';
      const shown = orphans.slice(0, 100).map(f => `- ${f}`).join('\n');
      return `Found ${orphans.length} orphan(s):\n${shown}` + (orphans.length > 100 ? `\n...and ${orphans.length - 100} more.` : '');
    }
    default:
      throw new UnknownToolError(name);
  }
}
