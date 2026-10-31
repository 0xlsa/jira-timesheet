/**
 * Keyboard shortcuts drawer: lists the shortcuts it's given (from the shortcut registry),
 * grouped by category, with a search field. It has no list of its own, so a newly
 * registered shortcut shows up without changes here.
 */

import { h, svg } from './dom.js';
import { groupShortcuts } from './shortcuts.js';
import { showPanel, hidePanel } from './panel.js';

const icon = (attributes, ...shapes) => svg('svg', {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'aria-hidden': 'true', ...attributes
}, ...shapes);

/**
 * Builds a shortcut's keys: each combination as keycaps side by side, alternatives
 * separated by a slash (read as "or").
 * @param {string[][]} keys
 * @returns {HTMLElement}
 */
function renderKeys(keys) {
  return h('span', { class: 'shortcut-keys' },
    keys.map((combo, index) => [
      index > 0 && h('span', { class: 'shortcut-keys-or' }, h('span', { 'aria-hidden': 'true' }, '/'), h('span', { class: 'sr-only' }, ' or ')),
      h('span', { class: 'shortcut-combo' }, combo.map((label) => h('kbd', { class: 'keycap' }, label)))
    ]));
}

/**
 * Builds the shortcut list for a search: categories with their rows, or the empty state.
 * @param {Array<object>} shortcuts
 * @param {string} query
 * @returns {Node[]}
 */
function renderList(shortcuts, query) {
  const groups = groupShortcuts(shortcuts, query);
  if (groups.length === 0) {
    return [h('p', { class: 'shortcuts-empty' }, query.trim() ? `No shortcuts match “${query.trim()}”.` : 'No shortcuts are available here.')];
  }
  return groups.map(({ category, shortcuts: rows }) => h('section', { class: 'shortcuts-group', 'aria-label': category },
    h('h3', { class: 'shortcuts-group-title' }, category),
    h('ul', { class: 'shortcuts-rows' },
      rows.map((shortcut) => h('li', { class: 'shortcut-row', 'data-shortcut-id': shortcut.id },
        h('span', { class: 'shortcut-description' }, shortcut.description),
        renderKeys(shortcut.keys))))));
}

/**
 * Opens the drawer inside `root` (an initially hidden panel element). Focus moves to the
 * search field. Escape or the close button closes it.
 *
 * @param {HTMLElement} root
 * @param {object} options
 * @param {Array<object>} options.shortcuts - Shortcuts available now (registry.list())
 * @param {() => void} options.onClose - Called as soon as the drawer closes
 * @returns {{ close: () => void, readonly isOpen: boolean }}
 */
export function openShortcutsDrawer(root, { shortcuts, onClose }) {
  const search = h('input', {
    type: 'text', id: 'shortcutsSearch', class: 'shortcuts-search-input', role: 'searchbox',
    placeholder: 'Search shortcuts', autocomplete: 'off', spellcheck: 'false', 'aria-controls': 'shortcutsList'
  });
  const clear = h('button', { type: 'button', class: 'shortcuts-search-clear hidden', 'aria-label': 'Clear search', title: 'Clear search' },
    icon({ class: 'icon' }, svg('line', { x1: '18', y1: '6', x2: '6', y2: '18' }), svg('line', { x1: '6', y1: '6', x2: '18', y2: '18' })));
  const list = h('div', { id: 'shortcutsList', class: 'shortcuts-list', tabindex: '0', role: 'region', 'aria-label': 'Shortcuts' });
  const status = h('div', { class: 'sr-only', 'aria-live': 'polite' });

  const contents = h('div', { class: 'shortcuts-drawer-body' },
    h('div', { class: 'shortcuts-header' },
      h('h2', { class: 'shortcuts-title', id: 'shortcutsTitle' }, 'Keyboard Shortcuts'),
      h('kbd', { class: 'keycap shortcuts-hint', title: 'Press ? to open or close' }, '?'),
      h('button', { type: 'button', class: 'editor-icon-btn', 'data-action': 'close-shortcuts', 'aria-label': 'Close keyboard shortcuts', title: 'Close' },
        icon({ class: 'icon' }, svg('line', { x1: '18', y1: '6', x2: '6', y2: '18' }), svg('line', { x1: '6', y1: '6', x2: '18', y2: '18' })))),
    h('div', { class: 'shortcuts-search' },
      h('label', { for: 'shortcutsSearch', class: 'sr-only' }, 'Search shortcuts'),
      icon({ class: 'shortcuts-search-icon' }, svg('circle', { cx: '11', cy: '11', r: '7' }), svg('line', { x1: '21', y1: '21', x2: '16.65', y2: '16.65' })),
      search,
      clear),
    list,
    status);

  let isOpen = true;

  function update() {
    const query = search.value;
    list.replaceChildren(...renderList(shortcuts, query));
    clear.classList.toggle('hidden', !query);
    const count = list.querySelectorAll('.shortcut-row').length;
    status.textContent = query ? `${count} ${count === 1 ? 'shortcut' : 'shortcuts'} found` : '';
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    hidePanel(root);
    onClose();
  }

  // Listeners are on the drawer's contents, which are replaced on every open, so they
  // never pile up and a closed drawer's listeners can't react.
  search.addEventListener('input', update);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      list.focus();
    }
  });
  clear.addEventListener('click', () => {
    search.value = '';
    update();
    search.focus();
  });
  contents.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="close-shortcuts"]')) close();
  });
  contents.addEventListener('keydown', (event) => {
    if (!isOpen || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });

  update();
  showPanel(root, contents);
  root.setAttribute('aria-labelledby', 'shortcutsTitle');
  search.focus();

  return {
    close,
    get isOpen() {
      return isOpen;
    }
  };
}
