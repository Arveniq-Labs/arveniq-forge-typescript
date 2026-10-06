/** Only SDK-generated markup may be inserted into a UI5 HTML control. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function fold(value: string): string { return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase(); }
export function searchTerms(query: string): string[] {
  return [...query.matchAll(/"([^"]+)"|(\S+)/g)].map(match => fold(match[1] ?? match[2] ?? '').trim()).filter(Boolean);
}
/** Accent-insensitive highlighting preserves original spelling and escapes every displayed fragment. */
export function highlightMatches(text: string, query: string): string {
  let normalized = ''; let offset = 0;
  const positions: Array<{ start: number; end: number }> = [];
  for (const character of text) {
    const part = fold(character); normalized += part;
    for (let i = 0; i < part.length; i++) positions.push({ start: offset, end: offset + character.length });
    offset += character.length;
  }
  const ranges: Array<{ start: number; end: number }> = [];
  for (const term of searchTerms(query)) {
    let start = normalized.indexOf(term);
    while (start !== -1) {
      const first = positions[start]; const last = positions[start + term.length - 1];
      if (first && last) ranges.push({ start: first.start, end: last.end });
      start = normalized.indexOf(term, start + Math.max(1, term.length));
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end); else merged.push({ ...range });
  }
  let cursor = 0; let html = '';
  for (const range of merged) {
    html += escapeHtml(text.slice(cursor, range.start)) + '<mark>' + escapeHtml(text.slice(range.start, range.end)) + '</mark>';
    cursor = range.end;
  }
  return html + escapeHtml(text.slice(cursor));
}
