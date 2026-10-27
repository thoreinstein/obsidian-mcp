import { Worker } from 'worker_threads';

export interface GrepResult { lines: string[]; extra: number; extraFiles: number }

// Runs in a worker via `eval`: must stay self-contained (no outer references).
function workerMain() {
  const fs = require('fs');
  const path = require('path');
  const { workerData, parentPort } = require('worker_threads');
  const { vp, files, pattern, flags, limit } = workerData;
  const re = new RegExp(pattern, flags);
  const lines: string[] = [];
  const extraFiles = new Set<string>();
  let shown = 0, extra = 0;
  for (const f of files) {
    if (re.test(path.basename(f))) {
      if (shown < limit) { lines.push(`${f} (filename match)`); shown++; }
      else { extra++; extraFiles.add(f); }
    }
    let content: string;
    try { content = fs.readFileSync(path.join(vp, f), 'utf-8'); } catch { continue; }
    const ls = content.split('\n');
    for (let i = 0; i < ls.length; i++) {
      if (!re.test(ls[i])) continue;
      if (shown < limit) { lines.push(`${f}:${i + 1}: ${ls[i].trim().slice(0, 200)}`); shown++; }
      else { extra++; extraFiles.add(f); }
    }
  }
  parentPort.postMessage({ lines, extra, extraFiles: extraFiles.size });
}

const WORKER_SOURCE = `(${workerMain.toString()})()`;

/** Grep `files` (vault-relative, already ordered) with a regex in a worker thread, killed after `timeoutMs`. */
export function grepVault(
  vp: string,
  files: string[],
  pattern: string,
  flags: string,
  limit: number,
  timeoutMs = 2000
): Promise<GrepResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { vp, files, pattern, flags, limit } });
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Regex search timed out after ${timeoutMs} ms`))),
      timeoutMs
    );
    worker.once('message', (r: GrepResult) => finish(() => resolve(r)));
    worker.once('error', (e) => finish(() => reject(e)));
    worker.once('exit', (code) => finish(() => reject(new Error(`Regex worker exited with code ${code}`))));
  });
}
