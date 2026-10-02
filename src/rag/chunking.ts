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

export function buildEmbeddingInputs(relativePath: string, body: string, options?: ChunkingOptions) {
  const minChunkChars = options?.minChunkChars ?? DEFAULTS.minChunkChars;
  const maxChunkChars = options?.maxChunkChars ?? DEFAULTS.maxChunkChars;
  const targetChunkChars = options?.targetChunkChars ?? DEFAULTS.targetChunkChars;

  const paragraphs = body.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  const rawSegments: string[] = [];
  const chunkMetadata: { id: string; text: string; path: string }[] = [];

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

  const textsToEmbed = mergeSegmentsForEmbedding(rawSegments, targetChunkChars);
  for (let chunkIndex = 0; chunkIndex < textsToEmbed.length; chunkIndex++) {
    chunkMetadata.push({
      id: md5(`${relativePath}-${chunkIndex}`),
      path: relativePath,
      text: textsToEmbed[chunkIndex]
    });
  }

  return { textsToEmbed, chunkMetadata };
}
