import * as fs from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { VaultIndexer } from './rag/store.js';
import { extractWikilinks, findSectionRange, replaceSection, insertAtHeading, listNotesPattern, replaceInNote, applyFrontmatterUpdate, stripHeadingFromLink, formatResultMeta, resolveDailyNotePath } from './utils.js';

export interface ToolContext {
  getVaultPath(override?: string): string;
  setVaultPath(p: string): Promise<void>;
  indexer: VaultIndexer;
  reindex(vaultPath: string, relativePath: string, removedPath?: string): void;
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
    description: 'Set the default Obsidian vault path for this session.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the Obsidian vault' },
      },
      required: ['path'],
    },
  },
  {
    name: 'obsidian_list_notes',
    description: 'List markdown files in the vault or a subdirectory.',
    inputSchema: {
      type: 'object',
      properties: {
        subfolder: { type: 'string', description: 'Optional subfolder to list' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
    },
  },
  {
    name: 'obsidian_read_note',
    description: 'Read the content of a specific note (Markdown).',
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
    description: 'Search for notes containing specific text (simple text match).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for' },
        vault_path: { type: 'string', description: 'Optional vault path override' },
      },
      required: ['query'],
    },
  },
  {
    name: 'obsidian_rag_index',
    description: 'Index the vault for semantic search (RAG). If file_path is provided, only that file is re-indexed. Incremental by default — only re-embeds changed files. Use force_reindex to rebuild from scratch.',
    inputSchema: {
      type: 'object',
      properties: {
        vault_path: { type: 'string', description: 'Optional vault path override' },
        file_path: { type: 'string', description: 'Relative path to a specific note to re-index' },
        force_reindex: { type: 'boolean', description: 'Force full re-index, ignoring cached file hashes (default: false)' },
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
    description: 'Move or rename a note.',
    inputSchema: {
      type: 'object',
      properties: {
        source_path: { type: 'string', description: 'Current relative path of the note' },
        dest_path: { type: 'string', description: 'New relative path for the note (e.g. "Archive/OldNote.md")' },
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
];

// CLI args arrive as strings; MCP args are typed JSON. Accept both for booleans.
const isTrue = (v: unknown): boolean => v === true || v === 'true';

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const vaultArg = () => ctx.getVaultPath(args.vault_path as string | undefined);

  switch (name) {
    case 'obsidian_set_vault': {
      const p = String(args.path);
      await ctx.setVaultPath(p);
      return `Vault path set to: ${p}`;
    }
    case 'obsidian_list_notes': {
      const vp = vaultArg();
      const pattern = listNotesPattern(args.subfolder ? String(args.subfolder) : undefined);
      const files = await glob(pattern, { cwd: vp });
      return JSON.stringify(files.slice(0, 100), null, 2) + (files.length > 100 ? `\n...and ${files.length - 100} more.` : '');
    }
    case 'obsidian_read_note': {
      const vp = vaultArg();
      return await fs.readFile(path.join(vp, String(args.file_path)), 'utf-8');
    }
    case 'obsidian_create_note': {
      const vp = vaultArg();
      const filePath = path.join(vp, String(args.file_path));
      const content = String(args.content || '');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
      ctx.reindex(vp, String(args.file_path));
      return `Created note: ${args.file_path}`;
    }
    case 'obsidian_append_note': {
      const vp = vaultArg();
      const filePath = path.join(vp, String(args.file_path));
      const content = String(args.content || '');
      await fs.appendFile(filePath, '\n' + content, 'utf-8');
      ctx.reindex(vp, String(args.file_path));
      return `Appended to note: ${args.file_path}`;
    }
    case 'obsidian_get_daily_note': {
      const vp = vaultArg();
      const filePath = path.join(vp, await resolveDailyNotePath(vp, new Date()));
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
      const query = String(args.query).toLowerCase();
      const files = await glob('**/*.md', { cwd: vp });
      const matches: string[] = [];
      for (const f of files) {
        if (f.toLowerCase().includes(query)) {
          matches.push(f + ' (Filename match)'); continue;
        }
        try {
          const content = await fs.readFile(path.join(vp, f), 'utf-8');
          if (content.toLowerCase().includes(query)) matches.push(f);
        } catch { }
        if (matches.length >= 20) break;
      }
      return matches.join('\n');
    }
    case 'obsidian_rag_index': {
      const vp = vaultArg();
      const fp = args.file_path ? String(args.file_path) : null;
      const force = isTrue(args.force_reindex) || isTrue(args.force);
      const result = fp ? await ctx.indexer.indexFile(vp, fp) : await ctx.indexer.indexVault(vp, force);
      return JSON.stringify(result);
    }
    case 'obsidian_rag_query': {
      const query = String(args.query);
      const limit = Number(args.limit) || 5;
      const opt = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v));
      const results = await ctx.indexer.search(query, {
        limit,
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
      const linkRegex = new RegExp(`\\[\\[${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\]\\|#])`, 'i');
      const files = await glob('**/*.md', { cwd: vp });
      const backlinks: string[] = [];
      const batchSize = 50;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        await Promise.all(batch.map(async (f) => {
          try {
            const content = await fs.readFile(path.join(vp, f), 'utf-8');
            if (linkRegex.test(content)) backlinks.push(f);
          } catch { }
        }));
      }
      if (backlinks.length === 0) return `No backlinks found for "[[${target}]]".`;
      return `Found ${backlinks.length} backlinks for "[[${target}]]":\n` + backlinks.map(f => `- ${f}`).join('\n');
    }
    case 'obsidian_get_links': {
      const vp = vaultArg();
      const content = await fs.readFile(path.join(vp, String(args.file_path)), 'utf-8');
      return JSON.stringify(extractWikilinks(content), null, 2);
    }
    case 'obsidian_move_note': {
      const vp = vaultArg();
      const source = path.join(vp, String(args.source_path));
      const dest = path.join(vp, String(args.dest_path));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(source, dest);
      ctx.reindex(vp, String(args.dest_path), String(args.source_path));
      return `Moved ${args.source_path} to ${args.dest_path}`;
    }
    case 'obsidian_update_frontmatter': {
      const vp = vaultArg();
      const filePath = path.join(vp, String(args.file_path));
      const fileContent = await fs.readFile(filePath, 'utf-8');
      // CLI passes `updates` as a JSON string; MCP passes an object.
      const rawUpdates = typeof args.updates === 'string' ? JSON.parse(args.updates) : args.updates;
      const updateArg = (rawUpdates && typeof rawUpdates === 'object')
        ? { updates: rawUpdates as Record<string, unknown> }
        : { key: String(args.key), value: String(args.value) };
      await fs.writeFile(filePath, applyFrontmatterUpdate(fileContent, updateArg), 'utf-8');
      ctx.reindex(vp, String(args.file_path));
      return `Updated frontmatter in ${args.file_path}`;
    }
    case 'obsidian_replace_section': {
      const vp = vaultArg();
      const filePath = path.join(vp, String(args.file_path));
      const heading = String(args.heading);
      const content = String(args.content);
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const range = findSectionRange(fileContent, heading);
      if (!range) throw new McpError(ErrorCode.InvalidParams, `Heading "${heading}" not found in ${args.file_path}`);
      await fs.writeFile(filePath, replaceSection(fileContent, range, content), 'utf-8');
      ctx.reindex(vp, String(args.file_path));
      return `Replaced section "${heading}" in ${args.file_path}`;
    }
    case 'obsidian_insert_at_heading': {
      const vp = vaultArg();
      const filePath = path.join(vp, String(args.file_path));
      const heading = String(args.heading);
      const content = String(args.content);
      const position = (args.position || 'end') as 'beginning' | 'end';
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const range = findSectionRange(fileContent, heading);
      await fs.writeFile(filePath, insertAtHeading(fileContent, heading, content, position, range), 'utf-8');
      ctx.reindex(vp, String(args.file_path));
      return `Inserted content under "${heading}" in ${args.file_path}`;
    }
    case 'obsidian_append_daily_log': {
      const vp = vaultArg();
      const heading = String(args.heading);
      const content = String(args.content);
      const filePath = path.join(vp, await resolveDailyNotePath(vp, new Date()));
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
      const filePath = path.join(vp, String(args.file_path));
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const updated = replaceInNote(fileContent, String(args.old_text), String(args.new_text ?? ''));
      await fs.writeFile(filePath, updated, 'utf-8');
      ctx.reindex(vp, String(args.file_path));
      return `Replaced text in ${args.file_path}`;
    }
    case 'obsidian_get_broken_links': {
      const vp = vaultArg();
      const pattern = listNotesPattern(args.subfolder ? String(args.subfolder) : undefined);
      const files = await glob(pattern, { cwd: vp });
      const allFiles = await glob('**/*.md', { cwd: vp });
      const nameSet = new Set(allFiles.map((f: string) => path.basename(f, '.md').toLowerCase()));
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
        if (!nameSet.has(target.toLowerCase())) broken.push({ target, refs });
      }
      if (broken.length === 0) return 'No broken links found.';
      const lines = broken.map(b => `[[${b.target}]] — in: ${b.refs.join(', ')}`).join('\n');
      return `Found ${broken.length} broken link(s):\n${lines}`;
    }
    default:
      throw new UnknownToolError(name);
  }
}
