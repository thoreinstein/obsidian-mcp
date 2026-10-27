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

describe('chunk text readability and embed stability', () => {
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about the vendor rollout plan in detail.`).join(' ');
  const bodies = [
    '# Tasks\nThings to do before the release goes out:\n- first item to complete\n- second item to complete\n- third item to complete\n- fourth item to complete\n- fifth item to complete\n',
    `# Long\n${long}\n\nA short trailing paragraph that is long enough to keep.`,
    '# Notes\nFirst short paragraph that is long enough.\n\nSecond short paragraph that is also long enough.\n\nThird short paragraph, again long enough to keep.\n',
  ];
  // Captured from the implementation before chunk text stopped being whitespace-collapsed.
  const expectedTexts: string[][] = [
  [
    "Tasks (a/b.md)\n\nThings to do before the release goes out: - first item to complete - second item to complete - third item to complete - fourth item to complete - fifth item to complete"
  ],
  [
    "Long (a/b.md)\n\nSentence number 0 talks about the vendor rollout plan in detail. Sentence number 1 talks about the vendor rollout plan in detail. Sentence number 2 talks about the vendor rollout plan in detail. Sentence number 3 talks about the vendor rollout plan in detail. Sentence number 4 talks about the vendor rollout plan in detail. Sentence number 5 talks about the vendor rollout plan in detail. Sentence number 6 talks about the vendor rollout plan in detail. Sentence number 7 talks about the vendor rollout plan in detail. Sentence number 8 talks about the vendor rollout plan in detail. Sentence number 9 talks about the vendor rollout plan in detail. Sentence number 10 talks about the vendor rollout plan in detail. Sentence number 11 talks about the vendor rollout plan in detail. Sentence number 12 talks about the vendor rollout plan in detail. Sentence number 13 talks about the vendor rollout plan in detail. Sentence number 14 talks about the vendor rollout plan in detail. Sentence number 15 talks about the vendor rollout plan in detail. Sentence number 16 talks about the vendor rollout plan in detail. Sentence number 17 talks about the vendor rollout plan in detail. Sentence number 18 talks about the vendor rollout plan in detail. Sentence number 19 talks about the vendor rollout plan in detail. Sentence number 20 talks about the vendor rollout plan in detail. Sentence number 21 talks about the vendor rollout plan in detail. Sentence number 22 talks about the vendor rollout plan in detail. Sentence number 23 talks about the vendor rollout plan in detail. Sentence number 24 talks about the vendor rollout plan in detail. Sentence number 25 talks about the vendor rollout plan in detail. Sentence number 26 talks about the vendor rollout plan in detail.",
    "Long (a/b.md)\n\nSentence number 27 talks about the vendor rollout plan in detail. Sentence number 28 talks about the vendor rollout plan in detail. Sentence number 29 talks about the vendor rollout plan in detail. Sentence number 30 talks about the vendor rollout plan in detail. Sentence number 31 talks about the vendor rollout plan in detail. Sentence number 32 talks about the vendor rollout plan in detail. Sentence number 33 talks about the vendor rollout plan in detail. Sentence number 34 talks about the vendor rollout plan in detail. Sentence number 35 talks about the vendor rollout plan in detail. Sentence number 36 talks about the vendor rollout plan in detail. Sentence number 37 talks about the vendor rollout plan in detail. Sentence number 38 talks about the vendor rollout plan in detail. Sentence number 39 talks about the vendor rollout plan in detail.",
    "Long (a/b.md)\n\nA short trailing paragraph that is long enough to keep."
  ],
  [
    "Notes (a/b.md)\n\nFirst short paragraph that is long enough.\n\nSecond short paragraph that is also long enough.\n\nThird short paragraph, again long enough to keep."
  ]
];
  const expectedIds: string[][] = [
  [
    "42e7a46aea8470709bac16ac7278b8eb"
  ],
  [
    "42e7a46aea8470709bac16ac7278b8eb",
    "8ee6952e8a34809be06b524b90cd7586",
    "2a21f43ac832a76da2cf71323a2c53e7"
  ],
  [
    "42e7a46aea8470709bac16ac7278b8eb"
  ]
];

  it('embed inputs are unchanged', () => {
    expect(bodies.map(b => buildEmbeddingInputs('a/b.md', b).textsToEmbed)).toEqual(expectedTexts);
  });

  it('chunk ids are unchanged', () => {
    expect(bodies.map(b => buildEmbeddingInputs('a/b.md', b).chunkMetadata.map(c => c.id))).toEqual(expectedIds);
  });

  it('stores list line breaks in chunk text', () => {
    const { chunkMetadata } = buildEmbeddingInputs('a/b.md', bodies[0]);
    expect(chunkMetadata[0].text).toContain('\n- ');
  });

  it('keeps merged paragraphs verbatim and split-paragraph pieces normalized', () => {
    const { chunkMetadata } = buildEmbeddingInputs('a/b.md', bodies[1]);
    expect(chunkMetadata[0].text).not.toMatch(/\s{2,}|\n/);
    const merged = buildEmbeddingInputs('a/b.md', bodies[2]).chunkMetadata[0].text;
    expect(merged).toBe('First short paragraph that is long enough.\n\nSecond short paragraph that is also long enough.\n\nThird short paragraph, again long enough to keep.');
  });
});
