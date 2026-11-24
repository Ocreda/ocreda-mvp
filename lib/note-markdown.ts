/**
 * Converts a note's text to and from the TipTap editor's document.
 *
 * Notes are saved as plain text with the lightweight markdown the note view
 * draws (see FormattedNoteBody in app/page.tsx): one line per paragraph,
 * `#`–`###` headings, `-` `+` `*` `•` bullets, `1.` numbered items, and
 * `**bold**` / `*italic*` (or `__` / `_`). Card highlights and the AI search
 * point at character offsets in that saved text, so a note opened in the
 * editor and saved without changes must come back character for character.
 * Every marker's exact spelling is therefore kept on the node it made, and
 * anything the view does not draw stays as literal text.
 *
 * Pure functions over TipTap's JSON shape, so the round-trip can be tested
 * without a browser (scripts/note-markdown-roundtrip.test.mjs).
 */

export type NoteMark = { type: 'bold' | 'italic'; attrs?: { delim?: string } };
export type NoteInline =
  | { type: 'text'; text: string; marks?: NoteMark[] }
  | { type: 'hardBreak' };
export type NoteParagraph = { type: 'paragraph'; content?: NoteInline[] };
export type NoteHeading = { type: 'heading'; attrs: { level: number; sep?: string }; content?: NoteInline[] };
export type NoteListItem = { type: 'listItem'; attrs?: { marker?: string; number?: number | null; sep?: string }; content: NoteBlock[] };
export type NoteList =
  | { type: 'bulletList'; content: NoteListItem[] }
  | { type: 'orderedList'; attrs?: { start?: number }; content: NoteListItem[] };
export type NoteBlock = NoteParagraph | NoteHeading | NoteList;
export type NoteDoc = { type: 'doc'; content: NoteBlock[] };

/** The same expressions the note view uses, so the editor shows what the view shows. */
const HEADING = /^(#{1,3})(\s+)(.*)$/;
const BULLET = /^([-+*•])(\s+)(.*)$/;
const NUMBERED = /^(\d+)\.(\s+)(.*)$/;
/**
 * Emphasis: ***both*** (or ___both___), **bold** / __bold__, *italic* / _italic_.
 * A marker's text never holds its own character, so one style nests inside the
 * other with the other character: **bold _and italic_**, *italic __and bold__*.
 */
const INLINE = /(\*\*\*[^*\n]+\*\*\*|___[^_\n]+___|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;

/**
 * A stretch of visible text and how it is styled, with where it sits in the
 * line. The markers between stretches are not drawn. `bold` and `italic` hold
 * the marker each style was written with.
 */
export type InlineRun = { start: number; end: number; bold?: string; italic?: string };

/** A line's visible text as styled runs; every renderer and the editor read lines this way. */
export function inlineRuns(text: string, offset = 0, style: { bold?: string; italic?: string } = {}): InlineRun[] {
  const runs: InlineRun[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > cursor) runs.push({ start: offset + cursor, end: offset + at, ...style });
    const matched = match[0];
    const char = matched[0];
    const size = matched.startsWith(char.repeat(3)) ? 3 : matched.startsWith(char.repeat(2)) ? 2 : 1;
    const inner = size === 3 ? { bold: char.repeat(2), italic: char }
      : size === 2 ? { ...style, bold: char.repeat(2) }
        : { ...style, italic: char };
    runs.push(...inlineRuns(matched.slice(size, -size), offset + at + size, inner));
    cursor = at + matched.length;
  }
  if (cursor < text.length) runs.push({ start: offset + cursor, end: offset + text.length, ...style });
  return runs.filter((run) => run.end > run.start);
}

export function parseInline(text: string): NoteInline[] {
  return inlineRuns(text).map((run) => {
    const marks: NoteMark[] = [];
    if (run.bold) marks.push({ type: 'bold', attrs: { delim: run.bold } });
    if (run.italic) marks.push({ type: 'italic', attrs: { delim: run.italic } });
    const node: NoteInline = { type: 'text', text: text.slice(run.start, run.end) };
    return marks.length ? { ...node, marks } : node;
  });
}

const withContent = (inline: NoteInline[]) => (inline.length ? { content: inline } : {});

/** Saved note text to an editor document. Windows line endings are noted so they are written back. */
export function noteTextToDoc(text: string): { doc: NoteDoc; eol: '\n' | '\r\n' } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  const blocks: NoteBlock[] = [];
  for (const line of lines) {
    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ type: 'heading', attrs: { level: heading[1].length, sep: heading[2] }, ...withContent(parseInline(heading[3])) });
      continue;
    }
    const bullet = line.match(BULLET);
    const numbered = bullet ? null : line.match(NUMBERED);
    if (bullet || numbered) {
      const kind = bullet ? 'bulletList' : 'orderedList';
      const body = (bullet ?? numbered)![3];
      const item: NoteListItem = {
        type: 'listItem',
        attrs: bullet ? { marker: bullet[1], sep: bullet[2] } : { number: Number(numbered![1]), sep: numbered![2] },
        content: [{ type: 'paragraph', ...withContent(parseInline(body)) }],
      };
      const last = blocks[blocks.length - 1];
      if (last && last.type === kind) last.content.push(item);
      else blocks.push(kind === 'bulletList'
        ? { type: 'bulletList', content: [item] }
        : { type: 'orderedList', attrs: { start: Number(numbered![1]) }, content: [item] });
      continue;
    }
    blocks.push({ type: 'paragraph', ...withContent(parseInline(line)) });
  }
  return { doc: { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] }, eol };
}

const DEFAULT_DELIM = { bold: '**', italic: '*' } as const;

type MarkType = NoteMark['type'];
/** An open emphasis: one style, or both written together as *** / ___. */
type OpenMark = { types: MarkType[]; delim: string };

