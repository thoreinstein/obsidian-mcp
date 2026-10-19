import * as path from 'path';
import * as fs from 'fs/promises';
import matter from 'gray-matter';

/**
 * Extract deduplicated wikilink targets from markdown content.
 * Handles [[Simple]] and [[Link|Alias]] forms.
 */
export function extractWikilinks(content: string): string[] {
  const regex = /\[\[(.*?)(?:\|.*?)?\]\]/g;
  const links: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1]);
  }
  return [...new Set(links)];
}

export interface SectionRange {
  headingStart: number;
  headingEnd: number;
  bodyStart: number;
  bodyEnd: number;
  level: number;
}

/**
 * Find the range of a section under a heading in markdown content.
 * Returns null if heading not found.
 */
export function findSectionRange(content: string, heading: string): SectionRange | null {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRegex = new RegExp(`^(#{1,6})\\s+${escapedHeading}\\s*$`, 'm');
  const match = headingRegex.exec(content);
  if (!match) return null;

  const level = match[1].length;
  const headingStart = match.index;
  const headingEnd = headingStart + match[0].length;
  const bodyStart = headingEnd;

  // Find next heading at same or higher level (fewer or equal #'s)
  const rest = content.slice(bodyStart);
  const nextHeadingRegex = new RegExp(`^#{1,${level}}\\s`, 'm');
  const nextMatch = nextHeadingRegex.exec(rest);
  const bodyEnd = nextMatch ? bodyStart + nextMatch.index : content.length;

  return { headingStart, headingEnd, bodyStart, bodyEnd, level };
}

/**
 * Replace the body under a heading, preserving the heading line itself.
 * Returns the updated file content.
 */
export function replaceSection(fileContent: string, range: SectionRange, newBody: string): string {
  return fileContent.slice(0, range.bodyStart) + '\n' + newBody + '\n' + fileContent.slice(range.bodyEnd);
}

/**
 * Insert content under a heading at the given position.
 * If range is null (heading not found), appends a new ## section.
 * Returns the updated file content.
 */
export function insertAtHeading(
  fileContent: string,
  heading: string,
  content: string,
  position: 'beginning' | 'end',
  range: SectionRange | null,
): string {
  if (range) {
    if (position === 'beginning') {
      return fileContent.slice(0, range.bodyStart) + '\n' + content + fileContent.slice(range.bodyStart);
    }
    const before = fileContent.slice(0, range.bodyEnd);
    const sep = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
    return before + sep + content + '\n' + fileContent.slice(range.bodyEnd);
  }
  return fileContent + `\n\n## ${heading}\n${content}`;
}

/** Build the glob pattern for obsidian_list_notes. Recurses into subfolder when given. */
export function listNotesPattern(subfolder?: string): string {
  return subfolder ? path.join(subfolder, '**', '*.md') : '**/*.md';
}

/** Replace the first occurrence of oldText with newText. Throws if not found. */
export function replaceInNote(content: string, oldText: string, newText: string): string {
  const idx = content.indexOf(oldText);
  if (idx === -1) throw new Error(`Text not found: "${oldText}"`);
  return content.slice(0, idx) + newText + content.slice(idx + oldText.length);
}

/** Strip the #heading fragment from a wikilink target. */
export function stripHeadingFromLink(link: string): string {
  const idx = link.indexOf('#');
  return idx === -1 ? link : link.slice(0, idx);
}

type FrontmatterUpdate =
  | { key: string; value: string; updates?: never }
  | { updates: Record<string, unknown>; key?: never; value?: never };

/** Apply a single key/value or a batch of updates to YAML frontmatter. Returns updated file content. */
export function applyFrontmatterUpdate(fileContent: string, update: FrontmatterUpdate): string {
  const parsed = matter(fileContent);
  // gray-matter caches parsed.data by content; mutate a copy so a rejected update can't poison later reads.
  const data = { ...parsed.data };
  if (update.updates) {
    for (const [k, v] of Object.entries(update.updates)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      data[k] = v;
    }
  } else {
    let value: unknown = update.value;
    try { value = JSON.parse(String(update.value)); } catch { /* use as string */ }
    data[update.key] = value;
  }
  return matter.stringify(parsed.content, data);
}

/**
 * One-line label for a RAG hit: top-level folder, date, status, and type.
 * Lets the caller tell an archived proposal from a live note without opening it.
 */
