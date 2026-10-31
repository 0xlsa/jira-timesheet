/**
 * Issue picker for the Log work panel: an autocomplete field that finds Jira issues by key.
 *
 * - createIssueSuggester(): when and what to search. Debounces input, skips input that isn't
 *   a partial key yet, reuses earlier answers, cancels superseded requests, and ignores late
 *   responses. No DOM; the search itself is an injected callback.
 * - renderIssuePicker(): the field, built as DOM nodes.
 * - attachIssuePicker(): keeps the DOM in sync with a suggester and handles keyboard and mouse.
 */

import { h } from './dom.js';
import { ISSUE_SUGGESTION_LIMIT, parseIssueKeyQuery } from '../jira/issueKeySearch.js';

export const ISSUE_SEARCH_DEBOUNCE_MS = 300;

// Keys the Issue field handles itself (see its keydown listener), for the keyboard
// shortcuts drawer (see src/ui/shortcuts.js).
export const ISSUE_PICKER_SHORTCUTS = [
  { id: 'issue-picker.move', description: 'Move through issue suggestions', category: 'Worklog form', keys: [['↑'], ['↓']] },
  { id: 'issue-picker.choose', description: 'Choose the highlighted issue', category: 'Worklog form', keys: [['Enter']] },
  { id: 'issue-picker.dismiss', description: 'Close the issue suggestions', category: 'Worklog form', keys: [['Esc']] }
];

const IDLE = Object.freeze({ status: 'idle', query: '', issues: [], error: '' });

/**
 * Creates the search state for one picker.
 *
 * @param {object} options
 * @param {(query: string, options: { maxResults: number, signal: AbortSignal }) => Promise<Array<object>>} options.search
 *   Finds issues for a normalized partial key (e.g. JiraClient#suggestIssuesByKey)
 * @param {(state: { status: 'idle' | 'loading' | 'results' | 'empty' | 'error', query: string,
 *   issues: Array<object>, error: string }) => void} options.onChange - Called on every state change
 * @param {number} [options.delayMs=ISSUE_SEARCH_DEBOUNCE_MS]
 * @param {number} [options.limit=ISSUE_SUGGESTION_LIMIT]
 */
export function createIssueSuggester({ search, onChange, delayMs = ISSUE_SEARCH_DEBOUNCE_MS, limit = ISSUE_SUGGESTION_LIMIT }) {
  // Answers by normalized key, so typing back to an earlier query doesn't ask Jira again.
  const answers = new Map();
  let state = IDLE;
  let query = '';
  let timer = null;
  let controller = null;
  // Bumped whenever a pending search stops mattering; a response for an older one is dropped.
  let generation = 0;

  function set(next) {
    state = next;
    onChange(state);
  }

  function cancelPending() {
    clearTimeout(timer);
    timer = null;
    controller?.abort();
    controller = null;
    generation++;
  }

  async function run(key) {
    timer = null;
    const current = generation;
    controller = new AbortController();
    try {
      const issues = (await search(key, { maxResults: limit, signal: controller.signal })).slice(0, limit);
      if (current !== generation) return;
      answers.set(key, issues);
      set({ status: issues.length > 0 ? 'results' : 'empty', query: key, issues, error: '' });
    } catch (err) {
      if (current !== generation) return;
      set({ status: 'error', query: key, issues: [], error: err?.message || "Jira couldn't be searched." });
    } finally {
      if (current === generation) controller = null;
    }
  }

  return {
    get state() {
      return state;
    },

    /**
     * Call with the field's text after every change.
     * @param {string} text
     */
    update(text) {
      const key = parseIssueKeyQuery(text)?.key ?? '';
      // Same query as the one shown or pending (only spaces or letter case changed).
      if (key === query && (key === '' || state.status !== 'error')) return;

      cancelPending();
      query = key;
      if (!key) {
        set(IDLE);
      } else if (answers.has(key)) {
        const issues = answers.get(key);
        set({ status: issues.length > 0 ? 'results' : 'empty', query: key, issues, error: '' });
      } else {
        set({ status: 'loading', query: key, issues: [], error: '' });
        timer = setTimeout(() => run(key), delayMs);
      }
    },

    /** Stops any pending search and returns to idle, e.g. after an issue is chosen. */
    reset() {
      cancelPending();
      query = '';
      state = IDLE;
    }
  };
}

/**
 * Builds the issue field: a combobox with its suggestion list, status line, error, and the
 * chosen issue (filled in by attachIssuePicker()).
 * @returns {HTMLElement}
 */
export function renderIssuePicker() {
  return h('div', { class: 'form-group issue-picker', 'data-issue-picker': true },
    h('label', { for: 'worklogIssueSearch', class: 'form-label' }, 'Issue'),
    h('div', { class: 'issue-picker-field' },
      h('input', {
        type: 'text', id: 'worklogIssueSearch', class: 'issue-picker-input', role: 'combobox',
        autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', placeholder: 'Issue key, e.g. ABC-123',
        'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'worklogIssueOptions',
        'aria-describedby': 'worklogIssueStatus worklogIssueError'
      }),
      h('ul', { id: 'worklogIssueOptions', class: 'issue-picker-options hidden', role: 'listbox', 'aria-label': 'Matching issues' })),
    h('div', { id: 'worklogIssueStatus', class: 'field-hint issue-picker-status', 'aria-live': 'polite' }),
    h('div', { id: 'worklogIssueError', class: 'field-error', 'data-error-for': 'issue' }),
    h('div', { class: 'issue-picker-selected', 'data-selected-issue': true }));
}

