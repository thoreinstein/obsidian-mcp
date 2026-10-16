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
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { VaultIndexer } from './rag/store.js';
import { buildInstructions, loadVaultSchema, validateFrontmatter, type VaultSchema } from './utils.js';
import { runTool, TOOL_DEFINITIONS, UnknownToolError, type ToolContext } from './tools.js';

let VAULT_PATH: string | null = process.env.OBSIDIAN_VAULT_PATH || null;
const indexer = new VaultIndexer();

// Reindex written notes in the background. Chained so concurrent writes don't interleave LanceDB delete/add.
let reindexQueue: Promise<unknown> = Promise.resolve();
function reindexInBackground(vaultPath: string, relativePath: string, removedPath?: string) {
    reindexQueue = reindexQueue
        .then(async () => {
            if (removedPath) await indexer.removeFile(removedPath);
            await indexer.indexFile(vaultPath, relativePath);
        })
        .catch(err => console.error(`Background reindex failed for ${relativePath}:`, err));
}
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

const ctx: ToolContext = {
  getVaultPath,
  setVaultPath: async (p: string) => {
    VAULT_PATH = p;
    await saveConfig(p);
  },
  indexer,
  reindex: reindexInBackground,
};

(async () => {
  // Load config if environment variable is not set
  if (!VAULT_PATH) {
      VAULT_PATH = await loadConfig();
  }

  // Handle CLI args for one-shot mode
  const args = process.argv.slice(2);

  // If arguments start with a tool name (simple heuristic)
  const knownTools = [...TOOL_DEFINITIONS.map(t => t.name), 'validate_frontmatter'];

  if (args.length > 0 && knownTools.includes(args[0])) {
    const toolName = args[0];
    const toolArgs = args.slice(1);

    // One-shot CLI exits right after the tool returns, so a background reindex would be killed mid-flight.
    // Keep the CLI's historical behavior (no auto-reindex on writes).
    ctx.reindex = () => {};

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
        let result: string;
        if (toolName === 'obsidian_rag_index' && parsedArgs.hook) {
            const inputStr = await readStdin();
            if (!inputStr) {
                process.exit(0);
            }
            const input = JSON.parse(inputStr);
            const hookFp = input.tool_input?.file_path;
            if (!hookFp) {
                // No file_path in hook input — exit cleanly
                process.exit(0);
            }
            result = await runTool(toolName, { ...parsedArgs, vault_path: input.tool_input?.vault_path || parsedArgs.vault_path, file_path: hookFp }, ctx);
        } else if (toolName !== 'validate_frontmatter') {
            result = await runTool(toolName, parsedArgs, ctx);
        } else {
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

            let schema: VaultSchema | null;
            try { schema = await loadVaultSchema(vp!); } catch { process.exit(0); } // unreadable schema: silent no-op
            if (!schema) { process.exit(0); }

            // Hook file_path may be absolute; rules match vault-relative paths.
            const relPath = path.isAbsolute(filePath) ? path.relative(vp!, filePath) : filePath;
            const errors = validateFrontmatter(relPath, content, schema!);
            if (errors.length > 0) {
                console.error(`[obsidian-mcp] Blocked: "${relPath}" has invalid frontmatter: ${errors.join('; ')}`);
                process.exit(2);
            }
            process.exit(0);
        }
        console.log(result);
        process.exit(0);
    } catch (error: any) {
        console.error(error.message);
        process.exit(1);
    }
  }

  // MCP Server Mode
  const guidePath = VAULT_PATH ? path.join(VAULT_PATH, 'AGENTS.md') : null;
  let guide: string | null = null;
  if (guidePath) {
    try {
      guide = await fs.readFile(guidePath, 'utf-8');
    } catch {
      guide = null;
    }
  }
  const server = new Server(
    {
      name: 'obsidian-rag',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        ...(guide !== null ? { resources: {} } : {}),
      },
      instructions: buildInstructions(guide),
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS };
  });

  if (guide !== null && guidePath) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{ uri: 'obsidian://vault-guide', name: 'Vault guide', mimeType: 'text/markdown' }],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (request.params.uri !== 'obsidian://vault-guide') {
        throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${request.params.uri}`);
      }
      const text = await fs.readFile(guidePath, 'utf-8');
      return { contents: [{ uri: 'obsidian://vault-guide', mimeType: 'text/markdown', text }] };
    });
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const text = await runTool(name, (args ?? {}) as Record<string, unknown>, ctx);
      return { content: [{ type: 'text', text }] };
    } catch (error: any) {
      if (error instanceof UnknownToolError) {
        return { isError: true, content: [{ type: 'text', text: `Error: ${new McpError(ErrorCode.MethodNotFound, error.message).message}` }] };
      }
      return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${error.message}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
