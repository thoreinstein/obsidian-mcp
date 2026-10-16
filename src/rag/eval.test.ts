import { describe, it, expect } from 'vitest';
import { scoreRun } from './eval.js';

describe('scoreRun', () => {
  it('computes recall@5 and MRR over queries', () => {
    expect(scoreRun([['a', 'b'], ['x']], [['b'], ['y']])).toEqual({ recallAt5: 0.5, mrr: 0.25 });
  });
  it('ignores hits beyond rank 5', () => {
    expect(scoreRun([['a', 'b', 'c', 'd', 'e', 'f']], [['f']])).toEqual({ recallAt5: 0, mrr: 0 });
  });
  it('returns zeros for no queries', () => {
    expect(scoreRun([], [])).toEqual({ recallAt5: 0, mrr: 0 });
  });
});
