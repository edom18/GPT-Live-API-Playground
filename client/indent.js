import { indentMore } from '@codemirror/commands';

export function insertFourSpaces({ state, dispatch }) {
  if (state.readOnly) return false;
  if (state.selection.ranges.some(range => !range.empty)) return indentMore({ state, dispatch });
  dispatch(state.update(state.replaceSelection('    '), { scrollIntoView: true, userEvent: 'input' }));
  return true;
}
