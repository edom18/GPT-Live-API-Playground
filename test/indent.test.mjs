import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, EditorSelection } from '@codemirror/state';
import { indentUnit } from '@codemirror/language';
import { indentLess } from '@codemirror/commands';
import { insertFourSpaces } from '../client/indent.js';

test('Tab inserts spaces at the cursor and indents multiline selection by four spaces', () => {
  let state = EditorState.create({ doc: 'ab', selection: { anchor: 1 }, extensions: [indentUnit.of('    ')] });
  const dispatch = transaction => { state = transaction.state; };
  insertFourSpaces({ state, dispatch });
  assert.equal(state.doc.toString(), 'a    b');
  assert.equal(state.selection.main.head, 5);
  state = EditorState.create({ doc: 'one\ntwo', selection: EditorSelection.range(0, 7), extensions: [indentUnit.of('    ')] });
  insertFourSpaces({ state, dispatch });
  assert.equal(state.doc.toString(), '    one\n    two');
  indentLess({ state, dispatch });
  assert.equal(state.doc.toString(), 'one\ntwo');
});
