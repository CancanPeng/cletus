function fromCodePoint(code: number): string {
  // Out-of-range values and lone surrogates throw in String.fromCodePoint.
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return "\ufffd";
  }
  return String.fromCodePoint(code);
}

export function decodeHtml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_match, code: string) =>
      fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function stripHtml(text: string): string {
  return decodeHtml(text.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function clampLimit(value: number, max = 20, fallback = 10): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), max);
}
