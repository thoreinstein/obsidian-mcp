import * as path from 'path';
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
  if (update.updates) {
    for (const [k, v] of Object.entries(update.updates)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      parsed.data[k] = v;
    }
  } else {
    let value: unknown = update.value;
    try { value = JSON.parse(String(update.value)); } catch { /* use as string */ }
    parsed.data[update.key] = value;
  }
  return matter.stringify(parsed.content, parsed.data);
}
