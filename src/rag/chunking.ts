import md5 from 'md5';
import { scanHeadings } from '../utils.js';

export interface ChunkingOptions {
  minChunkChars?: number;
  maxChunkChars?: number;
  targetChunkChars?: number;
}

const DEFAULTS = {
  minChunkChars: 40,
  maxChunkChars: 1800,
  targetChunkChars: 700,
} as const;

export function splitTextForEmbedding(text: string, maxChars: number = DEFAULTS.maxChunkChars): string[] {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxChars) return [normalized];

  const segments: string[] = [];
  const sentenceParts = normalized.split(/(?<=[.!?])\s+/);
  let current = '';

  for (const part of sentenceParts) {
    if (part.length > maxChars) {
      if (current.length > 0) {
        segments.push(current);
        current = '';
      }
      for (let i = 0; i < part.length; i += maxChars) {
        segments.push(part.slice(i, i + maxChars));
      }
      continue;
    }

    const candidate = current.length > 0 ? `${current} ${part}` : part;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current.length > 0) segments.push(current);
      current = part;
    }
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

export function mergeSegmentsForEmbedding(segments: string[], targetChars: number): string[] {
  if (segments.length === 0) return [];
  const merged: string[] = [];
  let current = '';

  for (const segment of segments) {
    if (segment.length >= targetChars) {
      if (current.length > 0) {
        merged.push(current);
        current = '';
      }
      merged.push(segment);
      continue;
    }

    const candidate = current.length > 0 ? `${current}\n\n${segment}` : segment;
    if (candidate.length <= targetChars) {
      current = candidate;
    } else {
      if (current.length > 0) merged.push(current);
      current = segment;
    }
  }

  if (current.length > 0) merged.push(current);
  return merged;
}

export interface NoteMeta {
  title: string;
  date: string;
  status: string;
  type: string;
}

export interface ChunkMetadata extends NoteMeta {
  id: string;
  text: string;
  path: string;
  heading: string;
}

function toDateString(value: unknown): string {
  if (value instanceof Date && !isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return '';
}

/**
 * Derive per-note metadata stored alongside each chunk so search results can show
 * what kind of note a hit came from (e.g. an archived proposal vs. a live note).
 */
export function extractNoteMeta(relativePath: string, frontmatter: Record<string, unknown>, body: string, mtime?: Date): NoteMeta {
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const fmTitle = typeof frontmatter.title === 'string' ? frontmatter.title.trim() : '';
  const title = fmTitle || heading || relativePath.split('/').pop()!.replace(/\.md$/i, '');
  const date =
    toDateString(frontmatter.updated) ||
    toDateString(frontmatter.modified) ||
    toDateString(frontmatter.created) ||
    toDateString(frontmatter.date) ||
    (mtime ? toDateString(mtime) : '');
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return { title, date, status: str(frontmatter.status), type: str(frontmatter.type) };
}

/**
 * Split a note body into sections at each heading. `heading` is the path of
 * ancestor headings joined with ' > ' ('' for text before the first heading).
 * The heading line itself is not part of `text`; empty sections are dropped.
 */
export function splitByHeadings(body: string): Array<{ heading: string; text: string }> {
  const lines = body.split('\n');
  const sections: Array<{ heading: string; text: string }> = [];
  const stack: Array<{ level: number; text: string }> = [];
  let heading = '';
  let start = 0;

  const flush = (end: number) => {
    const text = lines.slice(start, end).join('\n');
    if (text.trim().length > 0) sections.push({ heading, text });
  };

  for (const h of scanHeadings(body)) {
    flush(h.line - 1);
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push({ level: h.level, text: h.text });
    heading = stack.map(s => s.text).join(' > ');
    start = h.line;
  }
  flush(lines.length);
  return sections;
}

export function buildEmbeddingInputs(relativePath: string, body: string, options?: ChunkingOptions, meta?: NoteMeta) {
  const minChunkChars = options?.minChunkChars ?? DEFAULTS.minChunkChars;
  const maxChunkChars = options?.maxChunkChars ?? DEFAULTS.maxChunkChars;
  const targetChunkChars = options?.targetChunkChars ?? DEFAULTS.targetChunkChars;

  const chunkMetadata: ChunkMetadata[] = [];
  const textsToEmbed: string[] = [];
  const noteMeta: NoteMeta = meta ?? { title: '', date: '', status: '', type: '' };

  for (const section of splitByHeadings(body)) {
    const rawSegments: string[] = [];
    const paragraphs = section.text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    for (let p = 0; p < paragraphs.length; p++) {
      const paragraph = paragraphs[p].trim();
      // The heading line used to sit in the first paragraph, so it counts toward the minimum length.
      const bonus = p === 0 ? section.heading.length : 0;
      if (paragraph.length + bonus < minChunkChars) continue;
      const segments = splitTextForEmbedding(paragraph, maxChunkChars);
      for (const segment of segments) {
        if (segment.length + (segments.length === 1 ? bonus : 0) >= minChunkChars) rawSegments.push(segment);
      }
    }

    // Embed each chunk with its note's title, heading path and path so generic chunks
    // (checklists, boilerplate sections) are anchored to where they came from.
    const label = [noteMeta.title, section.heading].filter(Boolean).join(' > ');
    const base = label ? `${label} (${relativePath})` : relativePath;
    for (const text of mergeSegmentsForEmbedding(rawSegments, targetChunkChars)) {
      chunkMetadata.push({
        id: md5(`${relativePath}-${chunkMetadata.length}`),
        path: relativePath,
        text,
        heading: section.heading,
        ...noteMeta
      });
      textsToEmbed.push(`${base}\n\n${text}`);
    }
  }

  return { textsToEmbed, chunkMetadata };
}
