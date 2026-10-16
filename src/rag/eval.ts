import fs from 'fs/promises';
import type { SearchFilters } from '../utils.js';

export interface EvalQuery {
  query: string;
  expected: string[];
  filters?: SearchFilters;
}

/** recall@5 = share of queries with an expected path in the top 5; MRR = mean reciprocal rank of the first expected path in the top 5. */
export function scoreRun(results: string[][], expected: string[][]): { recallAt5: number; mrr: number } {
  if (results.length === 0) return { recallAt5: 0, mrr: 0 };
  let hits = 0;
  let rrSum = 0;
  results.forEach((paths, i) => {
    const idx = paths.slice(0, 5).findIndex(p => expected[i].includes(p));
    if (idx >= 0) {
      hits += 1;
      rrSum += 1 / (idx + 1);
    }
  });
  return { recallAt5: hits / results.length, mrr: rrSum / results.length };
}

export async function runEval(
  file: string,
  search: (query: string, opts: { limit: number } & SearchFilters) => Promise<{ path: string }[]>
): Promise<string> {
  const queries: EvalQuery[] = JSON.parse(await fs.readFile(file, 'utf-8'));
  const results: string[][] = [];
  const lines: string[] = [];
  for (const q of queries) {
    const hits = await search(q.query, { limit: 5, ...(q.filters ?? {}) });
    const paths = hits.map(h => h.path);
    results.push(paths);
    const rank = paths.findIndex(p => q.expected.includes(p));
    lines.push(`${rank >= 0 ? `HIT  @${rank + 1}` : 'MISS    '}  ${q.query}`);
  }
  const { recallAt5, mrr } = scoreRun(results, queries.map(q => q.expected));
  lines.push(`recall@5=${recallAt5.toFixed(3)} mrr=${mrr.toFixed(3)} queries=${queries.length}`);
  return lines.join('\n');
}
