import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveVaultPath } from './utils.js';
import { vaultRel } from './tools.js';

/**
 * Normalize a hook `file_path` (absolute or vault-relative) to a vault-relative note path.
 * Returns null when it falls outside the vault or is not a `.md` note.
 */
export async function hookNotePath(vaultPath: string, filePath: string): Promise<string | null> {
  if (path.extname(filePath).toLowerCase() !== '.md') return null;
  // An absolute path may spell the vault root through a symlink or through its real directory.
  const roots = [vaultPath, await fs.realpath(vaultPath)];
  for (const root of roots) {
    try {
      return vaultRel(root, await resolveVaultPath(root, filePath));
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith('Path escapes vault')) throw e;
    }
  }
  return null;
}
