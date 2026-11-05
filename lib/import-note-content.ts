const MAX_IMPORTED_TITLE_CHARS = 120;

function withoutLeadingMarkup(value: string): string {
  return value
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]\s+|>\s*)/, '')
    .trim();
}

function trimToTitleLength(value: string): string {
  if (value.length <= MAX_IMPORTED_TITLE_CHARS) return value;

  const shortened = value.slice(0, MAX_IMPORTED_TITLE_CHARS - 1).trimEnd();
  const lastSpace = shortened.lastIndexOf(' ');
  const atWordBoundary = lastSpace >= Math.floor(MAX_IMPORTED_TITLE_CHARS * 0.65)
    ? shortened.slice(0, lastSpace)
    : shortened;
  return `${atWordBoundary.trimEnd()}…`;
}

function firstSentence(value: string): string {
  const readable = withoutLeadingMarkup(value).replace(/\s+/g, ' ').trim();
  if (!readable) return '';

  // Keep sentence-ending punctuation in the generated title. Requiring the
  // punctuation to be followed by whitespace/end avoids splitting decimals.
  const ending = readable.match(/[.!?](?:["'”’)]*)?(?=\s|$)/);
  const sentence = ending?.index === undefined
    ? readable
    : readable.slice(0, ending.index + ending[0].length);
  return trimToTitleLength(sentence.trim());
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

  const title = firstSentence(text);
  return title ? `${title}\n\n${text}` : text;
}
