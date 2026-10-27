import { describe, expect, it } from 'vitest';
import { md5 } from './hash.js';

describe('md5', () => {
  it('matches known digests', () => {
    expect(md5('hello')).toBe('5d41402abc4b2a76b9719d911017c592');
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('matches the md5 package output for multibyte text', () => {
    expect(md5('Ünïcödé 🎉')).toBe('15245abaea1d56532c48d5f3d9160543');
  });
});
