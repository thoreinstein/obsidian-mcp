import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runTool, TOOL_DEFINITIONS, UnknownToolError, type ToolContext } from './tools.js';

let vp: string;
let ctx: ToolContext;
let reindex: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vp = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-test-'));
  await fs.writeFile(path.join(vp, 'a.md'), 'hello a');
  await fs.mkdir(path.join(vp, 'sub'));
  await fs.writeFile(path.join(vp, 'sub', 'b.md'), 'hello b');
  reindex = vi.fn();
  ctx = {
    getVaultPath: (o?: string) => o || vp,
    setVaultPath: vi.fn(async () => {}),
    indexer: {} as any,
    reindex: reindex as any,
  };
});

afterEach(async () => {
  await fs.rm(vp, { recursive: true, force: true });
});

describe('runTool', () => {
  it("reads one section by heading", async () => {
    await fs.writeFile(path.join(vp, "a.md"), "---\nk: v\n---\n# T\nintro\n## S\nsec body\n## U\nother\n");
    const out = await runTool("obsidian_read_note", { file_path: "a.md", heading: "S" }, ctx);
    expect(out).toBe("## S\nsec body");
    expect(out).not.toContain("other");
  });
  it("includes subsections and stops at the next same-or-higher heading", async () => {
    await fs.writeFile(path.join(vp, "a.md"), "# T\n## S\nbody\n### Sub\nsubtext\n## Next\nnextbody\n");
    const out = await runTool("obsidian_read_note", { file_path: "a.md", heading: "S" }, ctx);
    expect(out).toBe("## S\nbody\n### Sub\nsubtext");
    await fs.writeFile(path.join(vp, "a.md"), "## S\nbody\n# Top\ntop\n");
    expect(await runTool("obsidian_read_note", { file_path: "a.md", heading: "S" }, ctx)).toBe("## S\nbody");
  });
  it("ignores headings inside fenced code in sections and outline", async () => {
    const md = "## S\nbefore\n```\n# fake\n```\nafter\n## Next\n";
    await fs.writeFile(path.join(vp, "a.md"), md);
    const out = await runTool("obsidian_read_note", { file_path: "a.md", heading: "S" }, ctx);
    expect(out).toContain("# fake");
    expect(out).toContain("after");
    expect(out).not.toContain("Next");
    const o = JSON.parse(await runTool("obsidian_get_note_outline", { file_path: "a.md" }, ctx));
    expect(o.headings.map((h: any) => h.text)).toEqual(["S", "Next"]);
  });
  it("returns the first section when heading text repeats", async () => {
    await fs.writeFile(path.join(vp, "a.md"), "## S\nfirst\n## S\nsecond\n");
    expect(await runTool("obsidian_read_note", { file_path: "a.md", heading: "S" }, ctx)).toBe("## S\nfirst");
  });
  it("rejects a missing heading listing the headings", async () => {
    await fs.writeFile(path.join(vp, "a.md"), "# T\nx\n## S\ny\n");
    await expect(runTool("obsidian_read_note", { file_path: "a.md", heading: "Nope" }, ctx)).rejects.toThrow(/Headings: T, S/);
  });
  it("returns frontmatter only as YAML", async () => {
    await fs.writeFile(path.join(vp, "a.md"), "---\ntype: plan\n---\nbody\n");
    const out = await runTool("obsidian_read_note", { file_path: "a.md", frontmatter_only: true }, ctx);
    expect(out).toContain("type: plan");
    expect(out).not.toContain("body");
    expect(await runTool("obsidian_read_note", { file_path: "sub/b.md", frontmatter_only: true }, ctx)).toBe("");
  });
  it("returns a note outline", async () => {
    await fs.writeFile(path.join(vp, "a.md"), "# T\nsee [[X]]\n");
    const o = JSON.parse(await runTool("obsidian_get_note_outline", { file_path: "a.md" }, ctx));
    expect(o.headings[0].text).toBe("T");
    expect(o.links).toEqual(["X"]);
  });
  it('reads a note', async () => {
    expect(await runTool('obsidian_read_note', { file_path: 'a.md' }, ctx)).toBe('hello a');
  });
  it('lists notes in a subfolder', async () => {
    const out = await runTool('obsidian_list_notes', { subfolder: 'sub' }, ctx);
    expect(out).toContain('sub/b.md');
    expect(out).not.toContain('a.md');
  });
  it('creates a note and reindexes', async () => {
    await runTool('obsidian_create_note', { file_path: 'c.md', content: 'x' }, ctx);
    expect(await fs.readFile(path.join(vp, 'c.md'), 'utf-8')).toBe('x');
    expect(reindex).toHaveBeenCalledWith(vp, 'c.md');
  });
  it('rejects unknown tools', async () => {
    await expect(runTool('nope', {}, ctx)).rejects.toBeInstanceOf(UnknownToolError);
  });
  it('coerces CLI string force_reindex', async () => {
    const indexVault = vi.fn(async () => ({ ok: true }));
    ctx.indexer = { indexVault } as any;
    await runTool('obsidian_rag_index', { force_reindex: 'true' }, ctx);
    expect(indexVault).toHaveBeenCalledWith(vp, true);
  });
  it('passes RAG filters and prints Section only for headed hits', async () => {
    const search = vi.fn(async () => [
      { path: 'working/p.md', heading: 'Plan > Steps', text: 'do it', date: '2026-10-01', status: '', type: 'plan' },
      { path: 'top.md', heading: '', text: 'intro', date: '', status: '', type: '' },
    ]);
    ctx.indexer = { search } as any;
    const out = await runTool('obsidian_rag_query', { query: 'q', limit: '3', folder: 'working', type: 'plan', after: '2026-01-01' }, ctx);
    expect(search).toHaveBeenCalledWith('q', { limit: 3, folder: 'working', type: 'plan', status: undefined, after: '2026-01-01' });
    expect(out).toContain('File: working/p.md\nMeta: working · 2026-10-01 · type: plan\nSection: Plan > Steps\nContent: do it');
    expect(out).toContain('File: top.md\nMeta: (root)\nContent: intro');
    expect(out).not.toContain('Relevance');
  });
});

