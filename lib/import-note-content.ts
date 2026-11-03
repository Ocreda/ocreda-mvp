const MAX_IMPORTED_TITLE_CHARS = 120;

function withoutLeadingMarkup(value: string): string {
  return value
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]\s+|>\s*)/, '')
    .trim();
}

export function firstFiveWordTitle(value: string): string {
  const readable = withoutLeadingMarkup(value).replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
  if (!readable) return '';
  return readable.split(' ').slice(0, 5).join(' ');
}

function hasExplicitTitle(value: string): boolean {
  const lines = value.split('\n');
  const firstLine = lines[0]?.trim() ?? '';
  const remainingText = lines.slice(1).join('\n').trim();
  if (!firstLine || !remainingText) return false;

  // Markdown headings are unambiguous. Plain-text imports count line one as
  // a title only when it is followed by a blank line and looks like a heading
  // rather than the opening sentence of the body.
  if (/^\s{0,3}#{1,6}\s+\S/.test(lines[0])) return true;
  const separatedFromBody = (lines[1]?.trim() ?? '') === '';
  const looksLikeSentence = /[.!?]["'”’)]*$/.test(firstLine);
  const bodyStartsWithSameText = remainingText.replace(/\s+/g, ' ').startsWith(firstLine);
  return separatedFromBody && firstLine.length <= MAX_IMPORTED_TITLE_CHARS &&
    (!looksLikeSentence || bodyStartsWithSameText);
}

/**
 * Give a titleless imported note a useful title without consuming any of its
 * source text. The original note remains intact beneath the generated title.
 */
export function prepareImportedNoteText(rawText: string): string {
  const text = rawText.replace(/\r\n?/g, '\n').trim();
  if (!text || hasExplicitTitle(text)) return text;

  const title = firstFiveWordTitle(text);
  return title ? `${title}\n\n${text}` : text;
}
