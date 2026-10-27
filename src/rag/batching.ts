/** Greedy batch ranges over `lengths`: a batch closes before the item that would reach maxItems or maxChars; every batch holds at least one item. */
export function planBatches(lengths: number[], maxItems: number, maxChars: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  let chars = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (i > start && (i - start >= maxItems || chars + lengths[i] >= maxChars)) {
      ranges.push([start, i]);
      start = i;
      chars = 0;
    }
    chars += lengths[i];
  }
  if (start < lengths.length) ranges.push([start, lengths.length]);
  return ranges;
}
