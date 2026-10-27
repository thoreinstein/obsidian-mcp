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
import { buildInstructions } from './utils.js';
import { createVaultResolver, loadAllowedRoots, type VaultConfig } from './vault.js';
import { runCli } from './cli.js';
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

  // One-shot CLI and hook invocations; null means argv is not a tool call, so start the MCP server.
  const code = await runCli(process.argv.slice(2), {
    ctx,
    vault,
    readStdin,
    out: s => console.log(s),
    err: s => console.error(s),
    indexer,
  });
  if (code !== null) process.exit(code);

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
