import { describe, it, expect } from 'vitest';
import * as path from 'path';
import matter from 'gray-matter';
import {
  listNotesPattern,
  replaceInNote,
  stripHeadingFromLink,
  applyFrontmatterUpdate,
  formatResultMeta,
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
