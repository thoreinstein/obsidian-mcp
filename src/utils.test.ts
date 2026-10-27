import { describe, it, expect } from 'vitest';
import { validateFrontmatter, loadVaultSchema, type VaultSchema } from './utils.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import matter from 'gray-matter';
import {
  listNotesPattern,
  parseCliArgs,
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
  rewriteWikilinks,
  extractWikilinks,
  buildLinkResolver,
  isInside,
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
  it('keeps YAML dates exactly as written', () => {
    const out = applyFrontmatterUpdate('---\ncreated: 2026-10-20\nstatus: approved\n---\nbody\n', { key: 'status', value: 'complete' });
    expect(out).toBe('---\ncreated: 2026-10-20\nstatus: complete\n---\nbody\n');
  });
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

describe('noteOutline dates', () => {
  it('noteOutline returns dates as written', () => {
    const o = noteOutline('---\ncreated: 2026-10-20\n---\n# T\n');
    expect(o.frontmatter.created).toBe('2026-10-20');
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

describe('validateFrontmatter', () => {
  const s: VaultSchema = { exclude: ['engram/'], rules: [{ prefix: '', required: ['type'], allowed: { type: ['plan', 'pattern'] } }] };
  it('accepts an allowed value', () => {
    expect(validateFrontmatter('a.md', '---\ntype: plan\n---\n', s)).toEqual([]);
  });
  it('rejects a value outside the allowed list', () => {
    const errs = validateFrontmatter('a.md', '---\ntype: adr\n---\n', s);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/"adr" not allowed/);
  });
  it('accepts type: plan and rejects numeric type: 2026 with the allowed list', () => {
    const s1: VaultSchema = { rules: [{ prefix: '', required: ['type'], allowed: { type: ['plan'] } }] };
    expect(validateFrontmatter('a.md', '---\ntype: plan\n---\n', s1)).toEqual([]);
    const errs = validateFrontmatter('a.md', '---\ntype: 2026\n---\n', s1);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/plan/);
  });
  it('reports missing required field', () => {
    expect(validateFrontmatter('a.md', 'no fm', s)).toEqual(['missing required field "type"']);
  });
  it('skips excluded prefixes', () => {
    expect(validateFrontmatter('engram/x.md', 'no fm', s)).toEqual([]);
  });
  it('rejects array and non-string values', () => {
    expect(validateFrontmatter('a.md', '---\ntype: [plan]\n---\n', s)).toHaveLength(1);
    expect(validateFrontmatter('a.md', '---\ntype: 3\n---\n', s)).toHaveLength(1);
  });
  it('does not check allowed values for absent optional fields', () => {
    const s2: VaultSchema = { rules: [{ prefix: '', allowed: { status: ['a'] } }] };
    expect(validateFrontmatter('a.md', 'x', s2)).toEqual([]);
  });
  it('first matching prefix wins', () => {
    const s3: VaultSchema = { rules: [{ prefix: 'x/', required: [] }, { prefix: '', required: ['type'] }] };
    expect(validateFrontmatter('x/a.md', 'x', s3)).toEqual([]);
  });
});

describe('loadVaultSchema', () => {
  it('returns null when no schema file, parses old format when present', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schema-'));
    expect(await loadVaultSchema(dir)).toBeNull();
    await fs.writeFile(path.join(dir, '.obsidian-mcp-schema.json'), JSON.stringify({ rules: [{ prefix: 'a/', required: ['x'] }] }));
    expect((await loadVaultSchema(dir))!.rules[0].prefix).toBe('a/');
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('rewriteWikilinks', () => {
  const from = { name: 'Old', path: 'working/Old' };
  const to = { name: 'New', path: 'archive/New' };
  it('rewrites bare links keeping embeds, headings and aliases', () => {
    expect(rewriteWikilinks('[[Old]] ![[old]] [[Old#H|see]] [[Older]] [[Other|Old]]', from, to, true))
      .toBe('[[New]] ![[New]] [[New#H|see]] [[Older]] [[Other|Old]]');
  });
  it('rewrites matching path-style links to the new path', () => {
    expect(rewriteWikilinks('[[working/old#H]] [[other/Old]]', from, to, true)).toBe('[[archive/New#H]] [[other/Old]]');
  });
  it('leaves bare links alone when rewriteBare is false', () => {
    expect(rewriteWikilinks('[[Old]] [[working/Old]]', from, to, false)).toBe('[[Old]] [[archive/New]]');
  });
});

describe('wikilinks in code', () => {
  const md = 'real [[A]] and `[[B]]`\n```\n[[C]]\n```\n~~~md\n[[D]] ```\n~~~\nafter [[E]] ``x [[F]]``\n';
  it('extractWikilinks returns [] for content without links', () => {
    expect(extractWikilinks('plain text')).toEqual([]);
    expect(extractWikilinks('a [single] bracket [ here')).toEqual([]);
  });

  it('extractWikilinks skips inline code and fenced blocks', () => {
    expect(extractWikilinks(md)).toEqual(['A', 'E']);
  });
  it('rewriteWikilinks leaves links in code unchanged', () => {
    const from = { name: 'C', path: 'x/C' }, to = { name: 'Z', path: 'x/Z' };
    expect(rewriteWikilinks('[[C]] `[[C]]`\n```\n[[C]]\n```\n[[C]]', from, to, true)).toBe('[[Z]] `[[C]]`\n```\n[[C]]\n```\n[[Z]]');
  });
  it('treats an unclosed fence as code to the end', () => {
    expect(extractWikilinks('[[A]]\n```\n[[B]]')).toEqual(['A']);
  });
});

describe('parseCliArgs', () => {
  it('keeps a value that starts with ---', () => {
    expect(parseCliArgs(['--content', '---\ntype: note\n---\n'])).toEqual({ content: '---\ntype: note\n---\n' });
  });
  it('supports --key=value, including empty and embedded =', () => {
    expect(parseCliArgs(['--content=---x'])).toEqual({ content: '---x' });
    expect(parseCliArgs(['--a=', '--b=x=y'])).toEqual({ a: '', b: 'x=y' });
  });
  it('treats a lone flag as true', () => {
    expect(parseCliArgs(['--force'])).toEqual({ force: true });
    expect(parseCliArgs(['--hook'])).toEqual({ hook: true });
  });
  it('treats a flag followed by a flag as true', () => {
    expect(parseCliArgs(['--a', '--b', 'v'])).toEqual({ a: true, b: 'v' });
  });
  it('parses existing hook and eval call patterns', () => {
    expect(parseCliArgs(['--hook'])).toEqual({ hook: true });
    expect(parseCliArgs(['--file', 'x.json'])).toEqual({ file: 'x.json' });
  });
  it('ignores stray non-flag tokens', () => {
    expect(parseCliArgs(['stray', '--a', 'v', 'extra'])).toEqual({ a: 'v' });
  });
});

describe('buildLinkResolver duplicates', () => {
  it('bare links prefer the note in the same folder', () => {
    const r = buildLinkResolver(['a/x.md', 'b/x.md']);
    expect(r('x', 'b/note.md')).toBe('b/x.md');
    expect(r('x', 'a/note.md')).toBe('a/x.md');
  });

  it('bare links prefer the shallowest path, then alphabetical', () => {
    expect(buildLinkResolver(['deep/er/x.md', 'x.md'])('x', 'z/n.md')).toBe('x.md');
    expect(buildLinkResolver(['m/x.md', 'k/x.md'])('x', 'z/n.md')).toBe('k/x.md');
    expect(buildLinkResolver(['m/x.md', 'k/x.md'])('x')).toBe('k/x.md');
  });

  it('resolution does not depend on input order', () => {
    const files = ['m/x.md', 'k/x.md', 'x.md', 'deep/er/x.md', 'q/y.md', 'p/y.md'];
    const expected = ['x.md', 'p/y.md'];
    for (let i = 0; i < 20; i++) {
      const shuffled = [...files].sort(() => Math.random() - 0.5);
      const r = buildLinkResolver(shuffled);
      expect([r('x', 'z/n.md'), r('y', 'z/n.md')]).toEqual(expected);
    }
  });
});

describe('isInside', () => {
  it('accepts paths under a filesystem root', () => {
    expect(isInside(path.parse(process.cwd()).root, process.cwd())).toBe(true);
  });
});
