import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import matter from 'gray-matter';
import {
  listNotesPattern,
  replaceInNote,
  stripHeadingFromLink,
  applyFrontmatterUpdate,
  formatResultMeta,
  dedupeByPath,
  formatDailyDate,
  resolveDailyNotePath,
  scanHeadings,
  buildWhereClause,
  rrfMerge,
  findMatches,
  noteOutline,
  buildInstructions,
} from './utils.js';

describe('listNotesPattern', () => {
  it('returns **/*.md when no subfolder', () => {
    expect(listNotesPattern()).toBe('**/*.md');
  });
  it('recurses into subfolder', () => {
    expect(listNotesPattern('Engineering')).toBe(path.join('Engineering', '**', '*.md'));
  });
  it('handles nested subfolder', () => {
    expect(listNotesPattern('working/dotfiles-nix')).toBe(
      path.join('working', 'dotfiles-nix', '**', '*.md')
    );
  });
});

describe('replaceInNote', () => {
  it('replaces first occurrence only', () => {
    expect(replaceInNote('foo bar foo', 'foo', 'baz')).toBe('baz bar foo');
  });
  it('throws when old_text not found', () => {
    expect(() => replaceInNote('some content', 'missing', 'new')).toThrow(
      'Text not found: "missing"'
    );
  });
  it('supports inserting a wikilink', () => {
    const result = replaceInNote('See the auth guide here.', 'auth guide', '[[Auth-Guide]]');
    expect(result).toBe('See the [[Auth-Guide]] here.');
  });
});

describe('stripHeadingFromLink', () => {
  it('strips heading fragment', () => {
    expect(stripHeadingFromLink('MyNote#section')).toBe('MyNote');
  });
  it('passes through plain links', () => {
    expect(stripHeadingFromLink('MyNote')).toBe('MyNote');
  });
  it('strips at first hash only', () => {
    expect(stripHeadingFromLink('My#Note#deeper')).toBe('My');
  });
});

describe('applyFrontmatterUpdate', () => {
  it('updates a single key/value', () => {
    const content = '---\nstatus: draft\n---\n# Title\n';
    const result = applyFrontmatterUpdate(content, { key: 'status', value: 'published' });
    expect(matter(result).data.status).toBe('published');
  });
  it('applies batch updates object', () => {
    const content = '---\nstatus: draft\n---\n# Title\n';
    const result = applyFrontmatterUpdate(content, {
      updates: { status: 'published', tags: ['a', 'b'] },
    });
    const parsed = matter(result);
    expect(parsed.data.status).toBe('published');
    expect(parsed.data.tags).toEqual(['a', 'b']);
  });
  it('batch updates preserve unrelated keys', () => {
    const content = '---\nstatus: draft\nauthor: thor\n---\n# Title\n';
    const result = applyFrontmatterUpdate(content, { updates: { status: 'published' } });
    expect(matter(result).data.author).toBe('thor');
  });
});

describe('formatResultMeta', () => {
  it('joins folder, date, status, type', () => {
    expect(formatResultMeta({ path: 'archive/p/x.md', date: '2025-03-02', status: 'proposal', type: 'plan' }))
      .toBe('archive · 2025-03-02 · status: proposal · type: plan');
  });
  it('omits empty fields and labels root notes', () => {
    expect(formatResultMeta({ path: 'Home.md', date: '', status: '' })).toBe('(root)');
  });
});

describe('dedupeByPath', () => {
  it('keeps the first (best-ranked) hit per path, in order, up to limit', () => {
    const hits = [{ path: 'a' }, { path: 'a' }, { path: 'b' }, { path: 'a' }, { path: 'c' }, { path: 'd' }];
    expect(dedupeByPath(hits, 3)).toEqual([{ path: 'a' }, { path: 'b' }, { path: 'c' }]);
  });
  it('returns fewer than limit when there are not enough distinct paths', () => {
    expect(dedupeByPath([{ path: 'a' }, { path: 'a' }], 5)).toEqual([{ path: 'a' }]);
  });
});

describe('formatDailyDate', () => {
  it('uses local time and nested format', () => {
    expect(formatDailyDate(new Date(2026, 9, 16, 23, 30), 'YYYY/MM/YYYY-MM-DD')).toBe('2026/10/2026-10-16');
  });
  it('supports short tokens', () => {
    expect(formatDailyDate(new Date(2026, 0, 5), 'YY-M-D')).toBe('26-1-5');
  });
  it('supports [literal] escapes', () => {
    expect(formatDailyDate(new Date(2026, 0, 5), '[Journal] YYYY')).toBe('Journal 2026');
  });
  it('throws on unsupported tokens', () => {
    expect(() => formatDailyDate(new Date(2026, 0, 5), 'dddd YYYY')).toThrow(/Unsupported daily note format token "dddd"/);
  });
});

