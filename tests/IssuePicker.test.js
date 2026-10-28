import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDocument } from './support/fakeDom.js';
import { createIssueSuggester, renderIssuePicker, attachIssuePicker, ISSUE_SEARCH_DEBOUNCE_MS } from '../src/ui/issuePicker.js';
import { h } from '../src/ui/dom.js';

const issue = (issueKey, issueSummary = `Summary of ${issueKey}`) => ({ issueId: issueKey.split('-')[1], issueKey, issueSummary, issueStatus: null });

/** Lets pending promise callbacks run (setImmediate isn't mocked). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A search whose calls are recorded and answered by the test, in any order. */
function controllableSearch() {
  const calls = [];
  const search = (query, options) => new Promise((resolve, reject) => {
    calls.push({ query, options, resolve, reject });
  });
  return { search, calls };
}

describe('Issue picker - when to search', () => {
  let states;
  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    states = [];
  });
  afterEach(() => mock.timers.reset());

  const suggesterWith = (search) => createIssueSuggester({ search, onChange: (state) => states.push(state) });

  it('waits for a digit after the hyphen before searching', async () => {
    const { search, calls } = controllableSearch();
    const suggester = suggesterWith(search);

    for (const text of ['E', 'EK', 'EKB', 'EKB-']) suggester.update(text);
    mock.timers.tick(1000);
    await flush();

    assert.equal(calls.length, 0);
    assert.equal(suggester.state.status, 'idle');
  });

  it('debounces typing by 300 ms and searches only the latest query', async () => {
    const { search, calls } = controllableSearch();
    const suggester = suggesterWith(search);

    suggester.update('EKB-3');
    mock.timers.tick(200);
    suggester.update('EKB-30');
    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS - 1);
    assert.equal(calls.length, 0);
    assert.equal(suggester.state.status, 'loading');

    mock.timers.tick(1);
    assert.deepEqual(calls.map((c) => c.query), ['EKB-30']);
    assert.equal(calls[0].options.maxResults, 10);

    calls[0].resolve([issue('EKB-30')]);
    await flush();
    assert.equal(suggester.state.status, 'results');
    assert.deepEqual(suggester.state.issues.map((i) => i.issueKey), ['EKB-30']);
  });

  it('searches every project prefix the same way, with a normalized key', async () => {
    const { search, calls } = controllableSearch();
    const suggester = suggesterWith(search);

    for (const text of ['ekb-3', 'KAN-3', ' voss-3 ']) {
      suggester.update(text);
      mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);
    }

    assert.deepEqual(calls.map((c) => c.query), ['EKB-3', 'KAN-3', 'VOSS-3']);
  });

  it('cancels a superseded request and ignores its late response', async () => {
    const { search, calls } = controllableSearch();
    const suggester = suggesterWith(search);

    suggester.update('EKB-3');
    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);
    suggester.update('EKB-30');
    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.signal.aborted, true);
    assert.equal(calls[1].options.signal.aborted, false);

    calls[1].resolve([issue('EKB-30')]);
    await flush();
    calls[0].resolve([issue('EKB-3'), issue('EKB-31')]);
    await flush();

    assert.equal(suggester.state.query, 'EKB-30');
    assert.deepEqual(suggester.state.issues.map((i) => i.issueKey), ['EKB-30']);
  });

  it('ignores a superseded request that fails (e.g. with its AbortError)', async () => {
    const { search, calls } = controllableSearch();
    const suggester = suggesterWith(search);

    suggester.update('EKB-3');
    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);
    suggester.update('EKB-30');
    calls[0].reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    await flush();

    assert.equal(suggester.state.status, 'loading');
    assert.equal(suggester.state.query, 'EKB-30');
  });

  it('does not repeat identical requests: same key, other case or spacing, or an earlier answer', async () => {
    const { search, calls } = controllableSearch();
    const suggester = suggesterWith(search);

    suggester.update('EKB-3');
    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);
    suggester.update('ekb-3 ');
    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);
    assert.equal(calls.length, 1);
    calls[0].resolve([issue('EKB-3')]);
    await flush();

    suggester.update('EKB-30');
    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);
    calls[1].resolve([issue('EKB-30')]);
    await flush();

    // Back to EKB-3: answered from the earlier result at once.
    suggester.update('EKB-3');
    assert.equal(suggester.state.status, 'results');
    assert.deepEqual(suggester.state.issues.map((i) => i.issueKey), ['EKB-3']);
    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);
    assert.equal(calls.length, 2);
  });

  it('keeps at most 10 suggestions', async () => {
    const suggester = suggesterWith(async () => Array.from({ length: 12 }, (_, i) => issue(`EKB-${30 + i}`)));

    suggester.update('EKB-3');
    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);
    await flush();

    assert.equal(suggester.state.issues.length, 10);
  });

  it('reports empty results and failed searches', async () => {
    const empty = suggesterWith(async () => []);
    empty.update('EKB-9');
    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);
    await flush();
    assert.deepEqual({ status: empty.state.status, query: empty.state.query }, { status: 'empty', query: 'EKB-9' });

    const failing = suggesterWith(async () => { throw new Error('Access forbidden (403 Forbidden).'); });
    failing.update('EKB-3');
    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);
    await flush();
    assert.equal(failing.state.status, 'error');
    assert.equal(failing.state.error, 'Access forbidden (403 Forbidden).');
  });

  it('does not keep a failed answer, so the same key can be searched again', async () => {
    let attempts = 0;
    const suggester = suggesterWith(async () => {
      attempts++;
      if (attempts === 1) throw new Error('Request timed out after 15 seconds.');
      return [issue('EKB-3')];
    });

    suggester.update('EKB-3');
    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);
    await flush();
    suggester.update('EKB-3 ');
    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);
    await flush();

    assert.equal(attempts, 2);
    assert.equal(suggester.state.status, 'results');
  });

  it('stops a pending search when reset', async () => {
    const { search, calls } = controllableSearch();
    const suggester = suggesterWith(search);

    suggester.update('EKB-3');
    suggester.reset();
    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);

    assert.equal(calls.length, 0);
    assert.equal(suggester.state.status, 'idle');
  });
});

