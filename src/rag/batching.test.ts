import { describe, it, expect } from 'vitest';
import { planBatches } from './batching.js';

describe('planBatches', () => {
  it('caps by item count', () => {
    expect(planBatches(Array(10).fill(100), 4, 12000)).toEqual([[0, 4], [4, 8], [8, 10]]);
  });
  it('caps by characters', () => {
    expect(planBatches(Array(5).fill(1800), 48, 4000)).toEqual([[0, 2], [2, 4], [4, 5]]);
  });
  it('puts an oversize text in its own batch', () => {
    expect(planBatches([5000], 48, 4000)).toEqual([[0, 1]]);
  });
  it('returns nothing for no input', () => {
    expect(planBatches([], 48, 4000)).toEqual([]);
  });
  it('splits mixed lengths at the budget', () => {
    expect(planBatches([100, 100, 3900, 100], 48, 4000)).toEqual([[0, 2], [2, 3], [3, 4]]);
  });
});