describe('resolveDailyNotePath', () => {
  const d = new Date(2026, 9, 16, 23, 30);
  it('reads folder and format from .obsidian/daily-notes.json', async () => {
    const vp = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-'));
    await fs.mkdir(path.join(vp, '.obsidian'));
    await fs.writeFile(path.join(vp, '.obsidian', 'daily-notes.json'), JSON.stringify({ folder: 'Daily', format: 'YYYY/MM/YYYY-MM-DD' }));
    expect(await resolveDailyNotePath(vp, d)).toBe('Daily/2026/10/2026-10-16.md');
  });
  it('throws on malformed config instead of falling back', async () => {
    const vp = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-'));
    await fs.mkdir(path.join(vp, '.obsidian'));
    await fs.writeFile(path.join(vp, '.obsidian', 'daily-notes.json'), '{not json');
    await expect(resolveDailyNotePath(vp, d)).rejects.toThrow(/Invalid \.obsidian\/daily-notes\.json/);
  });
  it('defaults when no config', async () => {
    const vp = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-'));
    expect(await resolveDailyNotePath(vp, d)).toBe('2026-10-16.md');
  });
});

describe('scanHeadings', () => {
  it('skips headings inside fenced blocks', () => {
    expect(scanHeadings('# A\n```\n# not\n```\n## B')).toEqual([
      { level: 1, text: 'A', line: 1 },
      { level: 2, text: 'B', line: 5 },
    ]);
  });
  it('handles tilde fences', () => {
    expect(scanHeadings('~~~\n# no\n~~~\n# yes')).toEqual([{ level: 1, text: 'yes', line: 4 }]);
  });
});

describe('buildWhereClause', () => {
  it('returns undefined with no filters', () => {
    expect(buildWhereClause({})).toBeUndefined();
  });
  it('joins folder prefix and type equality', () => {
    expect(buildWhereClause({ folder: 'idx_team/', type: 'plan' })).toBe(
      "starts_with(path, 'idx_team/') AND type = 'plan'"
    );
  });
  it('escapes single quotes', () => {
    expect(buildWhereClause({ folder: "O'Brien" })).toContain("'O''Brien/'");
  });
  it('rejects a non-ISO after date', () => {
    expect(() => buildWhereClause({ after: 'yesterday' })).toThrow('after must be YYYY-MM-DD');
  });
  it('turns after into a date bound', () => {
    expect(buildWhereClause({ status: 'active', after: '2026-01-01' })).toBe(
      "status = 'active' AND date >= '2026-01-01'"
    );
  });
});

describe('rrfMerge', () => {
  it('ranks items found by both lists first', () => {
    const [a, b, c] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(rrfMerge([[a, b], [b, c]]).map(x => x.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('findMatches', () => {
  it('matches case-insensitively with 1-based line numbers', () => {
    expect(findMatches('a\nFoo bar\nfoo', 'foo', {}).map(m => m.line)).toEqual([2, 3]);
  });
  it('supports regex mode', () => {
    expect(findMatches('x1\ny22', '\\d{2}', { regex: true })).toEqual([{ line: 2, text: 'y22' }]);
  });
  it('throws on invalid regex', () => {
    expect(() => findMatches('x', '(', { regex: true })).toThrow(/Invalid regex/);
  });
  it('trims and caps text at 200 chars', () => {
    const [m] = findMatches('   ' + 'a'.repeat(300), 'a', {});
    expect(m.text).toBe('a'.repeat(200));
  });
});

describe('noteOutline', () => {
  it('summarises frontmatter, headings, links and words', () => {
    const o = noteOutline('---\ntype: plan\n---\n# T\nsee [[X]]\n## S\n');
    expect(o.frontmatter).toEqual({ type: 'plan' });
    expect(o.headings.map(h => h.text)).toEqual(['T', 'S']);
    expect(o.links).toEqual(['X']);
    expect(o.words).toBeGreaterThan(0);
  });
});

describe('buildInstructions', () => {
  it('generic only when no guide', () => {
    const s = buildInstructions(null);
    expect(s).toContain('obsidian_rag_query');
    expect(s).not.toContain('Vault guide');
  });
  it('truncates long guide and points at the resource', () => {
    const s = buildInstructions('x'.repeat(5000));
    expect(s.length).toBeLessThan(buildInstructions(null).length + 4200);
    expect(s.endsWith('\n…(truncated; read resource obsidian://vault-guide)')).toBe(true);
  });
  it('includes short guide untruncated', () => {
    const s = buildInstructions('hello guide');
    expect(s).toContain('## Vault guide (AGENTS.md)\nhello guide');
    expect(s).not.toContain('truncated');
  });
});
