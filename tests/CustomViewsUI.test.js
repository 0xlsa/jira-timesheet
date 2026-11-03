import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument, toHtml } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import { renderWorkingIssues, VIEW_SEARCHING, VIEW_NO_MATCHES, VIEW_FIELD_UNAVAILABLE } from '../src/ui/weekView.js';
import {
  openCustomViewEditor, NO_VALUES, VALUES_UNAVAILABLE, FIELDS_UNAVAILABLE, NO_MATCHING_VALUES, NOT_IN_JIRA,
  VIEW_SEARCH_HINT, VALUE_FILTER_THRESHOLD, VALUE_SEARCH_DELAY_MS
} from '../src/ui/customViewEditor.js';
import { validateViewDraft, describeView, SYSTEM_FIELDS, ALL_VIEW_ID } from '../src/jira/customViews.js';

const SITE = 'cloud|https://acme.atlassian.net';
const HOSTILE = '<img src=x onerror=alert(1)>';

const issue = (key, statusName = 'In Progress') => ({
  issueId: String(10000 + Number(key.split('-')[1])),
  issueKey: key,
  issueSummary: `Summary of ${key}`,
  issueStatus: { name: statusName, categoryKey: 'indeterminate' },
  inProgress: true,
  loggedInRange: false
});
/** Active's list. */
const ACTIVE = [issue('KAN-1'), issue('KAN-2', 'In Review')];

const condition = (fieldId, values, operator = 'equals') => ({ field: { id: fieldId, name: fieldId === 'reporter' ? 'Reporter' : fieldId === 'status' ? 'Status' : fieldId }, operator, values });
const REPORTED = { id: 'reported', name: 'Reported', conditions: [condition('reporter', [{ currentUser: true, label: 'Me' }])] };
const QUEUE = { id: 'queue', name: 'Development Queue', conditions: [condition('status', [{ id: '3', label: 'In Progress' }, { id: '4', label: 'In Review' }], 'isOneOf')] };

const ready = (issues, { total = issues.length, hasMore = false } = {}) => ({ status: 'ready', issues, total, hasMore, message: '' });
/** The Reported view's own search: issues Active Issues doesn't list. */
const REPORTED_RESULT = ready([issue('OPS-7', 'Backlog'), issue('OPS-8', 'Done')]);

/** renderWorkingIssues()'s `views`, from saved views and their results, recording what's asked. */
function viewsOptions(saved, { selectedId = ALL_VIEW_ID, unavailable = [], results = {}, canCreate = saved.length < 2 } = {}) {
  const calls = [];
  return {
    calls,
    views: {
      items: saved.map((view) => ({
        id: view.id, name: view.name, description: describeView(view), unavailable: unavailable.includes(view.id), result: results[view.id] ?? null
      })),
      selectedId,
      canCreate,
      onSelect: (id) => calls.push(['select', id]),
      onCreate: () => calls.push(['create']),
      onEdit: (id) => calls.push(['edit', id]),
      onRefresh: (id) => calls.push(['refresh', id])
    }
  };
}

/** The running timer, on an issue Jira's list doesn't have: Active lists it anyway. */
const RUNNING = { id: 'run', site: SITE, issueId: '10099', issueKey: 'KAN-99', issueSummary: 'Timed', startedAt: 1, accumulatedMs: 0, resumedAt: 1 };

function render({ issues = ACTIVE, status = 'ready', views, running = RUNNING, pending = true, section = h('section', { id: 'workingIssues' }), timerCalls = [], groupsExpanded, onGroupToggle } = {}) {
  renderWorkingIssues(section, {
    state: status === 'ready' ? { status, issues, includeRecentlyLogged: false } : { status, message: 'Failed' },
    expanded: true,
    onRetry: () => {},
    onLogWork: (row) => timerCalls.push(['log', row.issueKey]),
    timer: { site: SITE, running, now: 2, onStart: (row) => timerCalls.push(['start', row.issueKey]), onStop() {} },
    pending: pending ? { entries: [{ id: 'p1', site: SITE, issueId: '10001', issueKey: 'KAN-1', issueSummary: 'One', startedAt: 1, stoppedAt: 61001, timeSpentSeconds: 60, comment: '' }], site: SITE, now: 2, onEdit() {}, onDiscard() {}, onSubmit() {} } : undefined,
    groupsExpanded,
    onGroupToggle,
    recentlyLogged: { checked: false, onChange() {} },
    views
  });
  return section;
}

const tabs = (section) => section.querySelectorAll('[role="tab"]');
const tabTexts = (section) => tabs(section).map((tab) => tab.textContent);
const group = (section, id) => section.querySelectorAll('.working-issues-group').find((el) => el.getAttribute('data-group') === id);
const rowKeys = (el) => el.querySelectorAll('.working-issue').map((row) => row.querySelector('.issue-key-badge').textContent);
const groupIds = (section) => section.querySelectorAll('.working-issues-group').map((el) => el.getAttribute('data-group'));

