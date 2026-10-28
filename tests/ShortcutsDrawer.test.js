import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDocument } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import { createShortcutRegistry } from '../src/ui/shortcuts.js';
import { openShortcutsDrawer } from '../src/ui/shortcutsDrawer.js';

describe('ShortcutsDrawer', () => {
  let restoreDocument;
  beforeEach(() => {
    restoreDocument = installFakeDocument();
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    mock.timers.reset();
    restoreDocument();
  });

  /** A registry like the page's, with a "+ available" switch. */
  function setup({ logWorkAvailable = true } = {}) {
    const shortcuts = createShortcutRegistry();
    shortcuts.register({ id: 'help', key: '?', keys: [['?']], description: 'Show or hide keyboard shortcuts', category: 'General', handler: () => {} });
    shortcuts.register({ id: 'close', keys: [['Esc']], description: 'Close keyboard shortcuts', category: 'General' });
    shortcuts.register({ id: 'log', key: '+', keys: [['+']], description: 'Log work', category: 'Worklogs', when: () => logWorkAvailable, handler: () => {} });
    shortcuts.register({ id: 'move', keys: [['↑'], ['↓']], description: 'Move through issue suggestions', category: 'Worklog form', when: () => false });
    return shortcuts;
  }

  function open(shortcuts) {
    const root = h('aside', { class: 'shortcuts-drawer hidden' });
    const closed = [];
    const drawer = openShortcutsDrawer(root, { shortcuts: shortcuts.list(), onClose: () => closed.push(true) });
    return { root, drawer, closed };
  }

  const categories = (root) => root.querySelectorAll('.shortcuts-group-title').map((el) => el.textContent);
  const rows = (root) => root.querySelectorAll('.shortcut-row').map((el) => el.dataset.shortcutId);
  const type = (root, text) => {
    const search = root.querySelector('#shortcutsSearch');
    search.value = text;
    search.dispatchEvent({ type: 'input' });
  };

  it('opens with its heading, the ? hint, a labelled search field, and focus in the search', () => {
    const { root } = open(setup());
    assert.equal(root.classList.contains('hidden'), false);
    assert.equal(root.getAttribute('aria-labelledby'), 'shortcutsTitle');
    assert.equal(root.querySelector('#shortcutsTitle').textContent, 'Keyboard Shortcuts');
    assert.equal(root.querySelector('.shortcuts-hint').textContent, '?');
    assert.equal(root.querySelector('label[for="shortcutsSearch"]').textContent, 'Search shortcuts');
    assert.equal(root.querySelector('[data-action="close-shortcuts"]').getAttribute('aria-label'), 'Close keyboard shortcuts');
    assert.equal(document.activeElement, root.querySelector('#shortcutsSearch'));
  });

  it('lists exactly the available registered shortcuts, by category, with keycaps', () => {
    const { root } = open(setup());
    assert.deepEqual(categories(root), ['General', 'Worklogs']);
    assert.deepEqual(rows(root), ['help', 'close', 'log']);
    const help = root.querySelector('.shortcut-row[data-shortcut-id="help"]');
    assert.equal(help.querySelector('.shortcut-description').textContent, 'Show or hide keyboard shortcuts');
    assert.deepEqual(help.querySelectorAll('kbd').map((k) => k.textContent), ['?']);
  });

  it('hides categories with nothing available here', () => {
    const { root } = open(setup({ logWorkAvailable: false }));
    assert.deepEqual(categories(root), ['General']);
  });

  it('shows a newly registered shortcut without any change to the drawer', () => {
    const shortcuts = setup();
    shortcuts.register({ id: 'palette', key: 'k', keys: [['Ctrl', 'K']], description: 'Open the command palette', category: 'Navigation', handler: () => {} });
    const { root } = open(shortcuts);
    assert.deepEqual(categories(root), ['General', 'Navigation', 'Worklogs']);
    const palette = root.querySelector('.shortcut-row[data-shortcut-id="palette"]');
    assert.deepEqual(palette.querySelectorAll('kbd').map((k) => k.textContent), ['Ctrl', 'K']);
  });

  it('shows alternatives as separate keys, read as "or"', () => {
    const shortcuts = createShortcutRegistry();
    shortcuts.register({ id: 'move', keys: [['↑'], ['↓']], description: 'Move', category: 'Worklog form' });
    const { root } = open(shortcuts);
    assert.deepEqual(root.querySelectorAll('kbd.keycap').map((k) => k.textContent).slice(1), ['↑', '↓']);
    assert.equal(root.querySelector('.shortcut-keys-or').textContent, '/ or ');
  });

  it('filters as the user types: description, category, and keys', () => {
    const { root } = open(setup());
    type(root, 'log work');
    assert.deepEqual(rows(root), ['log']);
    type(root, 'general');
    assert.deepEqual(rows(root), ['help', 'close']);
    type(root, 'esc');
    assert.deepEqual(rows(root), ['close']);
    assert.equal(root.querySelector('[aria-live="polite"]').textContent, '1 shortcut found');
  });

  it('clears the search with the clear button, which shows only while there is a query', () => {
    const { root } = open(setup());
    const clear = root.querySelector('.shortcuts-search-clear');
    assert.equal(clear.classList.contains('hidden'), true);
    type(root, 'esc');
    assert.equal(clear.classList.contains('hidden'), false);
    assert.equal(clear.getAttribute('aria-label'), 'Clear search');

    clear.click();
    assert.equal(root.querySelector('#shortcutsSearch').value, '');
    assert.deepEqual(rows(root), ['help', 'close', 'log']);
    assert.equal(clear.classList.contains('hidden'), true);
    assert.equal(document.activeElement, root.querySelector('#shortcutsSearch'));
  });

  it('shows an empty state when nothing matches', () => {
    const { root } = open(setup());
    type(root, 'zzz');
    assert.deepEqual(rows(root), []);
    assert.equal(root.querySelector('.shortcuts-empty').textContent, 'No shortcuts match “zzz”.');
  });

  it('moves from the search to the list with the down arrow', () => {
    const { root } = open(setup());
    root.querySelector('#shortcutsSearch').dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
    assert.equal(document.activeElement, root.querySelector('#shortcutsList'));
    assert.equal(root.querySelector('#shortcutsList').getAttribute('tabindex'), '0');
  });

  it('closes with Escape (without letting it reach anything else) and with the close button', () => {
    for (const close of [
      (root) => root.querySelector('#shortcutsSearch').dispatchEvent({ type: 'keydown', key: 'Escape' }),
      (root) => root.querySelector('.shortcuts-list').dispatchEvent({ type: 'keydown', key: 'Escape' }),
      (root) => root.querySelector('[data-action="close-shortcuts"]').click()
    ]) {
      const { root, drawer, closed } = open(setup());
      let escapeReachedPage = false;
      h('div', {}, root).addEventListener('keydown', () => { escapeReachedPage = true; });
      close(root);
      assert.deepEqual(closed, [true]);
      assert.equal(drawer.isOpen, false);
      assert.equal(escapeReachedPage, false);
      assert.equal(root.hasAttribute('inert'), true, 'a closing drawer takes no focus');
      mock.timers.tick(200);
      assert.equal(root.classList.contains('hidden'), true);
      assert.equal(root.children.length, 0);
    }
  });

  it('closes once, and leaves no listeners from earlier openings', () => {
    const shortcuts = setup();
    const root = h('aside', { class: 'shortcuts-drawer hidden' });
    let closes = 0;
    const first = openShortcutsDrawer(root, { shortcuts: shortcuts.list(), onClose: () => closes++ });
    first.close();
    first.close();
    mock.timers.tick(200);
    openShortcutsDrawer(root, { shortcuts: shortcuts.list(), onClose: () => closes++ });

    assert.equal(closes, 1);
    assert.equal(root.querySelectorAll('.shortcuts-drawer-body').length, 1);
    assert.equal(Object.values(root.listeners).flat().length, 0, 'listeners live on the contents, which are replaced');
  });
});
