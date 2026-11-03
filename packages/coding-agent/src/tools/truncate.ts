export type TruncationResult = { text: string; truncated: boolean; omittedLines: number };

function truncate(
  text: string,
  maxLines: number,
  maxBytes: number,
  fromEnd: boolean,
): TruncationResult {
  const lines = text.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  const source = fromEnd ? [...lines].reverse() : lines;
  for (const line of source) {
    const size = Buffer.byteLength(line) + 1;
    if (kept.length >= maxLines || bytes + size > maxBytes) break;
    kept.push(line);
    bytes += size;
  }
  const omitted = lines.length - kept.length;
  if (omitted <= 0) return { text, truncated: false, omittedLines: 0 };
  if (fromEnd) {
    return {
      text: `[truncated: ${omitted} lines omitted]\n${kept.reverse().join("\n")}`,
      truncated: true,
      omittedLines: omitted,
    };
  }
  return {
    text: `${kept.join("\n")}\n[truncated: ${omitted} lines omitted]`,
    truncated: true,
    omittedLines: omitted,
  };
}

export function truncateHead(
  text: string,
  maxLines = 2000,
  maxBytes = 50_000,
): TruncationResult {
  return truncate(text, maxLines, maxBytes, false);
}

export function truncateTail(
  text: string,
  maxLines = 2000,
  maxBytes = 50_000,
): TruncationResult {
  return truncate(text, maxLines, maxBytes, true);
}