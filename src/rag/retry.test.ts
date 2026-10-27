import { describe, it, expect, vi } from 'vitest';
import { withCommitRetry } from './retry.js';

const conflict = () => new Error('Retryable commit conflict for version 7');
const noSleep = async () => {};

describe('withCommitRetry', () => {
  it('retries conflicts and returns the value', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict())
      .mockResolvedValue('ok');
    await expect(withCommitRetry(fn, 5, noSleep)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows other errors at once', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('disk full'));
    await expect(withCommitRetry(fn, 5, noSleep)).rejects.toThrow('disk full');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows the conflict after all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(conflict());
    await expect(withCommitRetry(fn, 5, noSleep)).rejects.toThrow(/Retryable commit conflict/);
    expect(fn).toHaveBeenCalledTimes(5);
  });
});