describe('Issue picker - field', () => {
  let restoreDocument;
  let root;
  let input;
  let selections;
  let search;

  beforeEach(() => {
    restoreDocument = installFakeDocument();
    mock.timers.enable({ apis: ['setTimeout'] });
    selections = [];
    search = controllableSearch();
    root = renderIssuePicker();
    h('div', {}, root);
    attachIssuePicker(root, {
      search: search.search,
      onSelect: (selected) => selections.push(selected),
      renderSelected: (selected) => h('div', { class: 'chosen' }, selected.issueKey)
    });
    input = root.querySelector('#worklogIssueSearch');
  });

  afterEach(() => {
    mock.timers.reset();
    restoreDocument();
  });

  const type = (text) => {
    input.value = text;
    input.dispatchEvent({ type: 'input' });
  };
  const key = (name) => input.dispatchEvent({ type: 'keydown', key: name });
  const options = () => root.querySelectorAll('[role="option"]');
  const status = () => root.querySelector('.issue-picker-status').textContent;

  async function showResults(text, issues) {
    type(text);
    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);
    search.calls.at(-1).resolve(issues);
    await flush();
  }

  it('is a labelled combobox with a hint before anything is typed', () => {
    assert.equal(input.getAttribute('role'), 'combobox');
    assert.equal(input.getAttribute('aria-controls'), 'worklogIssueOptions');
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    assert.equal(root.querySelector('label[for="worklogIssueSearch"]').textContent, 'Issue');
    assert.match(status(), /Type an issue key/);
  });

  it('shows loading, then the matching issues', async () => {
    type('EKB-3');
    assert.equal(status(), 'Searching for EKB-3…');

    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);
    search.calls[0].resolve([issue('EKB-3', 'Fix authentication'), issue('EKB-30')]);
    await flush();

    assert.equal(input.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(options().map((o) => o.querySelector('.issue-picker-option-key').textContent), ['EKB-3', 'EKB-30']);
    assert.equal(options()[0].querySelector('.issue-picker-option-summary').textContent, 'Fix authentication');
    assert.equal(status(), '2 matches.');
  });

  it('says when nothing matches and when Jira cannot be searched', async () => {
    await showResults('EKB-9', []);
    assert.match(status(), /^No issues found for EKB-9\./);
    assert.equal(options().length, 0);

    type('EKB-3');
    mock.timers.tick(ISSUE_SEARCH_DEBOUNCE_MS);
    search.calls.at(-1).reject(new Error("You don't have permission."));
    await flush();
    assert.equal(status(), "You don't have permission.");
    assert.ok(root.querySelector('.issue-picker-status').classList.contains('is-error'));
  });

  it('lets the user choose among several matches with the keyboard', async () => {
    await showResults('EKB-3', [issue('EKB-3'), issue('EKB-30'), issue('EKB-31')]);

    key('ArrowDown');
    key('ArrowDown');
    assert.equal(input.getAttribute('aria-activedescendant'), 'worklogIssueOption-1');
    assert.equal(options()[1].getAttribute('aria-selected'), 'true');

    const notSubmitted = input.dispatchEvent({ type: 'keydown', key: 'Enter' });
    assert.equal(notSubmitted, false, 'Enter picks the issue instead of submitting the form');
    assert.deepEqual(selections.map((s) => s.issueKey), ['EKB-30']);
    assert.equal(input.value, 'EKB-30');
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    assert.equal(root.querySelector('.chosen').textContent, 'EKB-30');
  });

  it('Enter without a highlighted option picks the exact key, not a shorter or longer one', async () => {
    await showResults('EKB-3086', [issue('EKB-30860'), issue('EKB-3086', 'Create Patch for 19.1.2'), issue('EKB-30864')]);

    key('Enter');

    assert.deepEqual(selections.map((s) => s.issueKey), ['EKB-3086']);
  });

  it('Enter picks nothing when several issues match and none is exactly the typed key', async () => {
    await showResults('EKB-3', [issue('EKB-30'), issue('EKB-31')]);
    key('Enter');
    assert.deepEqual(selections, []);
  });

  it('never shows or picks suggestions for an earlier input than the one in the field', async () => {
    await showResults('EKB-3086', [issue('EKB-3086', 'Create Patch for 19.1.2')]);

    // The field now says EKB-30864, but its search hasn't started (no input event yet).
    input.value = 'EKB-30864';
    key('Enter');
    options()[0]?.click();

    assert.deepEqual(selections, []);
  });

  it('lets the user choose with the mouse', async () => {
    await showResults('KAN-3', [issue('KAN-3'), issue('KAN-35')]);
    options()[1].querySelector('.issue-picker-option-summary').click();
    assert.deepEqual(selections.map((s) => s.issueKey), ['KAN-35']);
  });

  it('clears the chosen issue when the field is edited again', async () => {
    await showResults('VOSS-3', [issue('VOSS-3')]);
    options()[0].click();
    type('VOSS-31');

    assert.deepEqual(selections.map((s) => s?.issueKey ?? null), ['VOSS-3', null]);
    assert.equal(root.querySelector('.chosen'), null);
  });

  it('closes the list on Escape without letting the editor close', async () => {
    await showResults('EKB-3', [issue('EKB-3'), issue('EKB-30')]);
    let editorSawEscape = false;
    root.parentNode.addEventListener('keydown', () => { editorSawEscape = true; });

    key('Escape');

    assert.equal(input.getAttribute('aria-expanded'), 'false');
    assert.equal(editorSawEscape, false);
  });
});