describe("obsidian_search_notes", () => {
  it("returns path:line: text, scopes by folder, and truncates at limit", async () => {
    await fs.writeFile(path.join(vp, "a.md"), "one\n  Hello a  \nhello again");
    await fs.writeFile(path.join(vp, "sub", "b.md"), "hello b");
    const all = await runTool("obsidian_search_notes", { query: "hello" }, ctx);
    expect(all.split("\n").sort()).toEqual(["a.md:2: Hello a", "a.md:3: hello again", "sub/b.md:1: hello b"]);
    const scoped = await runTool("obsidian_search_notes", { query: "hello", folder: "sub" }, ctx);
    expect(scoped).toBe("sub/b.md:1: hello b");
    const capped = await runTool("obsidian_search_notes", { query: "hello", limit: 1 }, ctx);
    const lines = capped.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("…truncated: 2 more matching lines in 2 files");
  });
});

describe("obsidian_search_notes filename matches", () => {
  it("counts filename hits toward limit and matches basename only", async () => {
    await fs.mkdir(path.join(vp, "foo"));
    for (let i = 0; i < 30; i++) await fs.writeFile(path.join(vp, "foo", `foo-${i}.md`), "x");
    await fs.writeFile(path.join(vp, "foo", "other.md"), "x");
    const out = await runTool("obsidian_search_notes", { query: "foo", limit: 5 }, ctx);
    const lines = out.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines.slice(0, 5).every(l => l.endsWith("(filename match)"))).toBe(true);
    expect(out).not.toContain("other.md");
    expect(lines[5]).toBe("…truncated: 25 more matching lines in 25 files");
  });
});

