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
  it("returns frontmatter dates as written", async () => {
    await fs.writeFile(path.join(vp, "a.md"), "---\ncreated: 2026-10-20\n---\nbody\n");
    expect(await runTool("obsidian_read_note", { file_path: "a.md", frontmatter_only: true }, ctx)).toContain("created: 2026-10-20\n");
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

  it('passes max_distance (MCP) and --max-distance (CLI) to search', async () => {
    const search = vi.fn(async () => []);
    ctx.indexer = { search } as any;
    await runTool('obsidian_rag_query', { query: 'q', max_distance: 1.2 }, ctx);
    expect(search).toHaveBeenLastCalledWith('q', expect.objectContaining({ maxDistance: 1.2 }));
    await runTool('obsidian_rag_query', { query: 'q', 'max-distance': '0.9' }, ctx);
    expect(search).toHaveBeenLastCalledWith('q', expect.objectContaining({ maxDistance: 0.9 }));
    await runTool('obsidian_rag_query', { query: 'q' }, ctx);
    expect(search).toHaveBeenLastCalledWith('q', expect.objectContaining({ maxDistance: undefined }));
  });

  it('rejects a non-positive or non-numeric max_distance', async () => {
    ctx.indexer = { search: vi.fn(async () => []) } as any;
    for (const bad of ['abc', true])
      await expect(runTool('obsidian_rag_query', { query: 'q', max_distance: bad }, ctx)).rejects.toThrow('"max_distance" must be a number');
    for (const bad of [-1, 0])
      await expect(runTool('obsidian_rag_query', { query: 'q', max_distance: bad }, ctx)).rejects.toThrow('max_distance must be a positive number');
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

describe("obsidian_search_notes regex/plain parity", () => {
  it("produces identical output for regex and plain modes", async () => {
    await fs.writeFile(path.join(vp, "a.md"), "one\n  Hello a  \nhello again");
    await fs.writeFile(path.join(vp, "sub", "hello.md"), "x\nhello b\nHELLO c");
    for (const limit of [2, 3, 50]) {
      const plain = await runTool("obsidian_search_notes", { query: "hello", regex: false, limit }, ctx);
      const re = await runTool("obsidian_search_notes", { query: "hello", regex: true, limit }, ctx);
      expect(re).toBe(plain);
    }
    const capped = await runTool("obsidian_search_notes", { query: "hello", regex: true, limit: 2 }, ctx);
    expect(capped).toContain("…truncated:");
    const full = await runTool("obsidian_search_notes", { query: "hello", regex: true }, ctx);
    expect(full).toContain("sub/hello.md (filename match)");
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

describe('links inside code are not links', () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(vp, 'a.md'), 'example: `[[b]]` and `[[Ghost]]`\n```\n[[b]]\n```\n');
  });
  it('get_backlinks ignores them', async () => {
    expect(await runTool('obsidian_get_backlinks', { file_name: 'b' }, ctx)).toBe('No backlinks found for "[[b]]".');
  });
  it('get_broken_links ignores them', async () => {
    expect(await runTool('obsidian_get_broken_links', {}, ctx)).toBe('No broken links found.');
  });
  it('get_orphans ignores them', async () => {
    expect(await runTool('obsidian_get_orphans', { subfolder: 'sub' }, ctx)).toBe('Found 1 orphan(s):\n- sub/b.md');
  });
});

describe('links to non-note files', () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(vp, 'sub', 'Check-ins.base'), 'views: []');
    await fs.writeFile(path.join(vp, 'sub', 'img.png'), '');
    await fs.writeFile(path.join(vp, 'a.md'), '[[Check-ins.base]] ![[img.png|200]] [[sub/img.png]] [[b.md]] [[gone.pdf]]');
  });
  it('get_broken_links resolves attachments and .md-suffixed links', async () => {
    expect(await runTool('obsidian_get_broken_links', {}, ctx)).toBe('Found 1 broken link(s):\n[[gone.pdf]] — in: a.md');
  });
  it('get_related shows where attachments resolve', async () => {
    ctx.indexer = { similarNotes: vi.fn(async () => []) } as any;
    const out = await runTool('obsidian_get_related', { file_path: 'a.md' }, ctx);
    expect(out).toContain('- [[Check-ins.base]] → sub/Check-ins.base');
    expect(out).toContain('- [[b.md]] → sub/b.md');
  });
});

