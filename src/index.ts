#!/usr/bin/env node

// 1. Defensive check for native dependencies (MUST be first)
try {
    require.resolve('@lancedb/lancedb');
    require.resolve('onnxruntime-node');
    // Bump with @huggingface/transformers: the bundle needs exactly the onnxruntime-node it was built against.
    const REQUIRED_ORT = '1.30.0';
    const ortVersion = require('onnxruntime-node/package.json').version;
    if (ortVersion !== REQUIRED_ORT) {
        throw new Error(`onnxruntime-node ${ortVersion} installed, ${REQUIRED_ORT} required`);
    }
} catch (e) {
    console.error('\n[Obsidian MCP] Error: Required native dependencies are missing.');
    console.error(`(${e instanceof Error ? e.message : e})`);
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
import { log } from './log.js';
import { buildInstructions, loadVaultSchema, parseCliArgs, validateFrontmatter, type VaultSchema } from './utils.js';
import { runEval } from './rag/eval.js';
import { createVaultResolver, loadAllowedRoots, type VaultConfig } from './vault.js';
import { hookNotePath } from './hooks.js';
import { runTool, TOOL_DEFINITIONS, UnknownToolError, type ToolContext } from './tools.js';

const indexer = new VaultIndexer();

// Reindex written notes in the background. Chained so concurrent writes don't interleave LanceDB delete/add.
let reindexQueue: Promise<unknown> = Promise.resolve();
function reindexInBackground(vaultPath: string, relativePath: string, removedPath?: string) {
    reindexQueue = reindexQueue
        .then(async () => {
            if (removedPath) await indexer.removeFile(removedPath);
            const res = await indexer.indexFile(vaultPath, relativePath);
            if (!res.success) log.warn(`Background reindex of ${relativePath} refused: ${res.message}`);
        })
        .catch(err => console.error(`Background reindex failed for ${relativePath}:`, err));
}
const CONFIG_PATH = process.env.OBSIDIAN_MCP_CONFIG ?? path.join(os.homedir(), '.config', 'obsidian-mcp', 'config.json');

async function loadConfig(): Promise<VaultConfig | null> {
    try {
        return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8'));
    } catch { return null; }
}

// Assigned at startup, after the config is read.
let vault = createVaultResolver([], CONFIG_PATH);

async function readStdin(): Promise<string> {
    if (process.stdin.isTTY) return '';
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
    });
}

const ctx: ToolContext = {
  getVaultPath: (override?: string) => vault.getVaultPath(override),
  setVaultPath: (p: string) => vault.setVaultPath(p),
  indexer,
  reindex: reindexInBackground,
};

(async () => {
  vault = createVaultResolver(loadAllowedRoots(process.env, await loadConfig()), CONFIG_PATH);

  // Handle CLI args for one-shot mode
  const args = process.argv.slice(2);

  // If arguments start with a tool name (simple heuristic)
  const knownTools = [...TOOL_DEFINITIONS.map(t => t.name), 'validate_frontmatter', 'obsidian_rag_eval'];

  if (args.length > 0 && knownTools.includes(args[0])) {
    const toolName = args[0];
    const toolArgs = args.slice(1);

    // One-shot CLI exits right after the tool returns, so a background reindex would be killed mid-flight.
    // Keep the CLI's historical behavior (no auto-reindex on writes).
    ctx.reindex = () => {};
    ctx.allowForceReindex = true;

    const parsedArgs: any = parseCliArgs(toolArgs);

    try {
        let result: string;
        if (toolName === 'obsidian_rag_index' && parsedArgs.hook) {
            const inputStr = await readStdin();
            if (!inputStr) {
                process.exit(0);
            }
            let input: any;
            try { input = JSON.parse(inputStr); } catch { process.exit(0); }
            const hookFp = input.tool_input?.file_path;
            if (!hookFp) {
                // No file_path in hook input — exit cleanly
                process.exit(0);
            }
            const hookVault = input.tool_input?.vault_path || parsedArgs.vault_path || undefined;
            let hvp: string;
            try { hvp = vault.getVaultPath(hookVault); } catch { process.exit(0); }
            const rel = await hookNotePath(hvp!, String(hookFp));
            if (rel === null) { process.exit(0); }
            result = await runTool(toolName, { ...parsedArgs, vault_path: hookVault, file_path: rel }, ctx);
        } else if (toolName === 'obsidian_rag_eval') {
            if (typeof parsedArgs.file !== 'string') throw new Error('obsidian_rag_eval requires --file <queries.json>');
            result = await runEval(parsedArgs.file, (q, opts) => indexer.search(q, opts));
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
            try { vp = vault.getVaultPath(input.tool_input?.vault_path || undefined); } catch { process.exit(0); }

            // Only vault notes are validated; anything else is not ours to block.
            const relPath = await hookNotePath(vp!, filePath);
            if (relPath === null) { process.exit(0); }

            let schema: VaultSchema | null;
            try { schema = await loadVaultSchema(vp!); } catch { process.exit(0); } // unreadable schema: silent no-op
            if (!schema) { process.exit(0); }

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
  let startupVault: string | null = null;
  try { startupVault = vault.getVaultPath(); } catch { /* no default vault */ }
  const guidePath = startupVault ? path.join(startupVault, 'AGENTS.md') : null;
  let guide: string | null = null;
  if (guidePath) {
    try {
      guide = await fs.readFile(guidePath, 'utf-8');
    } catch {
      guide = null;
    }
  }
  const packageVersion = (): string => {
    try {
      return require(path.join(__dirname, '..', 'package.json')).version as string;
    } catch {
      return '0.0.0';
    }
  };
  const server = new Server(
    {
      name: 'obsidian-mcp',
      version: packageVersion(),
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

  // Catch up on notes changed outside the server (Obsidian, exporters, hand edits). Incremental, so unchanged notes are skipped.
  const reindexVault = startupVault;
  if (reindexVault) {
    reindexQueue = reindexQueue
      .then(() => indexer.indexVault(reindexVault))
      .catch(err => console.error('Startup reindex failed:', err));
  }
})();
