'use client';

/**
 * The note body editor. Formatting shows as it will look (bold is bold, not
 * **), while the note is still saved as the same lightweight markdown text
 * the rest of the app reads (lib/note-markdown.ts).
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import { noteEditorExtensions } from '@/lib/note-editor-extensions';
import { docToNoteText, noteTextToDoc, type NoteDoc } from '@/lib/note-markdown';

export type NoteFormat = 'bold' | 'italic' | 'h1' | 'h2' | 'h3' | 'body' | 'bullet' | 'number';

export type NoteBodyEditorHandle = {
  focus: () => void;
  /** Applies a format to the selection, or, with nothing selected, turns it on for what is typed next. */
  format: (kind: NoteFormat) => void;
};

/** Which formats are on where the cursor is, for lighting the toolbar buttons. */
export function activeNoteFormats(editor: Editor): NoteFormat[] {
  const active: NoteFormat[] = [];
  if (editor.isActive('bold')) active.push('bold');
  if (editor.isActive('italic')) active.push('italic');
  for (const level of [1, 2, 3] as const) if (editor.isActive('heading', { level })) active.push(`h${level}`);
  if (editor.isActive('bulletList')) active.push('bullet');
  if (editor.isActive('orderedList')) active.push('number');
  return active;
}

function applyNoteFormat(editor: Editor, kind: NoteFormat) {
  const chain = editor.chain().focus();
  if (kind === 'bold') chain.toggleBold().run();
  else if (kind === 'italic') chain.toggleItalic().run();
  else if (kind === 'h1' || kind === 'h2' || kind === 'h3') chain.toggleHeading({ level: Number(kind[1]) as 1 | 2 | 3 }).run();
  else if (kind === 'bullet') chain.toggleBulletList().run();
  else if (kind === 'number') chain.toggleOrderedList().run();
  else {
    // Body: back to a plain line, out of a heading or a list.
    if (editor.isActive('bulletList')) chain.toggleBulletList();
    else if (editor.isActive('orderedList')) chain.toggleOrderedList();
    chain.setParagraph().run();
  }
}

export const NoteBodyEditor = forwardRef<NoteBodyEditorHandle, {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  /** Classes for the box around the editor, for sizing it in a flex layout. */
  wrapperClassName?: string;
  editable?: boolean;
  autoFocus?: boolean;
  onFocus?: () => void;
  onClick?: () => void;
  onActiveFormatsChange?: (active: NoteFormat[]) => void;
}>(function NoteBodyEditor({ value, onChange, ariaLabel, placeholder = '', className = '', wrapperClassName, editable = true, autoFocus = false, onFocus, onClick, onActiveFormatsChange }, ref) {
  // The text this editor last saved, so a value that is only its own change
  // coming back does not reset the document and move the cursor.
  const lastValue = useRef(value);
  const eol = useRef<'\n' | '\r\n'>(noteTextToDoc(value).eol);
  // Latest callbacks, read from the editor's own handlers.
  const callbacks = useRef({ onChange, onFocus, onActiveFormatsChange });
  callbacks.current = { onChange, onFocus, onActiveFormatsChange };
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;

  const editor = useEditor({
    extensions: [...noteEditorExtensions(), Placeholder.configure({ placeholder: () => placeholderRef.current })],
    content: noteTextToDoc(value).doc,
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: `note-editor outline-none ${className}`,
        'aria-label': ariaLabel,
        'aria-multiline': 'true',
        role: 'textbox',
      },
    },
    onUpdate: ({ editor: current }) => {
      const text = docToNoteText(current.getJSON() as NoteDoc, eol.current);
      if (text === lastValue.current) return;
      lastValue.current = text;
      callbacks.current.onChange(text);
    },
    onFocus: () => callbacks.current.onFocus?.(),
    onTransaction: ({ editor: current }) => callbacks.current.onActiveFormatsChange?.(activeNoteFormats(current)),
  });

  // A new value from outside (another note opened, a draft cleared) replaces the document.
  useEffect(() => {
    if (!editor || value === lastValue.current) return;
    lastValue.current = value;
    const parsed = noteTextToDoc(value);
    eol.current = parsed.eol;
    editor.commands.setContent(parsed.doc, false);
  }, [editor, value]);

  useEffect(() => { editor?.setEditable(editable); }, [editor, editable]);

  // The placeholder is read when drawn, so a changed one needs a redraw.
  useEffect(() => { if (editor) editor.view.dispatch(editor.state.tr.setMeta('placeholder', placeholder)); }, [editor, placeholder]);

  useEffect(() => {
    if (!editor) return;
    editor.setOptions({ editorProps: { attributes: { class: `note-editor outline-none ${className}`, 'aria-label': ariaLabel, 'aria-multiline': 'true', role: 'textbox' } } });
  }, [editor, className, ariaLabel]);

  // The editor is made after the first render, so a focus asked for before
  // then (opening a note to edit it, autoFocus) waits for it.
  const pendingFocus = useRef(autoFocus);
  useEffect(() => {
    if (!editor || !pendingFocus.current) return;
    // React may make an editor and throw it away before keeping the next one
    // (development mode does), so the request stays until one takes it.
    const frame = requestAnimationFrame(() => {
      if (editor.isDestroyed) return;
      pendingFocus.current = false;
      editor.commands.focus('end');
    });
    return () => cancelAnimationFrame(frame);
  }, [editor]);

  useImperativeHandle(ref, () => ({
    focus: () => { if (editor && !editor.isDestroyed) editor.commands.focus(); else pendingFocus.current = true; },
    format: (kind) => { if (editor) applyNoteFormat(editor, kind); },
  }), [editor]);

  return <EditorContent editor={editor} onClick={onClick} className={wrapperClassName} />;
});