describe('TOOL_DEFINITIONS', () => {
  it('has unique names', () => {
    const names = TOOL_DEFINITIONS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('obsidian_get_related', () => {
  it('lists resolved and unresolved links out, backlinks and similar notes', async () => {
    await fs.writeFile(path.join(vp, 'a.md'), 'see [[b]] and [[Ghost#H]]');
    await fs.writeFile(path.join(vp, 'sub', 'b.md'), 'back to [[a]]');
    const similarNotes = vi.fn(async () => [{ path: 'sub/b.md', title: 'B', date: '', status: '', type: '' }]);
    ctx.indexer = { similarNotes } as any;
    const out = await runTool('obsidian_get_related', { file_path: 'a.md' }, ctx);
    expect(similarNotes).toHaveBeenCalledWith('a.md', 5);
    expect(out).toContain('## Links out\n- [[b]] → sub/b.md\n- [[Ghost]] → (unresolved)');
    expect(out).toContain('## Backlinks\n- sub/b.md');
    expect(out).toContain('## Similar\n- sub/b.md — sub');
  });
});

describe('obsidian_get_related path-style links', () => {
  it('resolves [[folder/note]] case-insensitively', async () => {
    await fs.writeFile(path.join(vp, 'a.md'), 'see [[Sub/B]] and [[nope/b]]');
    ctx.indexer = { similarNotes: vi.fn(async () => []) } as any;
    const out = await runTool('obsidian_get_related', { file_path: 'a.md' }, ctx);
    expect(out).toContain('- [[Sub/B]] → sub/b.md');
    expect(out).toContain('- [[nope/b]] → (unresolved)');
  });
});

describe('frontmatter schema enforcement', () => {
  const schema = { exclude: ['engram/'], rules: [{ prefix: '', required: ['type'], allowed: { type: ['plan', 'pattern'] } }] };
  beforeEach(async () => {
    await fs.writeFile(path.join(vp, '.obsidian-mcp-schema.json'), JSON.stringify(schema));
  });

  it('update_frontmatter rejects disallowed value and leaves file unchanged', async () => {
    const original = '---\ntype: plan\n---\nbody\n';
    await fs.writeFile(path.join(vp, 'a.md'), original);
    await expect(runTool('obsidian_update_frontmatter', { file_path: 'a.md', key: 'type', value: 'adr' }, ctx))
      .rejects.toThrow(/Frontmatter invalid for a\.md: .*"adr" not allowed/);
    expect(await fs.readFile(path.join(vp, 'a.md'), 'utf-8')).toBe(original);
  });

  it('rejected update does not leak into later frontmatter reads', async () => {
    await fs.writeFile(path.join(vp, 'a.md'), '---\ntype: plan\n---\nbody\n');
    await runTool('obsidian_read_note', { file_path: 'a.md', frontmatter_only: true }, ctx);
    await expect(runTool('obsidian_update_frontmatter', { file_path: 'a.md', key: 'type', value: 'adr' }, ctx)).rejects.toThrow();
    const fm = await runTool('obsidian_read_note', { file_path: 'a.md', frontmatter_only: true }, ctx);
    expect(fm).toContain('type: plan');
    expect(fm).not.toContain('adr');
  });

  it('create_note rejects invalid content and writes nothing', async () => {
    await expect(runTool('obsidian_create_note', { file_path: 'new.md', content: 'no fm' }, ctx))
      .rejects.toThrow(/missing required field "type"/);
    await expect(fs.access(path.join(vp, 'new.md'))).rejects.toThrow();
  });

  it('create_note accepts valid content and excluded paths', async () => {
    await runTool('obsidian_create_note', { file_path: 'ok.md', content: '---\ntype: plan\n---\n' }, ctx);
    await runTool('obsidian_create_note', { file_path: 'engram/x.md', content: 'no fm' }, ctx);
    await expect(fs.access(path.join(vp, 'ok.md'))).resolves.toBeUndefined();
  });
});

describe('vault path containment', () => {
  let outside: string;
  beforeEach(async () => {
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-outside-'));
    await fs.writeFile(path.join(outside, 'secret.md'), 'outside content');
    await fs.symlink(outside, path.join(vp, 'link'));
  });
  afterEach(async () => {
    await fs.rm(outside, { recursive: true, force: true });
  });

  const cases: Array<[string, (o: string) => string]> = [
    ["../outside.md", () => "../outside.md"],
    ["sub/../../outside.md", () => "sub/../../outside.md"],
    ["absolute outside path", (o) => path.join(o, "secret.md")],
    ["symlink inside vault", () => "link/secret.md"],
  ];

  for (const [label, mk] of cases) {
    it(`read refuses ${label}`, async () => {
      await expect(runTool("obsidian_read_note", { file_path: mk(outside) }, ctx)).rejects.toThrow("Path escapes vault");
    });
    it(`create refuses ${label}`, async () => {
      await expect(runTool("obsidian_create_note", { file_path: mk(outside).replace("secret", "new"), content: "x" }, ctx)).rejects.toThrow("Path escapes vault");
      await expect(fs.access(path.join(outside, "new.md"))).rejects.toThrow();
    });
    it(`move destination refuses ${label}`, async () => {
      await expect(runTool("obsidian_move_note", { source_path: "a.md", dest_path: mk(outside).replace("secret", "moved") }, ctx)).rejects.toThrow("Path escapes vault");
      await fs.access(path.join(vp, "a.md"));
    });
  }

  it('move source refuses a path outside the vault', async () => {
    await expect(runTool('obsidian_move_note', { source_path: '../outside.md', dest_path: 'x.md' }, ctx)).rejects.toThrow('Path escapes vault');
  });
  it('list_notes refuses an outside subfolder', async () => {
    await expect(runTool('obsidian_list_notes', { subfolder: '..' }, ctx)).rejects.toThrow('Path escapes vault');
  });
  it('rag index_file refuses an outside path', async () => {
    await expect(runTool('obsidian_rag_index', { file_path: '../outside.md' }, ctx)).rejects.toThrow('Path escapes vault');
  });
  it('still works for normal nested paths, including new files', async () => {
    expect(await runTool('obsidian_read_note', { file_path: 'sub/b.md' }, ctx)).toBe('hello b');
    await runTool('obsidian_create_note', { file_path: 'new/deep/c.md', content: 'c' }, ctx);
    expect(await fs.readFile(path.join(vp, 'new/deep/c.md'), 'utf-8')).toBe('c');
    await runTool('obsidian_move_note', { source_path: 'new/deep/c.md', dest_path: 'moved/c.md' }, ctx);
    expect(await fs.readFile(path.join(vp, 'moved/c.md'), 'utf-8')).toBe('c');
  });
});

describe('no silent overwrites', () => {
  it('create_note refuses an existing note and leaves it unchanged', async () => {
    await expect(runTool('obsidian_create_note', { file_path: 'a.md', content: 'new' }, ctx)).rejects.toThrow('Note already exists: a.md');
    expect(await fs.readFile(path.join(vp, 'a.md'), 'utf-8')).toBe('hello a');
    expect(reindex).not.toHaveBeenCalled();
  });
  it('move_note refuses an existing destination and leaves both notes', async () => {
    await expect(runTool('obsidian_move_note', { source_path: 'a.md', dest_path: 'sub/b.md' }, ctx)).rejects.toThrow('Destination already exists: sub/b.md');
    expect(await fs.readFile(path.join(vp, 'a.md'), 'utf-8')).toBe('hello a');
    expect(await fs.readFile(path.join(vp, 'sub', 'b.md'), 'utf-8')).toBe('hello b');
  });
  it('move_note still allows a case-only rename', async () => {
    await runTool('obsidian_move_note', { source_path: 'a.md', dest_path: 'A.md' }, ctx);
    expect(await fs.readdir(vp)).toContain('A.md');
  });
});

describe('readonly paths', () => {
  const original = '---\ntype: plan\n---\n## H\nbody\n';
  beforeEach(async () => {
    await fs.writeFile(path.join(vp, '.obsidian-mcp-schema.json'), JSON.stringify({ readonly: ['engram/'], rules: [] }));
    await fs.mkdir(path.join(vp, 'engram'));
    await fs.writeFile(path.join(vp, 'engram', 'm.md'), original);
    await fs.symlink(path.join(vp, 'engram'), path.join(vp, 'alias'));
  });

  const writes: Array<[string, Record<string, unknown>]> = [
    ['obsidian_create_note', { file_path: 'engram/new.md', content: 'x' }],
    ['obsidian_append_note', { file_path: 'engram/m.md', content: 'x' }],
    ['obsidian_update_frontmatter', { file_path: 'engram/m.md', key: 'status', value: 'done' }],
    ['obsidian_replace_section', { file_path: 'engram/m.md', heading: 'H', content: 'x' }],
    ['obsidian_insert_at_heading', { file_path: 'engram/m.md', heading: 'H', content: 'x' }],
    ['obsidian_replace_in_note', { file_path: 'engram/m.md', old_text: 'body', new_text: 'x' }],
    ['obsidian_move_note', { source_path: 'engram/m.md', dest_path: 'm.md' }],
    ['obsidian_move_note', { source_path: 'a.md', dest_path: 'engram/a.md' }],
    ['obsidian_create_note', { file_path: 'sub/../engram/sneaky.md', content: 'x' }],
    ['obsidian_create_note', { file_path: 'Engram/case.md', content: 'x' }],
    ['obsidian_append_note', { file_path: 'ENGRAM/m.md', content: 'x' }],
    ['obsidian_create_note', { file_path: 'alias/via-link.md', content: 'x' }],
    ['obsidian_append_note', { file_path: 'alias/m.md', content: 'x' }],
  ];
  for (const [tool, args] of writes) {
    it(`${tool} refuses ${JSON.stringify(args)}`, async () => {
      await expect(runTool(tool, args, ctx)).rejects.toThrow(/is read-only/);
      expect(await fs.readFile(path.join(vp, 'engram', 'm.md'), 'utf-8')).toBe(original);
      expect((await fs.readdir(path.join(vp, 'engram'))).sort()).toEqual(['m.md']);
      expect(await fs.readFile(path.join(vp, 'a.md'), 'utf-8')).toBe('hello a');
    });
  }

  it('still allows writes outside readonly prefixes and reads inside them', async () => {
    await runTool('obsidian_append_note', { file_path: 'a.md', content: 'more' }, ctx);
    expect(await runTool('obsidian_read_note', { file_path: 'engram/m.md' }, ctx)).toBe(original);
  });

  it('exempts the daily note tools', async () => {
    await fs.writeFile(path.join(vp, '.obsidian-mcp-schema.json'), JSON.stringify({ readonly: ['Daily/'], rules: [] }));
    await fs.mkdir(path.join(vp, '.obsidian'));
    await fs.writeFile(path.join(vp, '.obsidian', 'daily-notes.json'), JSON.stringify({ folder: 'Daily' }));
    await runTool('obsidian_append_daily_log', { heading: 'Log', content: 'did a thing' }, ctx);
    const [daily] = await fs.readdir(path.join(vp, 'Daily'));
    expect(await fs.readFile(path.join(vp, 'Daily', daily), 'utf-8')).toContain('did a thing');
  });
});

describe('obsidian_get_broken_links path-style links', () => {
  it('resolves [[folder/note]] and still flags missing ones', async () => {
    await fs.writeFile(path.join(vp, 'a.md'), 'see [[Sub/B]], [[sub/b#H|alias]] and [[nope/b]]');
    const out = await runTool('obsidian_get_broken_links', {}, ctx);
    expect(out).toContain('Found 1 broken link(s)');
    expect(out).toContain('[[nope/b]] — in: a.md');
  });
});

describe('obsidian_move_note link updates', () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(vp, 'a.md'), 'see [[b]], [[sub/b#H|alias]] and ![[B]]');
  });
  it('rewrites inbound links to the new name and path', async () => {
    const out = await runTool('obsidian_move_note', { source_path: 'sub/b.md', dest_path: 'archive/c.md' }, ctx);
    expect(await fs.readFile(path.join(vp, 'a.md'), 'utf-8')).toBe('see [[c]], [[archive/c#H|alias]] and ![[c]]');
    expect(out).toContain('updated links in 1 note');
    expect(reindex).toHaveBeenCalledWith(vp, 'a.md');
  });
  it('leaves links alone when update_links is false', async () => {
    await runTool('obsidian_move_note', { source_path: 'sub/b.md', dest_path: 'c.md', update_links: 'false' }, ctx);
    expect(await fs.readFile(path.join(vp, 'a.md'), 'utf-8')).toBe('see [[b]], [[sub/b#H|alias]] and ![[B]]');
  });
  it('only rewrites path-style links when the old name is not unique', async () => {
    await fs.writeFile(path.join(vp, 'b.md'), 'another b');
    await runTool('obsidian_move_note', { source_path: 'sub/b.md', dest_path: 'c.md' }, ctx);
    expect(await fs.readFile(path.join(vp, 'a.md'), 'utf-8')).toBe('see [[b]], [[c#H|alias]] and ![[B]]');
  });
  it('skips read-only notes and says so', async () => {
    await fs.writeFile(path.join(vp, '.obsidian-mcp-schema.json'), JSON.stringify({ readonly: ['engram/'], rules: [] }));
    await fs.mkdir(path.join(vp, 'engram'));
    await fs.writeFile(path.join(vp, 'engram', 'm.md'), 'ref [[b]]');
    const out = await runTool('obsidian_move_note', { source_path: 'sub/b.md', dest_path: 'c.md' }, ctx);
    expect(await fs.readFile(path.join(vp, 'engram', 'm.md'), 'utf-8')).toBe('ref [[b]]');
    expect(out).toContain('left links in 1 read-only note unchanged: engram/m.md');
  });
});