/**
 * Status line under the field.
 * @param {{ status: string, query: string, issues: Array<object>, error: string }} state
 * @param {object | null} selected
 * @returns {string}
 */
function statusText(state, selected) {
  if (selected) return '';
  switch (state.status) {
    case 'loading': return `Searching for ${state.query}…`;
    case 'empty': return `No issues found for ${state.query}. Check the key, and that you can see that project in Jira.`;
    case 'error': return state.error;
    case 'results':
      return state.issues.length >= ISSUE_SUGGESTION_LIMIT
        ? `Showing the first ${state.issues.length} matches. Type more of the key to narrow them.`
        : `${state.issues.length} ${state.issues.length === 1 ? 'match' : 'matches'}.`;
    default: return 'Type an issue key with its number, such as ABC-123.';
  }
}

/**
 * Wires up a picker built by renderIssuePicker().
 *
 * @param {HTMLElement} root - The `[data-issue-picker]` element
 * @param {object} options
 * @param {Function} options.search - See createIssueSuggester()
 * @param {(issue: object | null) => void} options.onSelect - An issue was chosen, or the
 *   chosen issue was cleared by typing in the field
 * @param {(issue: object) => Node} options.renderSelected - Builds the chosen issue's summary
 * @param {number} [options.delayMs]
 * @returns {{ readonly input: HTMLInputElement, destroy: () => void }}
 */
export function attachIssuePicker(root, { search, onSelect, renderSelected, delayMs }) {
  const input = root.querySelector('.issue-picker-input');
  const list = root.querySelector('.issue-picker-options');
  const status = root.querySelector('.issue-picker-status');
  const selectedEl = root.querySelector('[data-selected-issue]');
  let selected = null;
  let activeIndex = -1;

  const suggester = createIssueSuggester({ search, onChange: render, delayMs });

  function isOpen() {
    return !list.classList.contains('hidden');
  }

  /** Suggestions for exactly what's in the field now; never those of an earlier input. */
  function currentIssues(state = suggester.state) {
    if (selected || state.query !== (parseIssueKeyQuery(input.value)?.key ?? '')) return [];
    return state.issues;
  }

  function render(state = suggester.state) {
    const issues = currentIssues(state);
    if (activeIndex >= issues.length) activeIndex = -1;

    list.replaceChildren(...issues.map((issue, index) => h('li', {
      id: `worklogIssueOption-${index}`, class: `issue-picker-option${index === activeIndex ? ' is-active' : ''}`,
      role: 'option', 'aria-selected': index === activeIndex ? 'true' : 'false', 'data-index': String(index)
    },
    h('span', { class: 'issue-picker-option-key' }, issue.issueKey),
    h('span', { class: 'issue-picker-option-summary', title: issue.issueSummary || '' }, issue.issueSummary || 'No summary available'))));

    const open = issues.length > 0;
    list.classList.toggle('hidden', !open);
    input.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (activeIndex >= 0) input.setAttribute('aria-activedescendant', `worklogIssueOption-${activeIndex}`);
    else input.removeAttribute('aria-activedescendant');

    status.textContent = statusText(state, selected);
    status.classList.toggle('is-error', !selected && state.status === 'error');
    selectedEl.replaceChildren(...(selected ? [renderSelected(selected)] : []));
  }

  function choose(index) {
    const issue = currentIssues()[index];
    if (!issue) return;
    selected = issue;
    activeIndex = -1;
    input.value = issue.issueKey;
    suggester.reset();
    render();
    onSelect(issue);
  }

  function close() {
    activeIndex = -1;
    list.classList.add('hidden');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  input.addEventListener('input', () => {
    if (selected) {
      selected = null;
      onSelect(null);
    }
    activeIndex = -1;
    suggester.update(input.value);
    render();
  });

  input.addEventListener('keydown', (event) => {
    const issues = currentIssues();
    const count = issues.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (selected || count === 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      activeIndex = activeIndex < 0 ? (step > 0 ? 0 : count - 1) : (activeIndex + step + count) % count;
      render();
    } else if (event.key === 'Enter' && isOpen()) {
      // Choose the highlighted issue, else the one whose key is exactly what was typed (or the
      // only one), instead of submitting the form.
      event.preventDefault();
      const exactIndex = issues.findIndex((issue) => issue.issueKey === suggester.state.query);
      if (activeIndex >= 0) choose(activeIndex);
      else if (exactIndex >= 0) choose(exactIndex);
      else if (count === 1) choose(0);
    } else if (event.key === 'Escape' && isOpen()) {
      // Close the list only; the editor's own Escape handling shouldn't close the panel.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  // Keep focus in the field while clicking an option.
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const option = event.target.closest('[data-index]');
    if (option) choose(Number(option.dataset.index));
  });

  render();

  return {
    get input() {
      return input;
    },
    /** Cancels any pending search; call when the panel closes. */
    destroy() {
      suggester.reset();
    }
  };
}
