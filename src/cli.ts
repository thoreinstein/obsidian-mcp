import type { VaultIndexer } from './rag/store.js';
import { loadVaultSchema, parseCliArgs, validateFrontmatter, type VaultSchema } from './utils.js';
import { runTool, TOOL_DEFINITIONS, type ToolContext } from './tools.js';
import { hookNotePath } from './hooks.js';
import { runEval } from './rag/eval.js';

export interface CliDeps {
  ctx: ToolContext;
  vault: { getVaultPath(override?: string): string };
  readStdin: () => Promise<string>;
  out: (s: string) => void;
  err: (s: string) => void;
  runEval?: typeof runEval;
  indexer?: Pick<VaultIndexer, 'search'>;
}

const knownTools = [...TOOL_DEFINITIONS.map(t => t.name), 'validate_frontmatter', 'obsidian_rag_eval'];

/**
 * Runs a one-shot CLI/hook invocation. Returns null when argv[0] is not a known tool
 * (the caller then starts the MCP server), otherwise the process exit code.
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number | null> {
  const { ctx, vault, readStdin, out, err } = deps;
  if (argv.length === 0 || !knownTools.includes(argv[0])) return null;

  const toolName = argv[0];
  const toolArgs = argv.slice(1);

  // The one place the one-shot overrides live. The CLI exits right after the tool returns, so a background
  // reindex would be killed mid-flight: keep the CLI's historical behavior (no auto-reindex on writes).
  ctx.reindex = () => {};
  ctx.allowForceReindex = true;

  const parsedArgs: any = parseCliArgs(toolArgs);

  try {
    let result: string;
    if (toolName === 'obsidian_rag_index' && parsedArgs.hook) {
      const inputStr = await readStdin();
      if (!inputStr) {
        return 0;
      }
      let input: any;
      try { input = JSON.parse(inputStr); } catch { return 0; }
      const hookFp = input.tool_input?.file_path;
      if (!hookFp) {
        // No file_path in hook input — exit cleanly
        return 0;
      }
      const hookVault = input.tool_input?.vault_path || parsedArgs.vault_path || undefined;
      let hvp: string;
      try { hvp = vault.getVaultPath(hookVault); } catch { return 0; }
      const rel = await hookNotePath(hvp!, String(hookFp));
      if (rel === null) { return 0; }
      result = await runTool(toolName, { ...parsedArgs, vault_path: hookVault, file_path: rel }, ctx);
    } else if (toolName === 'obsidian_rag_eval') {
      if (typeof parsedArgs.file !== 'string') throw new Error('obsidian_rag_eval requires --file <queries.json>');
      const indexer = deps.indexer ?? ctx.indexer;
      result = await (deps.runEval ?? runEval)(parsedArgs.file, (q, opts) => indexer.search(q, opts));
    } else if (toolName !== 'validate_frontmatter') {
      result = await runTool(toolName, parsedArgs, ctx);
    } else {
      if (!parsedArgs.hook) { return 0; }
      const inputStr = await readStdin();
      if (!inputStr) { return 0; }
      let input: any;
      try { input = JSON.parse(inputStr); } catch { return 0; }

      const filePath = String(input.tool_input?.file_path ?? '');
      const content = String(input.tool_input?.content ?? '');
      if (!filePath || !content) { return 0; }

      let vp: string;
      try { vp = vault.getVaultPath(input.tool_input?.vault_path || undefined); } catch { return 0; }

      // Only vault notes are validated; anything else is not ours to block.
      const relPath = await hookNotePath(vp!, filePath);
      if (relPath === null) { return 0; }

      let schema: VaultSchema | null;
      try { schema = await loadVaultSchema(vp!); } catch { return 0; } // unreadable schema: silent no-op
      if (!schema) { return 0; }

      const errors = validateFrontmatter(relPath, content, schema!);
      if (errors.length > 0) {
        err(`[obsidian-mcp] Blocked: "${relPath}" has invalid frontmatter: ${errors.join('; ')}`);
        return 2;
      }
      return 0;
    }
    out(result);
    return 0;
  } catch (error: any) {
    err(error.message);
    return 1;
  }
}