describe('obsidian_list_notes frontmatter filters', () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(vp, 'a.md'), '---\ntype: plan\nstatus: complete\n---\n');
    await fs.writeFile(path.join(vp, 'sub', 'b.md'), '---\ntype: plan\nstatus: active\n---\n');
    await fs.writeFile(path.join(vp, 'sub', 'c.md'), '---\ntype: spec\nstatus: complete\n---\n');
  });
  it('filters by type and status', async () => {
    expect(JSON.parse(await runTool('obsidian_list_notes', { type: 'plan' }, ctx)).sort()).toEqual(['a.md', 'sub/b.md']);
    expect(JSON.parse(await runTool('obsidian_list_notes', { type: 'plan', status: 'complete' }, ctx))).toEqual(['a.md']);
    expect(JSON.parse(await runTool('obsidian_list_notes', { subfolder: 'sub', status: 'complete' }, ctx))).toEqual(['sub/c.md']);
  });
});

describe('obsidian_get_orphans', () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(vp, 'MOCs'));
    await fs.writeFile(path.join(vp, 'MOCs', 'Home.md'), 'see [[b#H|B]]');
    await fs.writeFile(path.join(vp, 'a.md'), 'self [[a]] and [[sub/c]]');
    await fs.writeFile(path.join(vp, 'sub', 'c.md'), 'no links');
  });
  it('lists notes nothing else links to, ignoring self-links', async () => {
    const out = await runTool('obsidian_get_orphans', {}, ctx);
    expect(out).toBe('Found 2 orphan(s):\n- MOCs/Home.md\n- a.md');
  });
  it('scopes candidates by subfolder and sources by linked_from', async () => {
    expect(await runTool('obsidian_get_orphans', { subfolder: 'sub', linked_from: 'MOCs/' }, ctx)).toBe('Found 1 orphan(s):\n- sub/c.md');
    expect(await runTool('obsidian_get_orphans', { subfolder: 'sub' }, ctx)).toBe('No orphans found.');
  });
});
