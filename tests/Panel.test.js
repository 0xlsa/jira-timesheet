import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDocument } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import { showPanel, hidePanel } from '../src/ui/panel.js';

describe('Panel - side panel transitions', () => {
  let restoreDocument;
  beforeEach(() => {
    restoreDocument = installFakeDocument();
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    mock.timers.reset();
    restoreDocument();
  });

  it('empties a panel once it has slid out, by default', () => {
    const root = h('aside', { class: 'hidden' });
    showPanel(root, h('div', { class: 'contents' }));
    hidePanel(root);
    mock.timers.tick(200);
    assert.equal(root.classList.contains('hidden'), true);
    assert.equal(root.children.length, 0);
  });

  it('keeps the contents, and anything typed in them, when asked to', () => {
    const input = h('input', { type: 'text' });
    const root = h('aside', { class: 'hidden' }, h('form', {}, input));
    showPanel(root);
    assert.equal(root.classList.contains('hidden'), false);
    input.value = 'https://jira.example.com';

    hidePanel(root, { keepContents: true });
    assert.equal(root.hasAttribute('inert'), true);
    mock.timers.tick(200);
    assert.equal(root.classList.contains('hidden'), true);
    assert.equal(root.hasAttribute('inert'), false);

    showPanel(root);
    assert.equal(root.querySelector('input'), input, 'the same field, not a new one');
    assert.equal(input.value, 'https://jira.example.com');
    assert.equal(root.classList.contains('is-closed'), false);
  });
});