describe('frontmatter checks on edit tools', () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(vp, '.obsidian-mcp-schema.json'), JSON.stringify({ rules: [{ prefix: '', required: ['type'], allowed: { type: ['plan'] } }] }));
  });
  it('replace_in_note refuses an edit that breaks frontmatter', async () => {
    const original = '---\ntype: plan\n---\nbody\n';
    await fs.writeFile(path.join(vp, 'a.md'), original);
    await expect(runTool('obsidian_replace_in_note', { file_path: 'a.md', old_text: 'type: plan', new_text: 'type: junk' }, ctx))
      .rejects.toThrow(/Frontmatter invalid for a\.md/);
    expect(await fs.readFile(path.join(vp, 'a.md'), 'utf-8')).toBe(original);
  });
  it('still allows body edits to a note whose frontmatter was already invalid', async () => {
    await fs.writeFile(path.join(vp, 'a.md'), '## H\nold\n');
    await runTool('obsidian_replace_section', { file_path: 'a.md', heading: 'H', content: 'new' }, ctx);
    await runTool('obsidian_insert_at_heading', { file_path: 'a.md', heading: 'H', content: 'more' }, ctx);
    await runTool('obsidian_replace_in_note', { file_path: 'a.md', old_text: 'new', new_text: 'newer' }, ctx);
    await runTool('obsidian_append_note', { file_path: 'a.md', content: 'tail' }, ctx);
    expect(await fs.readFile(path.join(vp, 'a.md'), 'utf-8')).toContain('tail');
  });
  it('allows body edits to a note with unparseable YAML but refuses breaking valid YAML', async () => {
    await fs.writeFile(path.join(vp, 'a.md'), '---\ntype: [oops\n---\nbody\n');
    await runTool('obsidian_append_note', { file_path: 'a.md', content: 'tail' }, ctx);
    await fs.writeFile(path.join(vp, 'sub', 'b.md'), '---\ntype: plan\n---\nbody\n');
    await expect(runTool('obsidian_replace_in_note', { file_path: 'sub/b.md', old_text: 'type: plan', new_text: 'type: [oops' }, ctx)).rejects.toThrow();
    expect(await fs.readFile(path.join(vp, 'sub', 'b.md'), 'utf-8')).toBe('---\ntype: plan\n---\nbody\n');
  });
  it('append_note refuses a missing note instead of creating it', async () => {
    await expect(runTool('obsidian_append_note', { file_path: 'typo.md', content: 'x' }, ctx)).rejects.toThrow('Note not found: typo.md');
    await expect(fs.access(path.join(vp, 'typo.md'))).rejects.toThrow();
  });
});

describe('write path policy', () => {
  for (const p of ['.obsidian/plugins/evil/main.js', '.obsidian/community-plugins.json', 'notes/.hidden/x.md', '.git/config', 'x.txt', 'Ideas/noext'])
    it(`create_note refuses ${p}`, async () => {
      await expect(runTool('obsidian_create_note', { file_path: p, content: 'x' }, ctx)).rejects.toThrow(/not writable|Not a writable note type/);
      await expect(fs.access(path.join(vp, p))).rejects.toThrow();
    });
  it('allows .base and .canvas', async () => {
    await runTool('obsidian_create_note', { file_path: 'views/a.base', content: 'filters: {}' }, ctx);
    await runTool('obsidian_create_note', { file_path: 'b.canvas', content: '{}' }, ctx);
    expect(reindex).not.toHaveBeenCalled();
  });
  it('move_note refuses a non-note or hidden destination and leaves the source', async () => {
    await expect(runTool('obsidian_move_note', { source_path: 'a.md', dest_path: 'a.txt' }, ctx)).rejects.toThrow(/Not a writable note type/);
    await expect(runTool('obsidian_move_note', { source_path: 'a.md', dest_path: '.trash/a.md' }, ctx)).rejects.toThrow(/not writable/);
    await fs.access(path.join(vp, 'a.md'));
  });
  it('append_note refuses an existing non-note file', async () => {
    await fs.mkdir(path.join(vp, '.obsidian'));
    await fs.writeFile(path.join(vp, '.obsidian', 'app.json'), '{}');
    await expect(runTool('obsidian_append_note', { file_path: '.obsidian/app.json', content: 'x' }, ctx)).rejects.toThrow(/not writable/);
    expect(await fs.readFile(path.join(vp, '.obsidian', 'app.json'), 'utf-8')).toBe('{}');
  });
  it('append_note refuses a symlink into a hidden non-note file', async () => {
    const target = path.join(vp, '.obsidian', 'plugins', 'evil', 'main.js');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'x');
    await fs.mkdir(path.join(vp, 'notes'));
    await fs.symlink(target, path.join(vp, 'notes', 'x.md'));
    await expect(runTool('obsidian_append_note', { file_path: 'notes/x.md', content: 'pwn' }, ctx)).rejects.toThrow(/not writable|Not a writable note type/);
    expect(await fs.readFile(target, 'utf-8')).toBe('x');
  });
  it('frontmatter and section tools refuse .canvas', async () => {
    await fs.writeFile(path.join(vp, 'b.canvas'), '{}');
    const calls: [string, Record<string, unknown>][] = [
      ['obsidian_update_frontmatter', { file_path: 'b.canvas', key: 'k', value: 'v' }],
      ['obsidian_replace_section', { file_path: 'b.canvas', heading: 'S', content: 'c' }],
      ['obsidian_insert_at_heading', { file_path: 'b.canvas', heading: 'S', content: 'c' }],
    ];
    for (const [tool, args] of calls) await expect(runTool(tool, args, ctx)).rejects.toThrow('Not a markdown note');
    expect(await fs.readFile(path.join(vp, 'b.canvas'), 'utf-8')).toBe('{}');
  });
  it('applies schema rules to ./ and ../ spellings', async () => {
    await fs.writeFile(path.join(vp, '.obsidian-mcp-schema.json'), JSON.stringify({ rules: [{ prefix: 'Engineering/', required: ['type'] }] }));
    for (const p of ['./Engineering/x.md', 'sub/../Engineering/y.md'])
      await expect(runTool('obsidian_create_note', { file_path: p, content: '# no type' }, ctx)).rejects.toThrow('missing required field "type"');
  });
  it('reindexes the normalized path', async () => {
    await runTool('obsidian_append_note', { file_path: './sub/../a.md', content: 'more' }, ctx);
    expect(reindex).toHaveBeenCalledWith(vp, 'a.md');
  });
});

