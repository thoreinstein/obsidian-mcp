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
