/**
 * The TipTap extensions for note bodies: only what a saved note can hold
 * (see lib/note-markdown.ts), each keeping the exact marker it was written
 * with so an unchanged note saves back character for character.
 */
import StarterKit from '@tiptap/starter-kit';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Heading from '@tiptap/extension-heading';
import ListItem from '@tiptap/extension-list-item';
import OrderedList from '@tiptap/extension-ordered-list';
import type { Extensions } from '@tiptap/core';

/** The emphasis marker a mark was written with: ** or __ for bold, * or _ for italic. */
const delimAttribute = (fallback: string) => ({
  delim: { default: fallback, rendered: false, keepOnSplit: true },
});

export function noteEditorExtensions(): Extensions {
  return [
    StarterKit.configure({
      // Formats a saved note cannot hold are left out, so typing or pasting them
      // gives plain text rather than something that would be lost on save.
      blockquote: false,
      code: false,
      codeBlock: false,
      horizontalRule: false,
      strike: false,
      bold: false,
      italic: false,
      heading: false,
      listItem: false,
      orderedList: false,
    }),
    Bold.extend({ addAttributes: () => delimAttribute('**') }),
    Italic.extend({ addAttributes: () => delimAttribute('*') }),
    Heading.extend({
      addAttributes() {
        return { ...this.parent?.(), sep: { default: ' ', rendered: false, keepOnSplit: false } };
      },
    }).configure({ levels: [1, 2, 3] }),
    ListItem.extend({
      addAttributes() {
        return {
          marker: { default: '•', rendered: false, keepOnSplit: true },
          // An item added in the editor has no number of its own; the list is counted again.
          // Drawn as the item's value, so "1. 1. 1." shows as typed.
          number: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element: HTMLElement) => (element.getAttribute('value') ? Number(element.getAttribute('value')) : null),
            renderHTML: (attributes: { number?: number | null }) => (typeof attributes.number === 'number' ? { value: attributes.number } : {}),
          },
          sep: { default: ' ', rendered: false, keepOnSplit: true },
        };
      },
      // No Tab to nest: a saved note has no nested lists.
      addKeyboardShortcuts() {
        return { Enter: () => this.editor.commands.splitListItem(this.name) };
      },
    }),
    OrderedList,
  ];
}
