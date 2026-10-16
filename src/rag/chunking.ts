import md5 from 'md5';

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

export function buildEmbeddingInputs(relativePath: string, body: string, options?: ChunkingOptions, meta?: NoteMeta) {
  const minChunkChars = options?.minChunkChars ?? DEFAULTS.minChunkChars;
  const maxChunkChars = options?.maxChunkChars ?? DEFAULTS.maxChunkChars;
  const targetChunkChars = options?.targetChunkChars ?? DEFAULTS.targetChunkChars;

  const paragraphs = body.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  const rawSegments: string[] = [];
  const chunkMetadata: ChunkMetadata[] = [];
  const noteMeta: NoteMeta = meta ?? { title: '', date: '', status: '', type: '' };

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i].trim();
    if (paragraph.length < minChunkChars) continue;

    const segments = splitTextForEmbedding(paragraph, maxChunkChars);
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      const segment = segments[segmentIndex];
      if (segment.length < minChunkChars) continue;
      rawSegments.push(segment);
    }
  }

  const chunkTexts = mergeSegmentsForEmbedding(rawSegments, targetChunkChars);
  for (let chunkIndex = 0; chunkIndex < chunkTexts.length; chunkIndex++) {
    chunkMetadata.push({
      id: md5(`${relativePath}-${chunkIndex}`),
      path: relativePath,
      text: chunkTexts[chunkIndex],
      ...noteMeta
    });
  }

  // Embed each chunk with its note's title and path so generic chunks (checklists,
  // boilerplate sections) are anchored to the note they came from.
  const header = noteMeta.title ? `${noteMeta.title} (${relativePath})` : relativePath;
  const textsToEmbed = chunkTexts.map(text => `${header}\n\n${text}`);

  return { textsToEmbed, chunkMetadata };
}