export function formatResultMeta(r: { path: string; date?: string; status?: string; type?: string }): string {
  const folder = r.path.includes('/') ? r.path.split('/')[0] : '(root)';
  const parts = [folder];
  if (r.date) parts.push(r.date);
  if (r.status) parts.push(`status: ${r.status}`);
  if (r.type) parts.push(`type: ${r.type}`);
  return parts.join(' · ');
}

/**
 * Keep only the best-ranked hit per note so one long note can't fill every result slot.
 * Expects hits already sorted best-first.
 */
export function dedupeByPath<T extends { path: string }>(hits: T[], limit: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const hit of hits) {
    if (seen.has(hit.path)) continue;
    seen.add(hit.path);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Format a date (local time) using an Obsidian daily-note format.
 * Supports YYYY YY MM M DD D and [literal] escapes.
 */
export function formatDailyDate(date: Date, format: string): string {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  const tokens: Record<string, string> = {
    YYYY: String(y),
    YY: pad(y % 100),
    MM: pad(m),
    M: String(m),
    DD: pad(d),
    D: String(d),
  };
  return format.replace(/\[([^\]]*)\]|([A-Za-z]+)/g, (_m, literal: string | undefined, tok: string | undefined) => {
    if (literal !== undefined) return literal;
    const out = tokens[tok as string];
    if (out === undefined) throw new Error(`Unsupported daily note format token "${tok}"`);
    return out;
  });
}

/**
 * Vault-relative daily note path from .obsidian/daily-notes.json
 * (defaults: folder '', format YYYY-MM-DD).
 */