describe('Custom views - tabs in My Issues', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  const myIssues = (section) => group(section, 'active');
  const header = (section) => section.querySelector('#workingIssuesGroupToggle-active').textContent;

  it('shows no tabs without custom views options, as before', () => {
    const section = render();
    assert.deepEqual(groupIds(section), ['active', 'pending']);
    assert.equal(tabs(section).length, 0);
    assert.equal(header(section), 'My Issues (3)');
  });

  it('keeps one My Issues group, with no Views group: Active and the custom views side by side in it', () => {
    const { views } = viewsOptions([REPORTED, QUEUE]);
    const section = render({ views });
    assert.deepEqual(groupIds(section), ['active', 'pending']);
    assert.deepEqual(section.querySelectorAll('.working-issues-group-toggle').map((el) => el.textContent), ['My Issues (3)', 'Pending Worklogs (1)']);
    assert.equal(section.querySelectorAll('[role="tablist"]').length, 1);
    assert.deepEqual(tabTexts(section), ['Active (3)', 'Reported', 'Development Queue']);
    assert.equal(myIssues(section).querySelector('.working-issues-viewbar').querySelectorAll('[role="tab"]').length, 3);
  });

  it('selects Active by default, with its whole list, the timer-only row, and Show recently logged', () => {
    const { views } = viewsOptions([REPORTED], { selectedId: ALL_VIEW_ID, results: { reported: REPORTED_RESULT } });
    const section = render({ views });
    assert.equal(tabs(section)[0].getAttribute('aria-selected'), 'true');
    assert.deepEqual(rowKeys(section), ['KAN-99', 'KAN-1', 'KAN-2']);
    assert.ok(section.querySelector('#recentlyLoggedSwitch'));
    assert.equal(section.querySelector('[data-action="edit-view"]'), null);
    assert.equal(section.querySelector('.working-issues-view-query'), null);
  });

  it('shows Active when the saved selection no longer exists', () => {
    const { views } = viewsOptions([REPORTED], { selectedId: 'deleted' });
    assert.equal(tabs(render({ views }))[0].getAttribute('aria-selected'), 'true');
  });

  it('shows a selected custom view\'s own results in the one list, instead of Active\'s, without the switch', () => {
    const { views } = viewsOptions([REPORTED], { selectedId: 'reported', results: { reported: REPORTED_RESULT } });
    const section = render({ views });
    assert.deepEqual(rowKeys(section), ['OPS-7', 'OPS-8'], 'Active\'s issues aren\'t listed too');
    assert.equal(section.querySelectorAll('.working-issues-list').length, 1);
    assert.equal(section.querySelector('.working-issues-view-query').textContent, 'Jira search: Reporter is Me');
    assert.equal(section.querySelector('#recentlyLoggedSwitch'), null);
    assert.equal(header(section), 'My Issues (2)');
    assert.equal(section.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby'), 'workingIssuesViewTab-reported');
  });

  it('counts each tab: Active its rows once loaded, a custom view once searched, 20+ when more match', () => {
    const many = (n) => Array.from({ length: n }, (_, i) => issue(`OPS-${i + 1}`));
    const { views } = viewsOptions([REPORTED, QUEUE], { selectedId: ALL_VIEW_ID, results: { reported: ready(many(20), { total: 147, hasMore: true }), queue: ready(many(20), { total: 20 }) } });
    assert.deepEqual(tabTexts(render({ views })), ['Active (3)', 'Reported (20+)', 'Development Queue (20)']);
    assert.deepEqual(tabTexts(render({ views, status: 'loading' })), ['Active', 'Reported (20+)', 'Development Queue (20)']);
    const { views: six } = viewsOptions([REPORTED], { selectedId: 'reported', results: { reported: ready(many(6)) } });
    const section = render({ views: six });
    assert.deepEqual(tabTexts(section), ['Active (3)', 'Reported (6)']);
    assert.equal(header(section), 'My Issues (6)');
  });

  it('says when more issues match than it lists, with Jira\'s count where it gives one', () => {
    const many = Array.from({ length: 20 }, (_, i) => issue(`OPS-${i + 1}`));
    const withTotal = viewsOptions([REPORTED], { selectedId: 'reported', results: { reported: ready(many, { total: 147, hasMore: true }) } });
    const section = render({ views: withTotal.views });
    assert.equal(section.querySelector('.working-issues-view-more').textContent, 'Showing the first 20 of 147 matching issues.');
    assert.equal(rowKeys(section).length, 20);
    assert.equal(header(section), 'My Issues (20+)');
    const cloudMore = viewsOptions([REPORTED], { selectedId: 'reported', results: { reported: ready(many, { total: null, hasMore: true }) } });
    assert.equal(render({ views: cloudMore.views }).querySelector('.working-issues-view-more').textContent, 'Showing the first 20 matching issues.');
    const exactly = viewsOptions([REPORTED], { selectedId: 'reported', results: { reported: ready(many, { total: 20 }) } });
    assert.equal(render({ views: exactly.views }).querySelector('.working-issues-view-more'), null);
  });

  it('never lists the timer-only row in a custom view', () => {
    const { views } = viewsOptions([REPORTED], { selectedId: 'reported', results: { reported: REPORTED_RESULT } });
    assert.ok(!rowKeys(render({ views })).includes('KAN-99'));
  });

  it('says it\'s searching Jira until the view\'s results are in, without a count', () => {
    for (const result of [null, { status: 'loading', issues: [], total: null, hasMore: false, message: '' }]) {
      const { views } = viewsOptions([REPORTED], { selectedId: 'reported', results: { reported: result } });
      const section = render({ views });
      const panel = section.querySelector('#workingIssuesViewPanel');
      assert.equal(panel.querySelector('.working-issues-empty').textContent, VIEW_SEARCHING);
      assert.equal(panel.getAttribute('aria-busy'), 'true');
      assert.deepEqual(tabTexts(section), ['Active (3)', 'Reported']);
      assert.equal(header(section), 'My Issues');
    }
  });

  it('says when no issue matches the view', () => {
    const { views } = viewsOptions([REPORTED], { selectedId: 'reported', results: { reported: ready([]) } });
    const section = render({ views });
    assert.equal(section.querySelector('#workingIssuesViewPanel').querySelector('.working-issues-empty').textContent, VIEW_NO_MATCHES);
    assert.deepEqual(tabTexts(section), ['Active (3)', 'Reported (0)']);
  });

  it('says why the search failed, with Retry, which searches again', () => {
    const { views, calls } = viewsOptions([REPORTED], { selectedId: 'reported', results: { reported: { status: 'error', issues: [], total: null, hasMore: false, message: 'Jira refused the search.' } } });
    const section = render({ views });
    const message = section.querySelector('#workingIssuesViewPanel').querySelector('.working-issues-message');
    assert.match(message.textContent, /Jira refused the search\./);
    message.querySelector('button').click();
    assert.deepEqual(calls, [['refresh', 'reported']]);
  });

  it('says when the view\'s field is gone from Jira, with Edit, and never falls back to Active', () => {
    const { views, calls } = viewsOptions([REPORTED], { selectedId: 'reported', unavailable: ['reported'] });
    const section = render({ views });
    const message = section.querySelector('#workingIssuesViewPanel').querySelector('.working-issues-message');
    assert.equal(message.querySelector('p').textContent, VIEW_FIELD_UNAVAILABLE);
    message.querySelector('button').click();
    assert.deepEqual(calls, [['edit', 'reported']]);
    assert.deepEqual(rowKeys(section), []);
    assert.equal(tabs(section)[1].classList.contains('is-unavailable'), true);
  });

  it('has + for a new view, until there are two, and the edit button only for a selected custom view', () => {
    const { views, calls } = viewsOptions([REPORTED], { selectedId: 'reported' });
    const section = render({ views });
    const bar = section.querySelector('.working-issues-viewbar');
    assert.deepEqual(bar.children.map((child) => child.getAttribute('data-action') ?? child.getAttribute('role')), ['tablist', 'edit-view', 'add-view']);
    section.querySelector('[data-action="edit-view"]').click();
    section.querySelector('[data-action="add-view"]').click();
    assert.deepEqual(calls, [['edit', 'reported'], ['create']]);
    assert.equal(section.querySelector('[data-action="edit-view"]').getAttribute('aria-label'), 'Edit the Reported view');
    assert.equal(render({ views: viewsOptions([REPORTED, QUEUE]).views }).querySelector('[data-action="add-view"]'), null);
    assert.ok(render({ views: viewsOptions([]).views }).querySelector('[data-action="add-view"]'));
    assert.equal(section.querySelector('[data-action="refresh-view"]'), null);
  });

  it('chooses a tab with a click', () => {
    const { views, calls } = viewsOptions([REPORTED, QUEUE], { selectedId: ALL_VIEW_ID });
    const section = render({ views });
    tabs(section)[0].click();
    tabs(section)[2].click();
    tabs(section)[1].click();
    assert.deepEqual(calls, [['select', 'queue'], ['select', 'reported']]);
  });

  it('is a WAI-ARIA tablist: one tab in the tab order, a labelled panel', () => {
    const { views } = viewsOptions([REPORTED, QUEUE], { selectedId: ALL_VIEW_ID });
    const section = render({ views });
    assert.equal(section.querySelector('[role="tablist"]').getAttribute('aria-label'), 'Views of My Issues');
    assert.deepEqual(tabs(section).map((tab) => [tab.getAttribute('aria-selected'), tab.getAttribute('tabindex')]), [['true', '0'], ['false', '-1'], ['false', '-1']]);
    assert.equal(tabs(section)[1].getAttribute('title'), 'Reporter is Me');
    assert.equal(section.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby'), 'workingIssuesViewTab-all');
  });

  it('moves between tabs with the arrow keys, Home, and End, focusing and choosing the new one', () => {
    const { views, calls } = viewsOptions([REPORTED, QUEUE], { selectedId: ALL_VIEW_ID });
    const section = render({ views });
    const press = (key) => section.querySelector('[role="tablist"]').dispatchEvent({ type: 'keydown', key });
    press('ArrowRight');
    assert.equal(document.activeElement, tabs(section)[1]);
    press('ArrowLeft');
    assert.equal(document.activeElement, tabs(section)[2], 'wraps to the last');
    press('End');
    press('Home');
    assert.equal(document.activeElement, tabs(section)[0]);
    assert.deepEqual(calls, [['select', 'reported'], ['select', 'queue'], ['select', 'queue']]);
  });

  it('keeps focus on the chosen tab when the section is drawn again', () => {
    const { views } = viewsOptions([REPORTED, QUEUE], { selectedId: ALL_VIEW_ID });
    const section = render({ views });
    tabs(section)[2].focus();
    render({ views: { ...views, selectedId: 'queue' }, section });
    assert.equal(document.activeElement, tabs(section)[2]);
    assert.equal(tabs(section)[2].getAttribute('aria-selected'), 'true');
  });

  it('gives a custom view\'s rows the same timer and log work buttons, on the same timer, with their own focus keys', () => {
    const timerCalls = [];
    const { views } = viewsOptions([REPORTED], { selectedId: 'reported', results: { reported: REPORTED_RESULT } });
    const panel = render({ views, timerCalls }).querySelector('#workingIssuesViewPanel');
    panel.querySelector('.working-issue-timer-btn').click();
    panel.querySelector('.working-issue-log-btn').click();
    assert.deepEqual(timerCalls, [['start', 'OPS-7'], ['log', 'OPS-7']]);
    assert.equal(panel.querySelector('.working-issue-timer-btn').getAttribute('data-focus-key'), `view-row:timer:${SITE}|OPS-7`);
  });

  it('leaves Pending Worklogs and its group as they are', () => {
    const { views } = viewsOptions([REPORTED], { selectedId: 'reported', results: { reported: REPORTED_RESULT } });
    const section = render({ views });
    const pending = group(section, 'pending');
    assert.equal(pending.querySelectorAll('[role="tab"]').length, 0);
    assert.equal(pending.querySelectorAll('.pending-worklog').length, 1);
  });

  it('shows the tabs without the Pending Worklogs group too (before the timer has loaded)', () => {
    const { views } = viewsOptions([REPORTED]);
    const section = render({ views, pending: false });
    assert.deepEqual(groupIds(section), ['active']);
    assert.deepEqual(tabTexts(section), ['Active (3)', 'Reported']);
  });

  it('shows view names and issues as text, never as markup', () => {
    const view = { id: 'x', name: HOSTILE, conditions: [condition('status', [{ id: '3', label: HOSTILE }])] };
    const { views } = viewsOptions([view], { selectedId: 'x', results: { x: ready([{ ...issue('OPS-1'), issueSummary: HOSTILE }]) } });
    const section = render({ views });
    assert.equal(section.querySelectorAll('img').length, 0);
    assert.match(toHtml(section), /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});

describe('Custom views - editor', () => {
  let restoreDocument;
  beforeEach(() => {
    restoreDocument = installFakeDocument();
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    mock.timers.reset();
    restoreDocument();
  });

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const FIELDS = [
    ...SYSTEM_FIELDS.map((field) => ({ ...field, group: 'Fields' })),
    { id: 'customfield_10050', name: 'QA Assignee', kind: 'user', group: 'Additional Assignment Fields' }
  ];
  const VALUES = {
    status: [{ id: '3', label: 'In Progress' }, { id: '4', label: 'In Review' }],
    priority: [],
    customfield_10100: [{ id: '10200', label: 'Platform' }]
  };

  function open({ view = null, views = [], loadValues, loadCustomFields, onSave, onDelete, searchDelayMs } = {}) {
    const root = h('aside', { class: 'custom-view-editor hidden' });
    const calls = [];
    const editor = openCustomViewEditor(root, {
      view,
      fields: FIELDS,
      loadCustomFields,
      loadValues: loadValues ?? (async (field) => (field.kind === 'user' ? [{ currentUser: true, label: 'Me' }] : VALUES[field.id] ?? [])),
      validate: (draft) => validateViewDraft(draft, { views, editingId: view?.id }),
      onSave: onSave ?? (async (saved) => { calls.push(['save', saved]); }),
      onDelete: view ? (onDelete ?? (async () => { calls.push(['delete']); })) : undefined,
      onClose: () => calls.push(['close']),
      searchDelayMs
    });
    const $ = (selector) => root.querySelector(selector);
    const choose = (selector, value) => {
      $(selector).value = value;
      $(selector).dispatchEvent({ type: 'change' });
    };
    const check = (...labels) => {
      for (const label of root.querySelectorAll('.custom-view-value')) {
        if (!labels.includes(label.querySelector('span').textContent)) continue;
        const input = label.querySelector('input');
        input.checked = true;
        input.dispatchEvent({ type: 'change' });
      }
    };
    const submit = () => $('form').dispatchEvent({ type: 'submit' });
    const valueLabels = () => root.querySelectorAll('.custom-view-value').map((label) => label.querySelector('span').textContent);
    const search = (text) => {
      $('#customViewValueSearch').value = text;
      $('#customViewValueSearch').dispatchEvent({ type: 'input' });
    };
    return { root, editor, calls, $, choose, check, submit, valueLabels, search };
  }

  it('opens to create a view, focused on its name, with the fields grouped', () => {
    const { root, $ } = open();
    assert.equal(root.classList.contains('hidden'), false);
    assert.equal(root.getAttribute('aria-labelledby'), 'customViewTitle');
    assert.equal($('#customViewTitle').textContent, 'New view');
    assert.equal(document.activeElement, $('#customViewName'));
    assert.equal($('#customViewName').getAttribute('maxlength'), '30');
    assert.deepEqual($('#customViewField').querySelectorAll('optgroup').map((g) => [g.getAttribute('label'), g.querySelectorAll('option').map((o) => o.textContent)]), [
      ['Fields', ['Status', 'Priority', 'Assignee', 'Reporter']],
      ['Additional Assignment Fields', ['QA Assignee']]
    ]);
    assert.equal($('#customViewOperator').disabled, true);
    assert.equal($('[data-action="delete-view"]'), null);
    // Where a view's issues come from: its own search, not Active Issues.
    assert.equal($('.custom-view-hint').textContent, VIEW_SEARCH_HINT);
    assert.match(VIEW_SEARCH_HINT, /first 20 issues you can see in Jira that match, whether Active lists them or not/);
  });

  it('offers the values Jira lists, one for Equals and several for Is one of', async () => {
    const { $, choose, valueLabels, root } = open();
    choose('#customViewField', 'status');
    await flush();
    assert.deepEqual($('#customViewOperator').querySelectorAll('option').map((o) => o.textContent), ['Equals', 'Is one of']);
    assert.deepEqual(valueLabels(), ['In Progress', 'In Review']);
    assert.ok(root.querySelectorAll('input[name="customViewValue"]').every((input) => input.getAttribute('type') === 'radio'));
    choose('#customViewOperator', 'isOneOf');
    assert.ok(root.querySelectorAll('input[name="customViewValue"]').every((input) => input.getAttribute('type') === 'checkbox'));
    assert.equal(root.querySelector('legend').textContent, 'Values');
  });

  it('offers only Equals, and only Me, for user fields', async () => {
    for (const fieldId of ['assignee', 'reporter', 'customfield_10050']) {
      const { $, choose, valueLabels, root } = open();
      choose('#customViewField', fieldId);
      await flush();
      assert.deepEqual($('#customViewOperator').querySelectorAll('option').map((o) => o.textContent), ['Equals'], fieldId);
      assert.equal($('#customViewOperator').disabled, true);
      assert.deepEqual(valueLabels(), ['Me']);
      assert.equal(root.querySelector('input[name="customViewValue"]').checked, true);
    }
  });

  it('saves a valid view: its trimmed name and one condition', async () => {
    const { $, choose, check, submit, calls } = open();
    $('#customViewName').value = '  Development Queue ';
    choose('#customViewField', 'status');
    await flush();
    choose('#customViewOperator', 'isOneOf');
    check('In Progress', 'In Review');
    submit();
    await flush();
    assert.deepEqual(calls, [
      ['save', { name: 'Development Queue', conditions: [{ field: { id: 'status', name: 'Status' }, operator: 'isOneOf', values: [{ id: '3', label: 'In Progress' }, { id: '4', label: 'In Review' }] }] }],
      ['close']
    ]);
  });

  it('saves Assignee equals Me', async () => {
    const { $, choose, submit, calls } = open();
    $('#customViewName').value = 'Mine';
    choose('#customViewField', 'assignee');
    await flush();
    submit();
    await flush();
    assert.deepEqual(calls[0][1].conditions, [{ field: { id: 'assignee', name: 'Assignee' }, operator: 'equals', values: [{ currentUser: true, label: 'Me' }] }]);
  });

  it('shows what\'s wrong and saves nothing: name, field, values, the limit', async () => {
    const empty = open();
    empty.submit();
    assert.match(empty.$('#customViewNameError').textContent, /Enter a name/);
    assert.match(empty.$('#customViewFieldError').textContent, /Choose a field/);
    assert.equal(empty.calls.length, 0);
    assert.equal(document.activeElement, empty.$('#customViewName'));

    const twoValues = open({ views: [{ id: 'x', name: 'Taken', conditions: [] }] });
    twoValues.$('#customViewName').value = 'taken';
    twoValues.choose('#customViewField', 'status');
    await flush();
    twoValues.choose('#customViewOperator', 'isOneOf');
    twoValues.check('In Progress');
    twoValues.submit();
    assert.match(twoValues.$('#customViewNameError').textContent, /Another view already has this name/);
    assert.match(twoValues.$('#customViewValuesError').textContent, /at least two values/);

    const full = open({ views: [{ id: 'a', name: 'A', conditions: [] }, { id: 'b', name: 'B', conditions: [] }] });
    full.$('#customViewName').value = 'C';
    full.choose('#customViewField', 'assignee');
    await flush();
    full.submit();
    assert.match(full.$('#customViewFormError').textContent, /at most 2 custom views/);
    assert.equal(full.calls.length, 0);
  });

  it('keeps the form and says why when saving fails', async () => {
    const { $, choose, submit, calls, editor } = open({ onSave: async () => { throw new Error('Storage is full.'); } });
    $('#customViewName').value = 'Mine';
    choose('#customViewField', 'assignee');
    await flush();
    submit();
    await flush();
    assert.equal($('#customViewFormError').textContent, 'Storage is full.');
    assert.equal(editor.isOpen, true);
    assert.deepEqual(calls, []);
  });

  it('opens a saved view to edit it, with its name, field, operator, and values', async () => {
    const view = { id: 'queue', name: 'Development Queue', conditions: [condition('status', [{ id: '3', label: 'In Progress' }, { id: '4', label: 'In Review' }], 'isOneOf')] };
    const { $, root } = open({ view, views: [view] });
    await flush();
    assert.equal($('#customViewTitle').textContent, 'Edit view');
    assert.equal($('#customViewName').value, 'Development Queue');
    assert.equal($('#customViewField').value, 'status');
    assert.equal($('#customViewOperator').value, 'isOneOf');
    assert.deepEqual(root.querySelectorAll('input[name="customViewValue"]').map((input) => input.checked), [true, true]);
  });

  it('keeps a saved status Jira doesn\'t list any more, saying so', async () => {
    const view = { id: 'queue', name: 'Queue', conditions: [condition('status', [{ id: '7', label: 'Blocked' }])] };
    const { valueLabels, root, submit, calls } = open({ view, views: [view] });
    await flush();
    assert.deepEqual(valueLabels(), ['In Progress', 'In Review', 'Blocked']);
    assert.equal(root.querySelector('.custom-view-value-note').textContent, ` (${NOT_IN_JIRA})`);
    assert.equal(root.querySelectorAll('input[name="customViewValue"]')[2].checked, true);
    submit();
    await flush();
    assert.deepEqual(calls[0][1].conditions[0].values, [{ id: '7', label: 'Blocked' }]);
  });

  it('shows a saved field that\'s gone, which can\'t be chosen again', async () => {
    const view = { id: 'team', name: 'Team', conditions: [condition('customfield_10999', [{ id: '1', label: 'X' }])] };
    const { $ } = open({ view, views: [view] });
    await flush();
    const gone = $('#customViewField').querySelectorAll('option').find((o) => o.getAttribute('value') === 'customfield_10999');
    assert.equal(gone.textContent, 'customfield_10999 (no longer available)');
    assert.equal(gone.hasAttribute('disabled'), true);
    assert.equal($('#customViewField').value, '');
  });

  it('adds the custom single-select fields once loaded, choosing a saved one with its values', async () => {
    const view = { id: 'team', name: 'Team', conditions: [condition('customfield_10100', [{ id: '10200', label: 'Platform' }])] };
    let resolve;
    const { $, root } = open({ view, views: [view], loadCustomFields: () => new Promise((r) => { resolve = r; }) });
    assert.equal($('#customViewFieldsStatus').textContent, 'Loading custom fields…');
    resolve([{ id: 'customfield_10100', name: 'Team', kind: 'option' }]);
    await flush();
    await flush();
    assert.equal($('#customViewFieldsStatus').textContent, '');
    assert.deepEqual($('#customViewField').querySelectorAll('optgroup').map((g) => g.getAttribute('label')), ['Fields', 'Additional Assignment Fields', 'Custom fields']);
    assert.equal($('#customViewField').value, 'customfield_10100');
    assert.deepEqual(root.querySelectorAll('input[name="customViewValue"]').map((input) => input.checked), [true]);
  });

  it('says when the custom fields or the values can\'t be loaded', async () => {
    const { $, choose } = open({ loadCustomFields: async () => { throw new Error('no'); }, loadValues: async () => { throw new Error('no'); } });
    await flush();
    assert.equal($('#customViewFieldsStatus').textContent, FIELDS_UNAVAILABLE);
    choose('#customViewField', 'status');
    await flush();
    assert.equal($('#customViewValues').textContent, VALUES_UNAVAILABLE);
  });

  it('says when Jira has no values for the field', async () => {
    const { $, choose } = open();
    choose('#customViewField', 'priority');
    await flush();
    assert.equal($('#customViewValues').textContent, NO_VALUES);
  });

  it('filters a long list by name, keeping what\'s chosen, and Enter doesn\'t save', async () => {
    const values = Array.from({ length: VALUE_FILTER_THRESHOLD + 2 }, (_, i) => ({ id: String(i + 1), label: i === 5 ? 'Selected for Development' : `Status ${i + 1}` }));
    const { root, choose, check, $, calls } = open({ loadValues: async () => values });
    choose('#customViewField', 'status');
    await flush();
    const filter = $('#customViewValueFilter');
    assert.ok(filter);
    assert.equal(filter.getAttribute('aria-label'), 'Filter values');
    check('Status 1');
    filter.value = 'selected';
    filter.dispatchEvent({ type: 'input' });
    const visible = root.querySelectorAll('li').filter((li) => !li.classList.contains('hidden'));
    assert.deepEqual(visible.map((li) => li.textContent), ['Selected for Development']);
    assert.equal(root.querySelectorAll('input[name="customViewValue"]').find((input) => input.value === '1').checked, true, 'still chosen');
    // dispatchEvent() answers false when a listener prevented the default (submitting the form).
    assert.equal(filter.dispatchEvent({ type: 'keydown', key: 'Enter' }), false);
    assert.deepEqual(calls, []);
    filter.value = 'zzz';
    filter.dispatchEvent({ type: 'input' });
    assert.equal(root.querySelectorAll('[role="status"]').find((el) => !el.classList.contains('hidden'))?.textContent, NO_MATCHING_VALUES);
  });

  it('has no filter for a short list', async () => {
    const { $, choose } = open({ loadValues: async () => [{ id: '3', label: 'In Progress' }] });
    choose('#customViewField', 'status');
    await flush();
    assert.equal($('#customViewValueFilter'), null);
  });

  describe('a custom field\'s values, searched in Jira', () => {
    const TEAM = { id: 'customfield_10100', name: 'Team', kind: 'option' };
    const OPTIONS = ['Platform', 'Platform Ops', 'Product', 'Cisco UC Apps'];
    function openTeam(extra = {}) {
      const asked = [];
      const editor = open({
        loadCustomFields: async () => [TEAM],
        loadValues: async (field, query) => {
          asked.push([field.id, query]);
          return OPTIONS.filter((name) => name.toLowerCase().startsWith(query.toLowerCase())).map((name) => ({ id: name, label: name }));
        },
        ...extra
      });
      return { ...editor, asked };
    }

    it('lists Jira\'s suggestions at once, with a search box', async () => {
      const { $, choose, valueLabels, asked } = openTeam();
      await flush();
      choose('#customViewField', 'customfield_10100');
      await flush();
      assert.deepEqual(asked, [['customfield_10100', '']]);
      assert.deepEqual(valueLabels(), OPTIONS);
      assert.equal($('#customViewValueSearch').getAttribute('aria-label'), 'Search values in Jira');
    });

    it('searches Jira once typing pauses, keeping the search box (and focus) as it is', async () => {
      const { $, choose, valueLabels, asked, search } = openTeam();
      await flush();
      choose('#customViewField', 'customfield_10100');
      await flush();
      const box = $('#customViewValueSearch');
      box.focus();
      search('Pl');
      search('Pla');
      assert.equal(asked.length, 1, 'not yet: typing hasn\'t paused');
      mock.timers.tick(VALUE_SEARCH_DELAY_MS);
      await flush();
      assert.deepEqual(asked.at(-1), ['customfield_10100', 'Pla']);
      assert.equal(asked.length, 2, 'once, for what was typed last');
      assert.deepEqual(valueLabels(), ['Platform', 'Platform Ops']);
      assert.equal($('#customViewValueSearch'), box);
      assert.equal(document.activeElement, box);
    });

    it('keeps the chosen values listed, checked, whatever the search shows, and saves them by name', async () => {
      const { $, choose, check, valueLabels, search, submit, calls, root } = openTeam();
      await flush();
      $('#customViewName').value = 'Teams';
      choose('#customViewField', 'customfield_10100');
      await flush();
      choose('#customViewOperator', 'isOneOf');
      check('Platform');
      search('Pro');
      mock.timers.tick(VALUE_SEARCH_DELAY_MS);
      await flush();
      assert.deepEqual(valueLabels(), ['Platform', 'Product']);
      check('Product');
      assert.deepEqual(root.querySelectorAll('input[name="customViewValue"]').map((input) => input.checked), [true, true]);
      submit();
      await flush();
      assert.deepEqual(calls[0][1].conditions[0], {
        field: { id: 'customfield_10100', name: 'Team' }, operator: 'isOneOf',
        values: [{ id: 'Platform', label: 'Platform' }, { id: 'Product', label: 'Product' }]
      });
    });

    it('searches at once on Enter, which doesn\'t save the view', async () => {
      const { $, choose, asked, calls, search } = openTeam();
      await flush();
      choose('#customViewField', 'customfield_10100');
      await flush();
      search('Cis');
      // Before typing pauses.
      assert.equal($('#customViewValueSearch').dispatchEvent({ type: 'keydown', key: 'Enter' }), false);
      await flush();
      assert.deepEqual(asked.at(-1), ['customfield_10100', 'Cis']);
      mock.timers.tick(VALUE_SEARCH_DELAY_MS);
      await flush();
      assert.equal(asked.length, 2, 'not again once the pause is over');
      assert.deepEqual(calls, []);
    });

    it('says when nothing matches, or Jira can\'t be asked', async () => {
      const { $, choose, search } = openTeam();
      await flush();
      choose('#customViewField', 'customfield_10100');
      await flush();
      search('zzz');
      mock.timers.tick(VALUE_SEARCH_DELAY_MS);
      await flush();
      assert.equal($('#customViewValueResults').textContent, NO_MATCHING_VALUES);
      const failing = openTeam({ loadValues: async () => { throw new Error('no'); } });
      await flush();
      failing.choose('#customViewField', 'customfield_10100');
      await flush();
      assert.equal(failing.$('#customViewValueResults').textContent, VALUES_UNAVAILABLE);
    });
  });

  it('deletes a view only after confirming, and Keep it goes back', async () => {
    const view = { ...QUEUE };
    const { $, calls } = open({ view, views: [view] });
    $('[data-action="delete-view"]').click();
    assert.match($('.custom-view-delete-question').textContent, /Delete the Development Queue view\?/);
    $('[data-action="keep-view"]').click();
    assert.ok($('[data-action="delete-view"]'));
    $('[data-action="delete-view"]').click();
    $('[data-action="confirm-delete-view"]').click();
    await flush();
    assert.deepEqual(calls, [['delete'], ['close']]);
  });

  it('closes without saving with Cancel, the close button, or Escape', () => {
    for (const how of ['cancel', 'close', 'escape']) {
      const { $, root, calls, editor } = open();
      if (how === 'cancel') $('[data-action="cancel-view"]').click();
      else if (how === 'close') $('[data-action="close-view-editor"]').click();
      else $('#customViewName').dispatchEvent({ type: 'keydown', key: 'Escape' });
      assert.deepEqual(calls, [['close']], how);
      assert.equal(editor.isOpen, false);
      assert.equal(root.hasAttribute('inert'), true);
    }
  });

  it('shows names and values as text, never as markup', async () => {
    const view = { id: 'x', name: HOSTILE, conditions: [condition('status', [{ id: '3', label: HOSTILE }])] };
    const { root } = open({ view, views: [view], loadValues: async () => [{ id: '3', label: HOSTILE }, { id: '4', label: 'Other' }] });
    await flush();
    root.querySelector('[data-action="delete-view"]').click();
    assert.equal(root.querySelectorAll('img').length, 0);
    assert.match(toHtml(root), /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});

describe('Custom views - tab styles', () => {
  const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
  /** A rule's declarations, by its exact selector. */
  const rule = (selector) => css.match(new RegExp(`^${selector.replace(/[.[\]()*+?^$|\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm'))?.[1] ?? '';

  it('gives every tab the issue key badges\' shape, bordered, with nothing just for Active', () => {
    const tab = rule('.working-issues-view-tab');
    assert.match(tab, /border-radius: var\(--radius-sm\);/);
    assert.match(rule('.issue-key-badge'), /border-radius: var\(--radius-sm\);/, 'the same corners as the issue keys');
    assert.doesNotMatch(tab, /999px|50%/);
    assert.match(tab, /border: 1px solid var\(--border-color\);/);
    assert.match(tab, /background-color: var\(--bg-card-elevated\);/);
    assert.doesNotMatch(css, /working-issues-view-tab[^{]*\[data-view="all"\]|#workingIssuesViewTab-all/);
  });

  it('tells the selected tab apart: the pressed look, in both themes', () => {
    const selected = rule('.working-issues-view-tab.is-selected');
    assert.match(selected, /background-color: var\(--primary-light\);/);
    assert.match(selected, /border-color: var\(--primary-border\);/);
    assert.match(rule('[data-theme="light"] .working-issues-view-tab.is-selected'), /color: var\(--primary\);/);
    assert.match(rule('.working-issues-view-tab:hover'), /background-color: var\(--bg-hover\);/);
  });

  it('keeps a visible keyboard focus ring on the tabs', () => {
    assert.match(rule('.working-issues-view-tab:focus-visible'), /outline: 2px solid var\(--border-focus\);/);
  });

  it('keeps + and the edit button round, like the rows\' buttons', () => {
    assert.ok(css.includes('.working-issues-view-btn,\n.working-issue-log-btn,\n.day-add-btn {'));
    assert.match(css, /\.working-issues-view-btn,\n\.working-issue-log-btn,\n\.day-add-btn \{[^}]*border-radius: 50%;/);
    assert.match(rule('.working-issues-viewbar .working-issues-view-btn'), /width: 26px;\s*height: 26px;/);
  });
});
