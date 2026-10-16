import { describe, it, expect } from 'vitest';
import { buildEmbeddingInputs, extractNoteMeta, splitByHeadings } from './chunking.js';

describe('extractNoteMeta', () => {
  it('prefers frontmatter title, updated date, status and type', () => {
    const meta = extractNoteMeta('a/b.md', { title: 'T', updated: new Date('2025-03-02'), created: '2024-01-01', status: 'proposal', type: 'plan' }, '# Heading');
    expect(meta).toEqual({ title: 'T', date: '2025-03-02', status: 'proposal', type: 'plan' });
  });
  it('falls back to H1, created date, then mtime', () => {
    expect(extractNoteMeta('a/b.md', { created: '2024-01-01' }, 'intro\n# Heading\n').title).toBe('Heading');
    expect(extractNoteMeta('a/b.md', { created: '2024-01-01' }, '').date).toBe('2024-01-01');
    expect(extractNoteMeta('a/b.md', {}, '', new Date('2026-10-16T12:00:00Z')).date).toBe('2026-10-16');
  });
  it('falls back to filename and empty strings', () => {
    expect(extractNoteMeta('x/My Note.md', {}, 'no heading')).toEqual({ title: 'My Note', date: '', status: '', type: '' });
  });
});

describe('buildEmbeddingInputs', () => {
  const body = 'First paragraph with enough text to be a chunk on its own.';
  const meta = { title: 'Note', date: '2025-01-01', status: 'active', type: 'pattern' };

  it('embeds with title/path header but stores raw text', () => {
    const { textsToEmbed, chunkMetadata } = buildEmbeddingInputs('a/b.md', body, undefined, meta);
    expect(textsToEmbed[0]).toBe(`Note (a/b.md)\n\n${body}`);
    expect(chunkMetadata[0]).toMatchObject({ path: 'a/b.md', text: body, ...meta });
  });

  it('uses path header and empty metadata when none given', () => {
    const { textsToEmbed, chunkMetadata } = buildEmbeddingInputs('a/b.md', body);
    expect(textsToEmbed[0]).toBe(`a/b.md\n\n${body}`);
    expect(chunkMetadata[0]).toMatchObject({ title: '', date: '', status: '', type: '' });
  });
});

describe('heading-aware chunking', () => {
  it('splitByHeadings builds heading paths', () => {
    const sections = splitByHeadings('intro\n# A\naaa\n## B\nbbb\n# C\nccc');
    expect(sections.map(s => s.heading)).toEqual(['', 'A', 'A > B', 'C']);
  });

  it('never merges across a heading boundary and prefixes the embed header', () => {
    const meta = { title: 'Title', date: '', status: '', type: '' };
    const body = '# A\n' + 'a'.repeat(60) + '\n# C\n' + 'c'.repeat(60);
    const { textsToEmbed, chunkMetadata } = buildEmbeddingInputs('x.md', body, undefined, meta);
    expect(chunkMetadata).toHaveLength(2);
    expect(chunkMetadata.map(c => c.heading)).toEqual(['A', 'C']);
    expect(textsToEmbed[0].startsWith('Title > A (x.md)')).toBe(true);
  });
});

describe('heading-aware chunking edge cases', () => {
  it('keeps the heading in the embed header when the note has no title', () => {
    const { textsToEmbed } = buildEmbeddingInputs('x.md', '# A\n' + 'a'.repeat(60));
    expect(textsToEmbed[0].startsWith('A (x.md)')).toBe(true);
    expect(buildEmbeddingInputs('x.md', 'a'.repeat(60)).textsToEmbed[0].startsWith('x.md\n\n')).toBe(true);
  });

  it('keeps short sections whose heading plus body reach the minimum', () => {
    const { chunkMetadata } = buildEmbeddingInputs('x.md', '# Status\nBlocked on the vendor', { minChunkChars: 25 });
    expect(chunkMetadata).toHaveLength(1);
    expect(chunkMetadata[0].heading).toBe('Status');
    expect(chunkMetadata[0].text).toBe('Blocked on the vendor');
  });
});