export async function resolveDailyNotePath(vaultPath: string, date: Date): Promise<string> {
  let folder = '';
  let format = 'YYYY-MM-DD';
  const cfgPath = path.join(vaultPath, '.obsidian', 'daily-notes.json');
  let raw: string | null = null;
  try {
    raw = await fs.readFile(cfgPath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Invalid .obsidian/daily-notes.json: ${(e as Error).message}`);
    }
  }
  if (raw !== null) {
    try {
      const cfg = JSON.parse(raw);
      if (typeof cfg.folder === 'string') folder = cfg.folder;
      if (typeof cfg.format === 'string' && cfg.format) format = cfg.format;
    } catch (e) {
      throw new Error(`Invalid .obsidian/daily-notes.json: ${(e as Error).message}`);
    }
  }
  return path.posix.join(folder, formatDailyDate(date, format) + '.md');
}

export interface HeadingInfo {
  level: number;
  text: string;
  line: number;
}

/** List ATX headings (1-based line numbers), ignoring lines inside fenced code blocks. */
export function scanHeadings(markdown: string): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  let fence: string | null = null;
  markdown.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      return;
    }
    if (fence !== null) return;
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) headings.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
  });
  return headings;
}

export interface SearchFilters {
  folder?: string;
  type?: string;
  status?: string;
  after?: string;
}

/** Build a LanceDB SQL filter from search filters, or undefined when none are set. */
export function buildWhereClause(f: SearchFilters): string | undefined {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const clauses: string[] = [];
  if (f.folder) clauses.push(`starts_with(path, ${q(f.folder.replace(/\/+$/, '') + '/')})`);
  if (f.type) clauses.push(`type = ${q(f.type)}`);
  if (f.status) clauses.push(`status = ${q(f.status)}`);
  if (f.after) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.after)) throw new Error('after must be YYYY-MM-DD');
    clauses.push(`date >= ${q(f.after)}`);
  }
  return clauses.length > 0 ? clauses.join(' AND ') : undefined;
}

/**
 * Reciprocal rank fusion: score each item by Σ 1/(k+rank+1) across ranked lists.
 * Ties keep first-seen order (earlier lists first).
 */
export function rrfMerge<T extends { id: string }>(lists: T[][], k = 60): T[] {
  const scored = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const entry = scored.get(item.id) ?? { item, score: 0 };
      entry.score += 1 / (k + rank + 1);
      scored.set(item.id, entry);
    });
  }
  return [...scored.values()].sort((a, b) => b.score - a.score).map(e => e.item);
}

/** Build the case-insensitive matcher for a search query. Throws `Invalid regex: <msg>` on bad regex. */
export function compileSearch(query: string, regex?: boolean): RegExp {
  try {
    return new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  } catch (e) {
    throw new Error(`Invalid regex: ${(e as Error).message}`);
  }
}

/** Find matching lines (1-based). Pass a precompiled RegExp to avoid rebuilding it per file. */
export function findMatches(
  content: string,
  query: string | RegExp,
  opts: { regex?: boolean }
): Array<{ line: number; text: string }> {
  const re = typeof query === 'string' ? compileSearch(query, opts.regex) : query;
  const out: Array<{ line: number; text: string }> = [];
  content.split('\n').forEach((l, i) => {
    if (re.test(l)) out.push({ line: i + 1, text: l.trim().slice(0, 200) });
  });
  return out;
}

/** Summarise a note: frontmatter, headings (line numbers relative to the body after frontmatter), wikilinks, word count. */
export function noteOutline(content: string): { frontmatter: Record<string, unknown>; headings: HeadingInfo[]; links: string[]; words: number } {
  const parsed = matter(content);
  return {
    frontmatter: parsed.data,
    headings: scanHeadings(parsed.content),
    links: extractWikilinks(parsed.content),
    words: parsed.content.split(/\s+/).filter(Boolean).length,
  };
}

const GUIDE_LIMIT = 4000;

export function buildInstructions(guide: string | null): string {
  const generic = [
    'Obsidian vault tools. Pick the cheapest tool that answers the question:',
    '- obsidian_rag_query: questions and exact tokens (hybrid keyword + vector; filters folder/type/status/after).',
    '- obsidian_search_notes: line-level grep (regex, folder) when you need exact matching lines.',
    '- obsidian_get_note_outline, or obsidian_read_note with `heading` / `frontmatter_only`: read part of a note instead of all of it.',
    '- obsidian_get_related: context around a note once you have found it.',
  ].join('\n');
  if (!guide) return generic;
  const body = guide.length > GUIDE_LIMIT
    ? guide.slice(0, GUIDE_LIMIT) + '\n…(truncated; read resource obsidian://vault-guide)'
    : guide;
  return `${generic}\n\n## Vault guide (AGENTS.md)\n${body}`;
}

export interface VaultSchema {
  exclude?: string[];
  rules: Array<{ prefix: string; required?: string[]; allowed?: Record<string, string[]> }>;
}

/** Read `<vault>/.obsidian-mcp-schema.json`. Returns null if the file does not exist. */
export async function loadVaultSchema(vp: string): Promise<VaultSchema | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(vp, '.obsidian-mcp-schema.json'), 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
  const schema = JSON.parse(raw) as VaultSchema;
  return { ...schema, rules: schema.rules ?? [] };
}

/**
 * Check note content against the first rule whose prefix matches the vault-relative path.
 * Returns error strings, or [] if valid. Excluded prefixes are always valid.
 */
export function validateFrontmatter(filePath: string, content: string, schema: VaultSchema): string[] {
  if ((schema.exclude ?? []).some(p => filePath.startsWith(p))) return [];
  const rule = schema.rules.find(r => filePath.startsWith(r.prefix));
  if (!rule) return [];
  const data = matter(content).data as Record<string, unknown>;
  const errors: string[] = [];
  for (const field of rule.required ?? []) {
    if (!(field in data)) errors.push(`missing required field "${field}"`);
  }
  for (const [field, allowed] of Object.entries(rule.allowed ?? {})) {
    if (!(field in data)) continue;
    const value = data[field];
    if (typeof value !== 'string' || !allowed.includes(value)) {
      errors.push(`${field} ${JSON.stringify(value)} not allowed (allowed: ${allowed.join(', ')})`);
    }
  }
  return errors;
}

const isInside = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

/**
 * Resolve relPath against vaultRoot and refuse anything that lands outside it,
 * lexically or via a symlink. For paths that don't exist yet, the nearest existing parent is checked.
 */
export async function resolveVaultPath(vaultRoot: string, relPath: string): Promise<string> {
  const root = path.resolve(vaultRoot);
  const target = path.resolve(root, relPath);
  const escape = () => new Error(`Path escapes vault: ${relPath}`);
  if (!isInside(root, target)) throw escape();
  const realRoot = await fs.realpath(root);
  let existing = target;
  for (;;) {
    try {
      const real = await fs.realpath(existing);
      if (!isInside(realRoot, real)) throw escape();
      return target;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      existing = parent;
    }
  }
}
