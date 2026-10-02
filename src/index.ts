#!/usr/bin/env node

// 1. Defensive check for native dependencies (MUST be first)
try {
    require.resolve('@lancedb/lancedb');
    const ortPackagePath = require.resolve('onnxruntime-node/package.json');
    const ortVersion = require(ortPackagePath).version as string | undefined;
    const isCompatibleOrt = typeof ortVersion === 'string' && /^1\.14(\.|$)/.test(ortVersion);
    if (!isCompatibleOrt) {
      console.error('\n[Obsidian MCP] Error: Incompatible onnxruntime-node version detected.');
      console.error(`Installed: ${ortVersion ?? 'unknown'}, required: 1.14.x`);
      console.error('This project bundles @xenova/transformers 2.17.x, which requires onnxruntime-node 1.14.x.');
      console.error('Please run:');
      console.error(`  cd ${require('path').join(__dirname, '..')} && npm install onnxruntime-node@1.14.0 --save-exact\n`);
      process.exit(1);
    }
} catch (e) {
    console.error('\n[Obsidian MCP] Error: Required native dependencies are missing.');
    console.error('This usually happens if "npm install" was not run or failed.');
    console.error('Please run the following command in the extension directory:');
    console.error(`  cd ${require('path').join(__dirname, '..')} && npm install\n`);
    process.exit(1);
}

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { glob } from 'glob';
import matter from 'gray-matter';
import { VaultIndexer } from './rag/store.js';
import { extractWikilinks, findSectionRange, replaceSection, insertAtHeading, listNotesPattern, replaceInNote, applyFrontmatterUpdate, stripHeadingFromLink } from './utils.js';

let VAULT_PATH: string | null = process.env.OBSIDIAN_VAULT_PATH || null;
const indexer = new VaultIndexer();
const CONFIG_PATH = process.env.OBSIDIAN_MCP_CONFIG ?? path.join(os.homedir(), '.config', 'obsidian-mcp', 'config.json');

async function saveConfig(vaultPath: string) {
    try {
        await fs.writeFile(CONFIG_PATH, JSON.stringify({ vault_path: vaultPath }), 'utf-8');
    } catch (e) { console.error("Failed to save config", e); }
}

async function loadConfig(): Promise<string | null> {
    try {
        const data = await fs.readFile(CONFIG_PATH, 'utf-8');
        return JSON.parse(data).vault_path;
    } catch { return null; }
}

/**
 * Helper to validate vault path
 */
function getVaultPath(providedPath?: string): string {
  const p = providedPath || VAULT_PATH;
  if (!p) {
    throw new McpError(ErrorCode.InvalidParams, "Vault path is not set. Use obsidian_set_vault or provide 'vault_path' argument.");
  }
  return p;
}


async function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (chunk) => {
            data += chunk;
        });
        process.stdin.on('end', () => {
            resolve(data);
        });
        process.stdin.on('error', (err) => {
            reject(err);
        });
        // Handle cases where stdin might be empty or already closed
        setTimeout(() => {
            if (data === '') {
                // If no data after 1s, resolve with empty to avoid hang
                resolve('');
            }
        }, 1000);
    });
}

