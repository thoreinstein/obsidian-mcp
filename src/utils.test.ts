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
