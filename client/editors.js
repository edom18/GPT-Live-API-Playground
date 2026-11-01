import { basicSetup, EditorView } from 'codemirror';
import { Compartment, Transaction } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { vim } from '@replit/codemirror-vim';

export function mountEditors() {
  const toggle = document.getElementById('vimMode');
  let enabled = false;
  try { enabled = localStorage.getItem('live-lab-vim') === 'true'; } catch {}
  toggle.checked = enabled;
  const editors = [];
  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  for (const textarea of document.querySelectorAll('textarea')) {
    const host = document.createElement('div');
    host.className = 'code-editor' + (textarea.id === 'code' ? ' delegation-editor' : '');
    textarea.after(host);
    const mode = new Compartment();
    const language = textarea.id === 'code' ? javascript() : textarea.id === 'rawCode' ? json() : [];
    const label = textarea.getAttribute('aria-label') || textarea.closest('label')?.querySelector('span')?.textContent || textarea.id;
    const view = new EditorView({
      doc: textarea.value,
      parent: host,
      extensions: [
        mode.of(enabled ? vim() : []), basicSetup, language, oneDark,
        EditorView.cspNonce.of(document.querySelector('meta[name="style-nonce"]').content),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': label, 'aria-describedby': 'editorHelp' }),
        EditorView.updateListener.of(update => {
          if (!update.docChanged) return;
          valueDescriptor.set.call(textarea, update.state.doc.toString());
          // Preserve existing preview and draft-save listeners.
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }),
      ],
    });
    // Existing configuration, preset and history code reads/writes textarea.value.
    // Route those writes through the actual editor to keep a single document.
    Object.defineProperty(textarea, 'value', {
      configurable: true,
      get() { return view.state.doc.toString(); },
      set(value) {
        const text = String(value ?? '');
        if (text !== view.state.doc.toString()) view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          annotations: Transaction.addToHistory.of(false),
        });
      },
    });
    textarea.hidden = true;
    editors.push({ view, mode });
  }
  toggle.addEventListener('change', () => {
    try { localStorage.setItem('live-lab-vim', String(toggle.checked)); } catch {}
    for (const { view, mode } of editors) view.dispatch({ effects: mode.reconfigure(toggle.checked ? vim() : []) });
  });
}