(async () => {
  // Load config if environment variable is not set
  if (!VAULT_PATH) {
      VAULT_PATH = await loadConfig();
  }

  // Handle CLI args for one-shot mode
  const args = process.argv.slice(2);

  // If arguments start with a tool name (simple heuristic)
  const knownTools = ['obsidian_list_notes', 'obsidian_read_note', 'obsidian_search_notes', 'obsidian_rag_index', 'obsidian_rag_query', 'obsidian_set_vault', 'obsidian_create_note', 'obsidian_append_note', 'obsidian_get_daily_note', 'obsidian_get_backlinks', 'obsidian_get_links', 'obsidian_move_note', 'obsidian_update_frontmatter', 'obsidian_append_daily_log', 'obsidian_replace_section', 'obsidian_insert_at_heading', 'obsidian_replace_in_note', 'obsidian_get_broken_links', 'validate_frontmatter'];

  if (args.length > 0 && knownTools.includes(args[0])) {
    const toolName = args[0];
    const toolArgs = args.slice(1);

    const parsedArgs: any = {};
    for (let i = 0; i < toolArgs.length; i++) {
        if (toolArgs[i] && toolArgs[i].startsWith('--')) {
            const key = toolArgs[i].substring(2);
            if (i + 1 < toolArgs.length && !toolArgs[i+1].startsWith('--')) {
                parsedArgs[key] = toolArgs[i+1];
                i++;
            } else {
                parsedArgs[key] = true;
            }
        }
    }

    try {
        let result;
        if (toolName === 'obsidian_list_notes') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const pattern = listNotesPattern(parsedArgs.subfolder ? String(parsedArgs.subfolder) : undefined);
            const files = await glob(pattern, { cwd: vp });
            result = JSON.stringify(files.slice(0, 100), null, 2) + (files.length > 100 ? `\n...and ${files.length - 100} more.` : '');
        } else if (toolName === 'obsidian_read_note') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const filePath = path.join(vp, String(parsedArgs.file_path));
            result = await fs.readFile(filePath, 'utf-8');
        } else if (toolName === 'obsidian_create_note') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const filePath = path.join(vp, String(parsedArgs.file_path));
            const content = String(parsedArgs.content || '');
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, content, 'utf-8');
            result = `Created note: ${parsedArgs.file_path}`;
        } else if (toolName === 'obsidian_append_note') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const filePath = path.join(vp, String(parsedArgs.file_path));
            const content = String(parsedArgs.content || '');
            await fs.appendFile(filePath, '\n' + content, 'utf-8');
            result = `Appended to note: ${parsedArgs.file_path}`;
        } else if (toolName === 'obsidian_get_daily_note') {
             const vp = getVaultPath(parsedArgs.vault_path);
             const dateStr = new Date().toISOString().split('T')[0];
             const dailyFolder = (await fs.stat(path.join(vp, 'Daily Notes')).catch(() => null)) ? 'Daily Notes' : '';
             const fileName = `${dateStr}.md`;
             const filePath = path.join(vp, dailyFolder, fileName);
             try {
                 result = await fs.readFile(filePath, 'utf-8');
             } catch (e) {
                 await fs.mkdir(path.dirname(filePath), { recursive: true });
                 const content = `# ${dateStr}\n\n`;
                 await fs.writeFile(filePath, content, 'utf-8');
                 result = content;
             }
        } else if (toolName === 'obsidian_search_notes') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const query = String(parsedArgs.query).toLowerCase();
            const files = await glob('**/*.md', { cwd: vp });
            const matches: string[] = [];
            for (const f of files) {
                if (f.toLowerCase().includes(query)) {
                     matches.push(f + " (Filename match)"); continue;
                }
                try {
                     const c = await fs.readFile(path.join(vp, f), 'utf-8');
                     if (c.toLowerCase().includes(query)) matches.push(f);
                } catch(e) {}
                if (matches.length >= 20) break;
            }
            result = matches.join('\n');
        } else if (toolName === 'obsidian_rag_index') {
            let vp, fp;
            if (parsedArgs.hook) {
                const inputStr = await readStdin();
                if (!inputStr) {
                    process.exit(0);
                }
                const input = JSON.parse(inputStr);
                vp = getVaultPath(input.tool_input?.vault_path || VAULT_PATH);
                fp = input.tool_input?.file_path;
                if (!fp) {
                    // No file_path in hook input — exit cleanly
                    process.exit(0);
                }
            } else {
                vp = getVaultPath(parsedArgs.vault_path);
                fp = parsedArgs.file_path ? String(parsedArgs.file_path) : null;
            }
            const force = parsedArgs.force_reindex === true || parsedArgs.force === true;
            let res;
            if (fp) {
                res = await indexer.indexFile(vp, String(fp));
            } else {
                res = await indexer.indexVault(vp, force);
            }
            result = JSON.stringify(res);
        } else if (toolName === 'obsidian_rag_query') {
            const query = String(parsedArgs.query);
            const limit = Number(parsedArgs.limit) || 5;
            const res = await indexer.search(query, limit);
            result = res.map((r: any) => `File: ${r.path}\nContent: ${r.text}`).join('\n---\n');
        } else if (toolName === 'obsidian_get_backlinks') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const target = String(parsedArgs.file_name).replace(/\.md$/i, '');
            const linkRegex = new RegExp(`\\[\\[${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\]\\|#])`, 'i');

            const files = await glob('**/*.md', { cwd: vp });

            const backlinks: string[] = [];
            const batchSize = 50;

            for (let i = 0; i < files.length; i += batchSize) {
                const batch = files.slice(i, i + batchSize);
                await Promise.all(batch.map(async (f) => {
                    try {
                        const content = await fs.readFile(path.join(vp, f), 'utf-8');
                        if (linkRegex.test(content)) {
                            backlinks.push(f);
                        }
                    } catch (e) { }
                }));
            }
            if (backlinks.length === 0) {
                 result = `No backlinks found for "[[${target}]]".`;
            } else {
                 result = `Found ${backlinks.length} backlinks for "[[${target}]]":\n` + backlinks.map(f => `- ${f}`).join('\n');
            }
        } else if (toolName === 'obsidian_get_links') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const filePath = path.join(vp, String(parsedArgs.file_path));
            const content = await fs.readFile(filePath, 'utf-8');
            result = JSON.stringify(extractWikilinks(content), null, 2);
        } else if (toolName === 'obsidian_move_note') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const source = path.join(vp, String(parsedArgs.source_path));
            const dest = path.join(vp, String(parsedArgs.dest_path));
            await fs.mkdir(path.dirname(dest), { recursive: true });
            await fs.rename(source, dest);
            result = `Moved ${parsedArgs.source_path} to ${parsedArgs.dest_path}`;
        } else if (toolName === 'obsidian_update_frontmatter') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const filePath = path.join(vp, String(parsedArgs.file_path));
            const fileContent = await fs.readFile(filePath, 'utf-8');
            let updateArg: Parameters<typeof applyFrontmatterUpdate>[1];
            if (parsedArgs.updates) {
                const updates = typeof parsedArgs.updates === 'string'
                    ? JSON.parse(parsedArgs.updates)
                    : parsedArgs.updates;
                updateArg = { updates };
            } else {
                updateArg = { key: String(parsedArgs.key), value: String(parsedArgs.value) };
            }
            await fs.writeFile(filePath, applyFrontmatterUpdate(fileContent, updateArg), 'utf-8');
            result = `Updated frontmatter in ${parsedArgs.file_path}`;
        } else if (toolName === 'obsidian_replace_section') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const filePath = path.join(vp, String(parsedArgs.file_path));
            const heading = String(parsedArgs.heading);
            const content = String(parsedArgs.content);
            const fileContent = await fs.readFile(filePath, 'utf-8');
            const range = findSectionRange(fileContent, heading);
            if (!range) throw new Error(`Heading "${heading}" not found in ${parsedArgs.file_path}`);
            await fs.writeFile(filePath, replaceSection(fileContent, range, content), 'utf-8');
            result = `Replaced section "${heading}" in ${parsedArgs.file_path}`;
        } else if (toolName === 'obsidian_insert_at_heading') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const filePath = path.join(vp, String(parsedArgs.file_path));
            const heading = String(parsedArgs.heading);
            const content = String(parsedArgs.content);
            const position = (parsedArgs.position || 'end') as 'beginning' | 'end';
            const fileContent = await fs.readFile(filePath, 'utf-8');
            const range = findSectionRange(fileContent, heading);
            await fs.writeFile(filePath, insertAtHeading(fileContent, heading, content, position, range), 'utf-8');
            result = `Inserted content under "${heading}" in ${parsedArgs.file_path}`;
        } else if (toolName === 'obsidian_append_daily_log') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const heading = String(parsedArgs.heading);
            const content = String(parsedArgs.content);
            const dateStr = new Date().toISOString().split('T')[0];
            const dailyFolder = (await fs.stat(path.join(vp, 'Daily Notes')).catch(() => null)) ? 'Daily Notes' : '';
            const fileName = `${dateStr}.md`;
            const filePath = path.join(vp, dailyFolder, fileName);
            let fileContent = '';
            try { fileContent = await fs.readFile(filePath, 'utf-8'); } catch (e) {
                await fs.mkdir(path.dirname(filePath), { recursive: true });
                fileContent = `# ${dateStr}\n\n`;
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
            result = `Appended to daily note under "${heading}"`;
        } else if (toolName === 'obsidian_replace_in_note') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const filePath = path.join(vp, String(parsedArgs.file_path));
            const fileContent = await fs.readFile(filePath, 'utf-8');
            const updated = replaceInNote(fileContent, String(parsedArgs.old_text), String(parsedArgs.new_text ?? ''));
            await fs.writeFile(filePath, updated, 'utf-8');
            result = `Replaced text in ${parsedArgs.file_path}`;
        } else if (toolName === 'obsidian_get_broken_links') {
            const vp = getVaultPath(parsedArgs.vault_path);
            const pattern = listNotesPattern(parsedArgs.subfolder ? String(parsedArgs.subfolder) : undefined);
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
            result = broken.length === 0
                ? 'No broken links found.'
                : `Found ${broken.length} broken link(s):\n` +
                  broken.map(b => `[[${b.target}]] — in: ${b.refs.join(', ')}`).join('\n');
        } else if (toolName === 'validate_frontmatter') {
            if (!parsedArgs.hook) { process.exit(0); }
            const inputStr = await readStdin();
            if (!inputStr) { process.exit(0); }
            let input: any;
            try { input = JSON.parse(inputStr); } catch { process.exit(0); }

            const filePath = String(input.tool_input?.file_path ?? '');
            const content = String(input.tool_input?.content ?? '');
            if (!filePath || !content) { process.exit(0); }

            let vp: string;
            try { vp = getVaultPath(input.tool_input?.vault_path || undefined); } catch { process.exit(0); }

            const schemaPath = path.join(vp!, '.obsidian-mcp-schema.json');
            let schema: { rules: Array<{ prefix: string; required: string[] }> } | undefined;
            try {
                schema = JSON.parse(await fs.readFile(schemaPath, 'utf-8'));
            } catch {
                process.exit(0); // no schema file — silent no-op
            }

            const matchingRule = (schema!.rules ?? []).find((r: { prefix: string }) =>
                filePath.startsWith(r.prefix)
            );
            if (!matchingRule) { process.exit(0); }

            const parsed = matter(content);
            const missing = matchingRule.required.filter((field: string) => !(field in parsed.data));
            if (missing.length > 0) {
                console.error(
                    `[obsidian-mcp] Blocked: "${filePath}" is missing required frontmatter fields: ${missing.join(', ')}`
                );
                process.exit(2);
            }
            process.exit(0);
        } else {
            console.error(`Unknown tool: ${toolName}`);
            process.exit(1);
        }
        console.log(result);
        process.exit(0);
    } catch (error: any) {
        console.error(error.message);
        process.exit(1);
    }
  }

  // MCP Server Mode
  const server = new Server(
    {
      name: 'obsidian-rag',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
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
              limit: { type: 'number', description: 'Number of chunks to retrieve (default 5)' },
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
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === 'obsidian_set_vault') {
          VAULT_PATH = String(args?.path);
          await saveConfig(VAULT_PATH);
          return { content: [{ type: 'text', text: `Vault path set to: ${VAULT_PATH}` }] };
      }
      if (name === 'obsidian_list_notes') {
          const vp = getVaultPath(args?.vault_path as string);
          const pattern = listNotesPattern(args?.subfolder ? String(args.subfolder) : undefined);
          const files = await glob(pattern, { cwd: vp });
          return { content: [{ type: 'text', text: JSON.stringify(files.slice(0, 100), null, 2) + (files.length > 100 ? `\n...and ${files.length - 100} more.` : '') }] };
      }
      if (name === 'obsidian_read_note') {
          const vp = getVaultPath(args?.vault_path as string);
          const filePath = path.join(vp, String(args?.file_path));
          const content = await fs.readFile(filePath, 'utf-8');
          return { content: [{ type: 'text', text: content }] };
      }
      if (name === 'obsidian_create_note') {
          const vp = getVaultPath(args?.vault_path as string);
          const filePath = path.join(vp, String(args?.file_path));
          const content = String(args?.content || '');
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, content, 'utf-8');
          return { content: [{ type: 'text', text: `Created note: ${args?.file_path}` }] };
      }
      if (name === 'obsidian_append_note') {
          const vp = getVaultPath(args?.vault_path as string);
          const filePath = path.join(vp, String(args?.file_path));
          const content = String(args?.content || '');
          await fs.appendFile(filePath, '\n' + content, 'utf-8');
          return { content: [{ type: 'text', text: `Appended to note: ${args?.file_path}` }] };
      }
      if (name === 'obsidian_get_daily_note') {
           const vp = getVaultPath(args?.vault_path as string);
           const dateStr = new Date().toISOString().split('T')[0];
           const dailyFolder = (await fs.stat(path.join(vp, 'Daily Notes')).catch(() => null)) ? 'Daily Notes' : '';
           const fileName = `${dateStr}.md`;
           const filePath = path.join(vp, dailyFolder, fileName);
           let content = '';
           try {
               content = await fs.readFile(filePath, 'utf-8');
           } catch (e) {
               await fs.mkdir(path.dirname(filePath), { recursive: true });
               content = `# ${dateStr}\n\n`;
               await fs.writeFile(filePath, content, 'utf-8');
           }
           return { content: [{ type: 'text', text: content }] };
      }
      if (name === 'obsidian_search_notes') {
          const vp = getVaultPath(args?.vault_path as string);
          const query = String(args?.query).toLowerCase();
          const files = await glob('**/*.md', { cwd: vp });
          const matches: string[] = [];
          for (const f of files) {
              if (f.toLowerCase().includes(query)) {
                  matches.push(f + " (Filename match)"); continue;
              }
              try {
                  const content = await fs.readFile(path.join(vp, f), 'utf-8');
                  if (content.toLowerCase().includes(query)) matches.push(f);
              } catch (e) { }
              if (matches.length >= 20) break;
          }
          return { content: [{ type: 'text', text: matches.join('\n') }] };
      }
      if (name === 'obsidian_rag_index') {
          const vp = getVaultPath(args?.vault_path as string);
          const fp = args?.file_path ? String(args.file_path) : null;
          const force = args?.force_reindex === true;
          let result;
          if (fp) {
              result = await indexer.indexFile(vp, fp);
          } else {
              result = await indexer.indexVault(vp, force);
          }
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (name === 'obsidian_rag_query') {
          const query = String(args?.query);
          const limit = Number(args?.limit) || 5;
          const results = await indexer.search(query, limit);
          const formatted = results.map((r: any) =>
              `---\nFile: ${r.path}\nRelevance: ${r._distance}\nContent: ${r.text}\n---`
          ).join('\n');
          return { content: [{ type: 'text', text: formatted }] };
      }
      if (name === 'obsidian_get_backlinks') {
          const vp = getVaultPath(args?.vault_path as string);
          const target = String(args?.file_name).replace(/\.md$/i, '');
          const linkRegex = new RegExp(`\\[\\[${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\]\\|#])`, 'i');

          const files = await glob('**/*.md', { cwd: vp });

          const backlinks: string[] = [];
          const batchSize = 50;

          for (let i = 0; i < files.length; i += batchSize) {
              const batch = files.slice(i, i + batchSize);
              await Promise.all(batch.map(async (f) => {
                  try {
                      const content = await fs.readFile(path.join(vp, f), 'utf-8');
                      if (linkRegex.test(content)) {
                          backlinks.push(f);
                      }
                  } catch (e) { }
              }));
          }

          if (backlinks.length === 0) {
               return { content: [{ type: 'text', text: `No backlinks found for "[[${target}]]".` }] };
          }
          return { content: [{ type: 'text', text: `Found ${backlinks.length} backlinks for "[[${target}]]":\n` + backlinks.map(f => `- ${f}`).join('\n') }] };
      }
      if (name === 'obsidian_get_links') {
          const vp = getVaultPath(args?.vault_path as string);
          const filePath = path.join(vp, String(args?.file_path));
          const content = await fs.readFile(filePath, 'utf-8');
          return { content: [{ type: 'text', text: JSON.stringify(extractWikilinks(content), null, 2) }] };
      }
      if (name === 'obsidian_move_note') {
          const vp = getVaultPath(args?.vault_path as string);
          const source = path.join(vp, String(args?.source_path));
          const dest = path.join(vp, String(args?.dest_path));

          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.rename(source, dest);
          return { content: [{ type: 'text', text: `Moved ${args?.source_path} to ${args?.dest_path}` }] };
      }
      if (name === 'obsidian_update_frontmatter') {
          const vp = getVaultPath(args?.vault_path as string);
          const filePath = path.join(vp, String(args?.file_path));
          const fileContent = await fs.readFile(filePath, 'utf-8');
          const updateArg = (args?.updates && typeof args.updates === 'object')
              ? { updates: args.updates as Record<string, unknown> }
              : { key: String(args?.key), value: String(args?.value) };
          await fs.writeFile(filePath, applyFrontmatterUpdate(fileContent, updateArg), 'utf-8');
          return { content: [{ type: 'text', text: `Updated frontmatter in ${args?.file_path}` }] };
      }
      if (name === 'obsidian_replace_section') {
          const vp = getVaultPath(args?.vault_path as string);
          const filePath = path.join(vp, String(args?.file_path));
          const heading = String(args?.heading);
          const content = String(args?.content);
          const fileContent = await fs.readFile(filePath, 'utf-8');
          const range = findSectionRange(fileContent, heading);
          if (!range) throw new McpError(ErrorCode.InvalidParams, `Heading "${heading}" not found in ${args?.file_path}`);
          await fs.writeFile(filePath, replaceSection(fileContent, range, content), 'utf-8');
          return { content: [{ type: 'text', text: `Replaced section "${heading}" in ${args?.file_path}` }] };
      }
      if (name === 'obsidian_insert_at_heading') {
          const vp = getVaultPath(args?.vault_path as string);
          const filePath = path.join(vp, String(args?.file_path));
          const heading = String(args?.heading);
          const content = String(args?.content);
          const position = (args?.position || 'end') as 'beginning' | 'end';
          const fileContent = await fs.readFile(filePath, 'utf-8');
          const range = findSectionRange(fileContent, heading);
          await fs.writeFile(filePath, insertAtHeading(fileContent, heading, content, position, range), 'utf-8');
          return { content: [{ type: 'text', text: `Inserted content under "${heading}" in ${args?.file_path}` }] };
      }
      if (name === 'obsidian_append_daily_log') {
          const vp = getVaultPath(args?.vault_path as string);
          const heading = String(args?.heading);
          const content = String(args?.content);

          const dateStr = new Date().toISOString().split('T')[0];
          const dailyFolder = (await fs.stat(path.join(vp, 'Daily Notes')).catch(() => null)) ? 'Daily Notes' : '';
          const fileName = `${dateStr}.md`;
          const filePath = path.join(vp, dailyFolder, fileName);

          let fileContent = '';
          try {
              fileContent = await fs.readFile(filePath, 'utf-8');
          } catch (e) {
              await fs.mkdir(path.dirname(filePath), { recursive: true });
              fileContent = `# ${dateStr}\n\n`;
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
          return { content: [{ type: 'text', text: `Appended to daily note under "${heading}"` }] };
      }
      if (name === 'obsidian_replace_in_note') {
          const vp = getVaultPath(args?.vault_path as string);
          const filePath = path.join(vp, String(args?.file_path));
          const fileContent = await fs.readFile(filePath, 'utf-8');
          const updated = replaceInNote(fileContent, String(args?.old_text), String(args?.new_text ?? ''));
          await fs.writeFile(filePath, updated, 'utf-8');
          return { content: [{ type: 'text', text: `Replaced text in ${args?.file_path}` }] };
      }
      if (name === 'obsidian_get_broken_links') {
          const vp = getVaultPath(args?.vault_path as string);
          const pattern = listNotesPattern(args?.subfolder ? String(args.subfolder) : undefined);
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
          if (broken.length === 0) {
              return { content: [{ type: 'text', text: 'No broken links found.' }] };
          }
          const lines = broken.map(b => `[[${b.target}]] — in: ${b.refs.join(', ')}`).join('\n');
          return { content: [{ type: 'text', text: `Found ${broken.length} broken link(s):\n${lines}` }] };
      }
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${error.message}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
