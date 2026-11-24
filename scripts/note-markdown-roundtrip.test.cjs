/**
 * Round-trip test for the TipTap note editor: every note, opened in the editor
 * and saved without changes, must come back character for character. Card
 * highlights and the AI search point at offsets in the saved text, so any
 * drift would move them.
 *
 * Runs every note in notes/, every sample-vault note, and hand-made cases for
 * the formats the editor understands. Run with: npm run test:note-markdown
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getSchema } = require('@tiptap/core');

const build = path.join(__dirname, '..', '.note-markdown-build');
const { noteTextToDoc, docToNoteText } = require(path.join(build, 'note-markdown.js'));
const { noteEditorExtensions } = require(path.join(build, 'note-editor-extensions.js'));
const { SAMPLE_NOTES } = require(path.join(build, 'sample-vault-data.js'));

const schema = getSchema(noteEditorExtensions());

/** Through the editor's own schema, as opening a note in the editor does. */
function roundTrip(text) {
  const { doc, eol } = noteTextToDoc(text);
  const node = schema.nodeFromJSON(doc);
  node.check();
  return { out: docToNoteText(node.toJSON(), eol), node };
}

const handMade = {
  'empty': '',
  'one line': 'Just a thought.',
  'blank lines kept': 'First\n\n\nSecond\n',
  'whole line bold (the card bug)': '**If you ever need to pivot from Ocreda initial idea, go to roadmap on notion**',
  'bold and italic mid-line': 'This is **really** important and *mostly* true.',
  'underscore emphasis': 'Use __this__ and _that_.',
  'snake_case stays literal-looking': 'the snake_case_name and a_b',
  'lone stars': 'Price 5 * 3 = 15, and a ** b',
  'triple stars': '***both*** here',
  'triple underscores': '___both___ here',
  'italic inside bold': '**bold _and italic_ words**',
  'bold inside italic': '*italic __and bold__ words*',
  'underscore bold with star italic': '__bold *and italic*__',
  'bold then italic touching': '**bold***it*',
  'italic then bold touching': '*it***bold**',
  'bold+italic in a list': '• ***key*** point\n1. **a _b_**',
  'headings': '# One\n## Two\n### Three\n#### Four is text',
  'heading with two spaces': '##  Spaced',
  'bullets of every kind': '• dot\n- dash\n+ plus\n* star',
  'bullet with tab': '-\tTabbed',
  'empty bullet': '• ',
  'numbered as typed': '1. One\n1. Again\n5. Five',
  'numbered from 3': '3. Three\n4. Four',
  'list then paragraph then list': '• a\nplain\n• b',
  'bullets next to numbers': '• a\n1. b\n• c',
  'not a list': '-dash with no space\n1.no space\n#no space',
  'indented looks like a list': '  - indented\n\t1. tabbed',
  'windows line endings': 'Line one\r\n**Bold line**\r\n• item\r\n',
  'trailing spaces': 'keeps   spaces   \nand\ttabs\t',
  'unicode': 'Café – “quotes” 🎉 **émphasis**',
  'stray asterisk next to bold': '**bold***',
  'link stays text': '[Notion](https://notion.so) roadmap',
  'quote marker stays text': '> not a quote block',
};

let failures = 0;
const check = (label, text) => {
  let out;
  try {
    out = roundTrip(text).out;
  } catch (error) {
    failures++;
    console.log(`FAIL ${label}: ${error.message}`);
    return;
  }
  if (out !== text) {
    failures++;
    console.log(`FAIL ${label}\n  in : ${JSON.stringify(text.slice(0, 300))}\n  out: ${JSON.stringify(out.slice(0, 300))}`);
  }
};

for (const [label, text] of Object.entries(handMade)) check(label, text);

const notesDir = path.join(__dirname, '..', 'notes');
const files = fs.readdirSync(notesDir, { recursive: true })
  .map(String)
  .filter((file) => /\.(txt|md)$/i.test(file) && fs.statSync(path.join(notesDir, file)).isFile());
for (const file of files) check(`notes/${file}`, fs.readFileSync(path.join(notesDir, file), 'utf8'));
SAMPLE_NOTES.forEach((note, index) => check(`sample note ${index + 1}`, note.text));

// What the editor shows: formatting becomes nodes and marks, not visible symbols.
{
  const { node } = roundTrip('# Title\n**bold** and *it*\n• item\n2. two');
  const types = [];
  node.descendants((child) => { types.push(child.type.name); });
  for (const type of ['heading', 'paragraph', 'bulletList', 'orderedList', 'listItem']) assert.ok(types.includes(type), `editor has a ${type}`);
  let visible = '';
  node.descendants((child) => { if (child.isText) visible += child.text; });
  assert.ok(!/[*#•]/.test(visible), `no markers in the editor's text, got ${JSON.stringify(visible)}`);
}

// Edits made in the editor save in the note's format.
{
  const doc = schema.nodeFromJSON({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'plain ' }, { type: 'text', text: 'bold', marks: [{ type: 'bold' }] }, { type: 'text', text: ' and ' }, { type: 'text', text: 'it', marks: [{ type: 'italic' }] }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new bullet' }] }] }] },
    { type: 'orderedList', content: [
      { type: 'listItem', attrs: { number: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'kept' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'added' }] }] },
      { type: 'listItem', attrs: { number: 2 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'pushed down' }] }] },
    ] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'New heading' }] },
  ] });
  const saved = docToNoteText(doc.toJSON());
  assert.strictEqual(saved, 'plain **bold** and *it*\n• new bullet\n1. kept\n2. added\n3. pushed down\n## New heading');
  // And that saved text opens again the same way.
  assert.strictEqual(roundTrip(saved).out, saved);
}

// Bold and italic together, as the editor makes them, save in a form that reads back the same.
{
  const text = (value, ...marks) => ({ type: 'text', text: value, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });
  const save = (...inline) => docToNoteText(schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content: inline }] }).toJSON());
  const cases = [
    [[text('both', 'bold', 'italic')], '***both***'],
    [[text('bold '), text('both', 'bold', 'italic')], 'bold ***both***'],
    [[text('a ', 'bold'), text('b', 'bold', 'italic'), text(' c', 'bold')], '**a _b_ c**'],
    [[text('a ', 'italic'), text('b', 'bold', 'italic'), text(' c', 'italic')], '*a __b__ c*'],
    [[text('a ', 'bold'), text('b', 'bold', 'italic')], '**a _b_**'],
    [[text('a', 'bold'), text('b', 'bold', 'italic'), text('c', 'italic')], '**a_b_***c*'],
  ];
  for (const [inline, expected] of cases) {
    const saved = save(...inline);
    assert.strictEqual(saved, expected, `bold+italic saves as ${expected}`);
    const { node } = roundTrip(saved);
    assert.strictEqual(roundTrip(saved).out, saved, `${saved} reads back the same`);
    const styled = [];
    node.descendants((child) => { if (child.isText) styled.push(`${child.marks.map((mark) => mark.type.name).sort().join('+') || 'plain'}:${child.text}`); });
    const wanted = inline.map((part) => `${(part.marks ?? []).map((mark) => mark.type).sort().join('+') || 'plain'}:${part.text}`);
    assert.deepStrictEqual(styled, wanted, `${saved} reopens with the same styles`);
  }
}

const total = Object.keys(handMade).length + files.length + SAMPLE_NOTES.length;
console.log(`${total - failures}/${total} notes round-tripped exactly (${files.length} from notes/, ${SAMPLE_NOTES.length} sample notes, ${Object.keys(handMade).length} hand-made).`);
if (failures) process.exit(1);