const otherChar = (delim: string) => (delim[0] === '*' ? '_' : '*').repeat(delim.length);

/**
 * Inline content back to text. Styles are opened and closed where they change;
 * one style inside another is written with the other character (**a _b_**) so
 * it reads back the same, and both over the same words as ***both***.
 */
export function serializeInline(content: NoteInline[] | undefined, eol = '\n'): string {
  // Lines split at hard breaks; each is written on its own.
  const segments: { text: string; marks: Map<MarkType, string> }[][] = [[]];
  for (const node of content ?? []) {
    if (node.type === 'hardBreak') { segments.push([]); continue; }
    if (!node.text) continue;
    const marks = new Map<MarkType, string>();
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold' || mark.type === 'italic') marks.set(mark.type, mark.attrs?.delim || DEFAULT_DELIM[mark.type]);
    }
    segments[segments.length - 1].push({ text: node.text, marks });
  }
  return segments.map((nodes) => {
    let out = '';
    const open: OpenMark[] = [];
    /** Where a style that covers node `from` stops covering. */
    const spanEnd = (from: number, type: MarkType) => {
      let index = from;
      while (index < nodes.length && nodes[index].marks.has(type)) index++;
      return index;
    };
    nodes.forEach((node, index) => {
      // Close from the innermost out, down to the first open style this text no longer has.
      const stale = open.findIndex((entry) => entry.types.some((type) => !node.marks.has(type)));
      if (stale !== -1) while (open.length > stale) out += open.pop()!.delim;
      const missing = (['bold', 'italic'] as const).filter((type) => node.marks.has(type) && !open.some((entry) => entry.types.includes(type)));
      if (missing.length === 2 && spanEnd(index, 'bold') === spanEnd(index, 'italic')) {
        const bold = node.marks.get('bold')!;
        const italic = node.marks.get('italic')!;
        if (bold[0] === italic[0]) {
          const delim = bold[0].repeat(3);
          out += delim;
          open.push({ types: ['bold', 'italic'], delim });
          missing.length = 0;
        }
      }
      // The style that lasts longer is opened first, so it is the outer one.
      missing.sort((a, b) => spanEnd(index, b) - spanEnd(index, a) || (a === 'bold' ? -1 : 1));
      for (const type of missing) {
        let delim = node.marks.get(type)!;
        if (open.some((entry) => entry.delim[0] === delim[0])) delim = otherChar(delim);
        out += delim;
        open.push({ types: [type], delim });
      }
      out += node.text;
    });
    while (open.length) out += open.pop()!.delim;
    return out;
  }).join(eol);
}

function blockLines(block: NoteBlock, eol: string): string[] {
  if (block.type === 'paragraph') return [serializeInline(block.content, eol)];
  if (block.type === 'heading') {
    const level = Math.min(Math.max(block.attrs.level, 1), 3);
    return [`${'#'.repeat(level)}${block.attrs.sep || ' '}${serializeInline(block.content, eol)}`];
  }
  const lines: string[] = [];
  let previous = (block.type === 'orderedList' ? block.attrs?.start ?? 1 : 1) - 1;
  // Numbers are written as they were typed ("1. 1. 1." stays so), until an item
  // is added in the editor; then the list is counted again from its start.
  const renumber = block.type === 'orderedList' && block.content.some((item) => typeof item.attrs?.number !== 'number');
  for (const item of block.content) {
    // A list item holds paragraphs, and lists if one was pasted in; the view
    // has no nesting, so each becomes a line of its own.
    const [first, ...rest] = item.content;
    const text = first && first.type === 'paragraph' ? serializeInline(first.content, eol) : '';
    const sep = item.attrs?.sep || ' ';
    if (block.type === 'bulletList') lines.push(`${item.attrs?.marker || '•'}${sep}${text}`);
    else {
      const number = !renumber && typeof item.attrs?.number === 'number' ? item.attrs.number : previous + 1;
      previous = number;
      lines.push(`${number}.${sep}${text}`);
    }
    const remaining = first && first.type === 'paragraph' ? rest : item.content;
    for (const child of remaining) lines.push(...blockLines(child, eol));
  }
  return lines;
}

/** An editor document back to saved note text. */
export function docToNoteText(doc: NoteDoc, eol: '\n' | '\r\n' = '\n'): string {
  const blocks = doc.content ?? [];
  if (blocks.length === 1 && blocks[0].type === 'paragraph' && !blocks[0].content?.length) return '';
  return blocks.flatMap((block) => blockLines(block, eol)).join(eol);
}

// Plain text for showing a note's words outside the editor and the note view
// (cards, previews, chips), where markdown would show as symbols.

/** Markers at the start of a line: headings, quotes, bullets, numbered items. */
export const LINE_MARKER = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-+*•][ \t]+|\d+\.[ \t]+)+/gm;

/**
 * Inline markers only: emphasis, strikethrough, code ticks, and links (their
 * text kept). A lone * or _ inside a word, as in snake_case, is kept.
 */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/(?<![\p{L}\p{N}])[*_]|[*_](?![\p{L}\p{N}])/gu, '');
}

/**
 * A note's words as plain text, for anywhere they are quoted outside the note
 * body itself (cards, chips, merged text), where markdown would show as symbols.
 */
export function plainNoteText(text: string): string {
  return stripInlineMarkdown(text.replace(LINE_MARKER, '')).replace(/[ \t]+/g, ' ').trim();
}

/** A note body for a preview card: one line per line, bullets kept as •, other markers removed. */
export function previewNoteText(text: string): string {
  return text.split('\n').map((line) => stripInlineMarkdown(line.replace(/^#{1,3}\s+/, '').replace(/^[-+*]\s+/, '• '))).join('\n');
}
