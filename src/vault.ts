import * as fs from 'fs';
import * as path from 'path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export interface VaultConfig {
  vault_path?: string;
  vault_paths?: string[];
}

/** Allowed vault roots, in order: OBSIDIAN_VAULT_PATHS, OBSIDIAN_VAULT_PATH, config vault_paths, config vault_path. */
export function loadAllowedRoots(env: NodeJS.ProcessEnv, config: VaultConfig | null): string[] {
  const candidates: unknown[] = [
    ...(env.OBSIDIAN_VAULT_PATHS ?? '').split(path.delimiter),
    env.OBSIDIAN_VAULT_PATH,
    ...(Array.isArray(config?.vault_paths) ? config!.vault_paths : []),
    config?.vault_path,
  ];
  const roots: string[] = [];
  for (const c of candidates) {
    if (typeof c !== 'string' || c === '') continue;
    if (!path.isAbsolute(c)) {
      console.error(`[obsidian-mcp] Ignoring relative vault path: ${c}`);
      continue;
    }
    if (!roots.includes(c)) roots.push(c);
  }
  return roots;
}

function real(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

export function createVaultResolver(allowed: string[], configPath?: string) {
  let current: string | null = null;

  const match = (p: string): string => {
    const target = path.isAbsolute(p) ? real(p) : null;
    const root = target === null ? undefined : allowed.find(r => real(r) === target);
    if (root === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `Vault not allowed: ${p}. Allowed: ${allowed.join(', ')}`);
    }
    return root;
  };

  const getVaultPath = (override?: string): string => {
    if (override) return match(override);
    const p = current ?? allowed.find(r => real(r) !== null);
    if (!p) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Vault path is not set. Set OBSIDIAN_VAULT_PATH or vault_path in ${configPath ?? 'the config file'}.`,
      );
    }
    return p;
  };

  const setVaultPath = async (p: string): Promise<void> => {
    current = match(p);
  };

  return { getVaultPath, setVaultPath };
}