describe('argument validation', () => {
  it('rejects replace_section without content and leaves the file unchanged', async () => {
    await expect(runTool('obsidian_replace_section', { file_path: 'a.md', heading: 'S' }, ctx)).rejects.toThrow('missing required "content"');
    expect(await fs.readFile(path.join(vp, 'a.md'), 'utf-8')).toBe('hello a');
  });
  it('rejects update_frontmatter with only file_path', async () => {
    await expect(runTool('obsidian_update_frontmatter', { file_path: 'a.md' }, ctx)).rejects.toThrow('pass "updates" or both "key" and "value"');
  });
  it('rejects an insert_at_heading position outside the enum', async () => {
    await expect(runTool('obsidian_insert_at_heading', { file_path: 'a.md', heading: 'S', content: 'x', position: 'sideways' }, ctx)).rejects.toThrow('must be one of: beginning, end');
  });
  it('rejects move_note without dest_path and keeps the source', async () => {
    await expect(runTool('obsidian_move_note', { source_path: 'a.md' }, ctx)).rejects.toThrow('missing required "dest_path"');
    await expect(fs.stat(path.join(vp, 'a.md'))).resolves.toBeTruthy();
  });
  it('accepts a CLI string for a number limit', async () => {
    await expect(runTool('obsidian_search_notes', { query: 'hello', limit: '10' }, ctx)).resolves.toContain('a.md:1');
  });
  it('rejects a non-numeric limit', async () => {
    await expect(runTool('obsidian_search_notes', { query: 'hello', limit: 'abc' }, ctx)).rejects.toThrow('"limit" must be a number');
  });
  it('clamps limit to 1..100', async () => {
    await fs.writeFile(path.join(vp, 'many.md'), Array.from({ length: 150 }, () => 'hello').join('\n'));
    const low = await runTool('obsidian_search_notes', { query: 'hello', limit: -5 }, ctx);
    expect(low.split('\n').filter((l) => /^\S+:\d+: /.test(l)).length).toBe(1);
    const high = await runTool('obsidian_search_notes', { query: 'hello', limit: 1e9 }, ctx);
    expect(high.split('\n').filter((l) => /^\S+:\d+: /.test(l)).length).toBe(100);
  });
});

describe('rag_index path', () => {
  it('indexes under the normalized relative path', async () => {
    const indexFile = vi.fn(async () => ({ success: true }));
    await runTool('obsidian_rag_index', { file_path: './sub/../a.md' }, { ...ctx, indexer: { indexFile } as any });
    expect(indexFile).toHaveBeenCalledWith(vp, 'a.md');
  });
});
