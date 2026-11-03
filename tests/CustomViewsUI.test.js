import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument, toHtml } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import { renderWorkingIssues, VIEW_NO_MATCHES, VIEW_FIELD_UNAVAILABLE } from '../src/ui/weekView.js';
import { openCustomViewEditor, NO_VALUES, VALUES_UNAVAILABLE, FIELDS_UNAVAILABLE, VALUES_LISTED, VALUES_OTHERS, NO_MATCHING_VALUES, VALUE_FILTER_THRESHOLD } from '../src/ui/customViewEditor.js';
import { matchesView, validateViewDraft, SYSTEM_FIELDS } from '../src/jira/customViews.js';

const SITE = 'cloud|https://acme.atlassian.net';
const HOSTILE = '<img src=x onerror=alert(1)>';

const issue = (key, statusId, { priority = null, assigneeIsMe = true } = {}) => ({
  issueId: String(10000 + Number(key.split('-')[1])),
  issueKey: key,
  issueSummary: `Summary of ${key}`,
  issueStatus: { name: statusId === '3' ? 'In Progress' : 'In Review', categoryKey: 'indeterminate' },
  inProgress: true,
  loggedInRange: false,
  viewFields: { status: { id: statusId, label: statusId === '3' ? 'In Progress' : 'In Review' }, priority, assignee: { isCurrentUser: assigneeIsMe } }
});
const ISSUES = [issue('KAN-1', '3'), issue('KAN-2', '4'), issue('KAN-3', '3', { assigneeIsMe: false })];

const condition = (fieldId, values, operator = 'equals') => ({ field: { id: fieldId, name: fieldId }, operator, values });
const QUEUE = { id: 'queue', name: 'Development Queue', conditions: [condition('status', [{ id: '3', label: 'In Progress' }])] };
const REVIEW = { id: 'review', name: 'Ready for QA', conditions: [condition('status', [{ id: '4', label: 'In Review' }])] };
const NOTHING = { id: 'nothing', name: 'Nothing', conditions: [condition('status', [{ id: '9', label: 'Gone' }])] };

/** renderWorkingIssues()'s `views`, from saved views, recording what's chosen. */
function viewsOptions(saved, { selectedId = 'all', unavailable = [], canCreate = saved.length < 2 } = {}) {
  const calls = [];
  return {
    calls,
    views: {
      items: saved.map((view) => ({ id: view.id, name: view.name, unavailable: unavailable.includes(view.id), matches: (i) => matchesView(i, view) })),
      selectedId,
      canCreate,
      onSelect: (id) => calls.push(['select', id]),
      onCreate: () => calls.push(['create']),
      onEdit: (id) => calls.push(['edit', id])
    }
  };
}

/** The running timer, on an issue Jira's list doesn't have: All lists it anyway. */
const RUNNING = { id: 'run', site: SITE, issueId: '10099', issueKey: 'KAN-99', issueSummary: 'Timed', startedAt: 1, accumulatedMs: 0, resumedAt: 1 };

function render({ issues = ISSUES, status = 'ready', views, running = RUNNING, pending = true } = {}) {
  const section = h('section', { id: 'workingIssues' });
  renderWorkingIssues(section, {
    state: status === 'ready' ? { status, issues, includeRecentlyLogged: false, viewFields: ['status', 'assignee'] } : { status, message: 'Failed' },
    expanded: true,
    onRetry: () => {},
    onLogWork: () => {},
    timer: { site: SITE, running, now: 2, onStart() {}, onStop() {} },
    pending: pending ? { entries: [{ id: 'p1', site: SITE, issueId: '10001', issueKey: 'KAN-1', issueSummary: 'One', startedAt: 1, stoppedAt: 61001, timeSpentSeconds: 60, comment: '' }], site: SITE, now: 2, onEdit() {}, onDiscard() {}, onSubmit() {} } : undefined,
    recentlyLogged: { checked: false, onChange() {} },
    views
  });
  return section;
}

const tabs = (section) => section.querySelectorAll('[role="tab"]');
const tabTexts = (section) => tabs(section).map((tab) => tab.textContent);
const rowKeys = (section) => section.querySelectorAll('.working-issue').map((row) => row.querySelector('.issue-key-badge').textContent);
const activeHeader = (section) => section.querySelector('#workingIssuesGroupToggle-active').textContent;

describe('Custom views - tabs in My Active Issues', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  it('shows no tabs without custom views options, as before', () => {
    const section = render();
    assert.equal(section.querySelector('[role="tablist"]'), null);
    assert.deepEqual(rowKeys(section), ['KAN-99', 'KAN-1', 'KAN-2', 'KAN-3']);
  });

  it('selects All by default, with its count, and a + button for the first view', () => {
    const { views } = viewsOptions([]);
    const section = render({ views });
    assert.deepEqual(tabTexts(section), ['All (4)']);
    assert.equal(tabs(section)[0].getAttribute('aria-selected'), 'true');
    assert.ok(section.querySelector('[data-action="add-view"]'));
    assert.equal(section.querySelector('[data-action="edit-view"]'), null);
  });

  it('counts each tab\'s issues, and hides + once there are two views', () => {
    const { views } = viewsOptions([QUEUE, REVIEW]);
    const section = render({ views });
    assert.deepEqual(tabTexts(section), ['All (4)', 'Development Queue (2)', 'Ready for QA (1)']);
    assert.equal(section.querySelector('[data-action="add-view"]'), null);
  });

  it('lists only the selected view\'s issues, without the timer-only row, and the group header counts them', () => {
    const { views } = viewsOptions([QUEUE, REVIEW], { selectedId: 'queue' });
    const section = render({ views });
    assert.deepEqual(rowKeys(section), ['KAN-1', 'KAN-3']);
    assert.equal(activeHeader(section), 'Active Issues (2)');
    // The running timer stays in the header, with its controls.
    assert.ok(!section.querySelector('.working-issues-timer').classList.contains('hidden'));
    assert.ok(section.querySelector('.working-issues-timer').querySelector('[data-timer-action="stop"]'));
  });

  it('lists every issue, with the timer-only row, in All', () => {
    const { views } = viewsOptions([QUEUE]);
    const section = render({ views });
    assert.deepEqual(rowKeys(section), ['KAN-99', 'KAN-1', 'KAN-2', 'KAN-3']);
    assert.equal(activeHeader(section), 'Active Issues (4)');
  });

  it('shows All when the saved selection no longer exists', () => {
    const { views } = viewsOptions([QUEUE], { selectedId: 'deleted' });
    const section = render({ views });
    assert.equal(section.querySelector('[aria-selected="true"]').dataset.view, 'all');
    assert.deepEqual(rowKeys(section), ['KAN-99', 'KAN-1', 'KAN-2', 'KAN-3']);
  });

  it('says when no issue matches the selected view', () => {
    const { views } = viewsOptions([NOTHING], { selectedId: 'nothing' });
    const section = render({ views });
    assert.deepEqual(rowKeys(section), []);
    assert.equal(section.querySelector('.working-issues-empty').textContent, VIEW_NO_MATCHES);
    assert.equal(VIEW_NO_MATCHES, 'No issues match this view.');
    assert.deepEqual(tabTexts(section), ['All (4)', 'Nothing (0)']);
  });

  it('says when the view\'s field is gone from Jira, with Edit, and never falls back to All', () => {
    const { views, calls } = viewsOptions([QUEUE], { selectedId: 'queue', unavailable: ['queue'] });
    const section = render({ views });
    assert.deepEqual(rowKeys(section), []);
    const message = section.querySelector('.working-issues-message');
    assert.equal(message.querySelector('p').textContent, VIEW_FIELD_UNAVAILABLE);
    assert.equal(VIEW_FIELD_UNAVAILABLE, "This view's field is no longer available in Jira.");
    message.querySelector('button').click();
    assert.deepEqual(calls, [['edit', 'queue']]);
    // Its tab has no count, and says why to screen readers.
    assert.equal(tabs(section)[1].textContent, 'Development Queue, field unavailable');
    assert.ok(tabs(section)[1].classList.contains('is-unavailable'));
  });

  it('shows the views\' tabs without counts while the issues load, with the loading message', () => {
    const { views } = viewsOptions([QUEUE], { selectedId: 'queue' });
    const section = render({ views, status: 'loading' });
    assert.deepEqual(tabTexts(section), ['All', 'Development Queue']);
    assert.equal(section.querySelector('.working-issues-empty').textContent, 'Retrieving issues from Jira…');
  });

  it('chooses a tab with a click, the selected one\'s edit button, and + for a new view', () => {
    const { views, calls } = viewsOptions([QUEUE], { selectedId: 'queue' });
    const section = render({ views });
    tabs(section)[1].click();
    tabs(section)[0].click();
    section.querySelector('[data-action="edit-view"]').click();
    section.querySelector('[data-action="add-view"]').click();
    assert.deepEqual(calls, [['select', 'all'], ['edit', 'queue'], ['create']]);
    assert.equal(section.querySelector('[data-action="edit-view"]').getAttribute('aria-label'), 'Edit the Development Queue view');
    assert.equal(section.querySelector('[data-action="add-view"]').getAttribute('aria-label'), 'New custom view');
  });

  it('is a WAI-ARIA tablist: one tab in the tab order, a labelled panel', () => {
    const { views } = viewsOptions([QUEUE, REVIEW], { selectedId: 'review' });
    const section = render({ views });
    const tablist = section.querySelector('[role="tablist"]');
    assert.equal(tablist.getAttribute('aria-label'), 'Views of My Active Issues');
    assert.deepEqual(tabs(section).map((tab) => [tab.dataset.view, tab.getAttribute('aria-selected'), tab.getAttribute('tabindex'), tab.getAttribute('aria-controls')]), [
      ['all', 'false', '-1', 'workingIssuesViewPanel'],
      ['queue', 'false', '-1', 'workingIssuesViewPanel'],
      ['review', 'true', '0', 'workingIssuesViewPanel']
    ]);
    const panel = section.querySelector('#workingIssuesViewPanel');
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), 'workingIssuesViewTab-review');
    assert.ok(panel.querySelector('.working-issues-list'));
  });

  it('moves between tabs with the arrow keys, Home, and End, focusing and choosing the new one', () => {
    const { views, calls } = viewsOptions([QUEUE, REVIEW]);
    const section = render({ views });
    const press = (key) => section.querySelector('[role="tablist"]').dispatchEvent({ type: 'keydown', key });
    press('ArrowRight');
    assert.equal(document.activeElement, tabs(section)[1]);
    press('ArrowLeft');
    assert.equal(document.activeElement, tabs(section)[2], 'wraps to the last');
    press('End');
    press('Home');
    assert.equal(document.activeElement, tabs(section)[0]);
    assert.deepEqual(calls, [['select', 'queue'], ['select', 'review'], ['select', 'review']]);
  });

  it('keeps focus on the chosen tab when the section is drawn again', () => {
    const { views } = viewsOptions([QUEUE]);
    const section = render({ views });
    tabs(section)[1].focus();
    renderWorkingIssues(section, {
      state: { status: 'ready', issues: ISSUES, includeRecentlyLogged: false }, expanded: true, views: { ...views, selectedId: 'queue' }
    });
    assert.equal(document.activeElement, tabs(section)[1]);
    assert.equal(tabs(section)[1].getAttribute('aria-selected'), 'true');
  });

  it('leaves Pending Worklogs, the groups, and Show recently logged as they are', () => {
    const { views } = viewsOptions([QUEUE], { selectedId: 'queue' });
    const section = render({ views });
    assert.deepEqual(section.querySelector('.working-issues-body').childNodes.map((g) => g.dataset.group), ['active', 'pending']);
    assert.equal(section.querySelector('#workingIssuesGroupToggle-pending').textContent, 'Pending Worklogs (1)');
    assert.ok(section.querySelector('#recentlyLoggedSwitch'));
    // The tabs are in the Active Issues group, not the header or Pending Worklogs.
    assert.ok(section.querySelector('#workingIssuesGroup-active').querySelector('[role="tablist"]'));
    assert.equal(section.querySelector('#workingIssuesGroup-pending').querySelector('[role="tablist"]'), null);
  });

  it('shows the tabs without the groups too (before the timer has loaded)', () => {
    const { views } = viewsOptions([QUEUE], { selectedId: 'queue' });
    const section = render({ views, pending: false, running: null });
    assert.deepEqual(rowKeys(section), ['KAN-1', 'KAN-3']);
    assert.ok(section.querySelector('[role="tablist"]'));
  });

  it('draws All and every custom view as the same tab, only the selected one in the pressed style', () => {
    for (const saved of [[], [QUEUE], [QUEUE, REVIEW]]) {
      for (const selectedId of ['all', ...saved.map((view) => view.id)]) {
        const { views } = viewsOptions(saved, { selectedId });
        const section = render({ views });
        assert.ok(tabs(section).every((tab) => tab.getAttribute('class').split(' ')[0] === 'working-issues-view-tab'), 'one class for every tab');
        assert.deepEqual(tabs(section).map((tab) => tab.classList.contains('is-selected')), ['all', ...saved.map((view) => view.id)].map((id) => id === selectedId));
        assert.equal(tabs(section).length, saved.length + 1);
        assert.equal(Boolean(section.querySelector('[data-action="add-view"]')), saved.length < 2);
      }
    }
  });

  describe('with Show recently logged off', () => {
    // Loaded with the recently logged issues (the page asks for them whenever there are views): KAN-4
    // is only there through a recent worklog, in a To Do status.
    const LOGGED_ONLY = { ...issue('KAN-4', '10413'), inProgress: false, loggedInRange: true,
      issueStatus: { name: 'Selected for Development', categoryKey: 'new' }, viewFields: { status: { id: '10413', label: 'Selected for Development' } } };
    const SELECTED = { id: 'selected', name: 'Selected', conditions: [condition('status', [{ id: '10413', label: 'Selected for Development' }])] };
    const renderWith = ({ checked, selectedId, issues = [...ISSUES, LOGGED_ONLY] }) => {
      const section = h('section', { id: 'workingIssues' });
      const { views } = viewsOptions([QUEUE, SELECTED], { selectedId });
      renderWorkingIssues(section, {
        state: { status: 'ready', issues, includeRecentlyLogged: true, viewFields: ['status'] },
        expanded: true,
        pending: { entries: [], site: SITE, now: 2, onEdit() {}, onDiscard() {} },
        recentlyLogged: { checked, onChange() {} },
        views
      });
      return section;
    };

    it('lists a recently logged issue in the view it matches', () => {
      const section = renderWith({ checked: false, selectedId: 'selected' });
      assert.deepEqual(rowKeys(section), ['KAN-4']);
      assert.equal(activeHeader(section), 'Active Issues (1)');
    });

    it('leaves it out of All, which lists the in-progress issues only, as the switch says', () => {
      const section = renderWith({ checked: false, selectedId: 'all' });
      assert.deepEqual(rowKeys(section), ['KAN-1', 'KAN-2', 'KAN-3']);
      assert.deepEqual(tabTexts(section), ['All (3)', 'Development Queue (2)', 'Selected (1)']);
      assert.equal(section.querySelector('.working-issues-subtitle').textContent, '3 issues · In progress');
    });

    it('says there\'s nothing in progress in All when only recently logged issues are loaded', () => {
      const section = renderWith({ checked: false, selectedId: 'all', issues: [LOGGED_ONLY] });
      assert.deepEqual(rowKeys(section), []);
      assert.equal(section.querySelector('.working-issues-empty').textContent, 'No issues in progress.');
      assert.deepEqual(tabTexts(section), ['All (0)', 'Development Queue (0)', 'Selected (1)']);
    });

    it('lists it in All too once the switch is on', () => {
      const section = renderWith({ checked: true, selectedId: 'all' });
      assert.deepEqual(rowKeys(section), ['KAN-1', 'KAN-2', 'KAN-3', 'KAN-4']);
      assert.equal(section.querySelector('.working-issues-subtitle').textContent, '4 issues · In progress and recently logged');
    });
  });

  it('shows view names as text, never as markup', () => {
    const { views } = viewsOptions([{ ...QUEUE, name: HOSTILE }], { selectedId: 'queue' });
    const section = render({ views });
    assert.match(toHtml(section), /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.equal(section.querySelectorAll('img').length, 0);
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

  function open({ view = null, views = [], loadValues, loadCustomFields, onSave, onDelete } = {}) {
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
      onClose: () => calls.push(['close'])
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
    return { root, editor, calls, $, choose, check, submit, valueLabels };
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
  });

  it('offers the values the issues have, one for Equals and several for Is one of', async () => {
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

  it('keeps a saved value the issues don\'t have now, saying so', async () => {
    const view = { id: 'queue', name: 'Queue', conditions: [condition('status', [{ id: '7', label: 'Blocked' }])] };
    const { valueLabels, root, submit, calls } = open({ view, views: [view] });
    await flush();
    assert.deepEqual(valueLabels(), ['In Progress', 'In Review', 'Blocked (not in your current issues)']);
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

  it('says when the issues have no values for the field', async () => {
    const { $, choose } = open();
    choose('#customViewField', 'priority');
    await flush();
    assert.equal($('#customViewValues').textContent, NO_VALUES);
  });

  it('offers the values of the issues loaded since, keeping what\'s chosen', async () => {
    let values = [{ id: '10100', label: 'Demo' }, { id: '3', label: 'In Progress' }];
    const { editor, choose, check, valueLabels, root } = open({ loadValues: async () => values });
    choose('#customViewField', 'status');
    await flush();
    choose('#customViewOperator', 'isOneOf');
    check('Demo');
    assert.deepEqual(valueLabels(), ['Demo', 'In Progress']);
    values = [...values, { id: '10102', label: 'Selected for Development' }];
    editor.refreshValues();
    await flush();
    assert.deepEqual(valueLabels(), ['Demo', 'In Progress', 'Selected for Development']);
    assert.deepEqual(root.querySelectorAll('input[name="customViewValue"]').map((input) => input.checked), [true, false, false]);
  });

  it('keeps the values shown when loading them again fails, and does nothing closed or without a field', async () => {
    let fail = false;
    const calls = [];
    const { editor, choose, valueLabels, $ } = open({
      loadValues: async () => {
        calls.push(true);
        if (fail) throw new Error('no');
        return [{ id: '3', label: 'In Progress' }];
      }
    });
    editor.refreshValues();
    assert.equal(calls.length, 0, 'no field chosen yet');
    choose('#customViewField', 'status');
    await flush();
    fail = true;
    editor.refreshValues();
    await flush();
    assert.deepEqual(valueLabels(), ['In Progress']);
    assert.doesNotMatch($('#customViewValues').textContent, /Couldn't load/);
    editor.close();
    editor.refreshValues();
    assert.equal(calls.length, 2);
  });

  it('offers Jira\'s other values after the listed issues\' ones, under their headings', async () => {
    const values = [
      { id: '11817', label: 'Demo', listed: true }, { id: '3', label: 'In Progress', listed: true },
      { id: '12912', label: 'Backlog', listed: false }, { id: '10413', label: 'Selected for Development', listed: false }
    ];
    const { root, choose, valueLabels, check, submit, $, calls } = open({ loadValues: async () => values });
    $('#customViewName').value = 'Selected';
    choose('#customViewField', 'status');
    await flush();
    assert.deepEqual(root.querySelectorAll('.custom-view-values-heading').map((el) => el.textContent), [VALUES_LISTED, VALUES_OTHERS]);
    assert.deepEqual(VALUES_LISTED, 'In your active issues');
    assert.deepEqual(VALUES_OTHERS, 'Also in Jira');
    assert.deepEqual(valueLabels(), ['Demo', 'In Progress', 'Backlog', 'Selected for Development']);
    check('Selected for Development');
    submit();
    await flush();
    assert.deepEqual(calls[0][1].conditions[0].values, [{ id: '10413', label: 'Selected for Development' }]);
  });

  it('shows no headings when the values are of one kind', async () => {
    const { root, choose } = open({ loadValues: async () => [{ id: '3', label: 'In Progress', listed: true }] });
    choose('#customViewField', 'status');
    await flush();
    assert.equal(root.querySelectorAll('.custom-view-values-heading').length, 0);
  });

  it('filters a long list by name, keeping what\'s chosen, and Enter doesn\'t save', async () => {
    const values = Array.from({ length: VALUE_FILTER_THRESHOLD + 2 }, (_, i) => ({ id: String(i + 1), label: i === 5 ? 'Selected for Development' : `Status ${i + 1}`, listed: i < 3 }));
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
    // The issues' group has nothing matching: its heading goes too.
    assert.deepEqual(root.querySelectorAll('.custom-view-value-group').map((g) => g.classList.contains('hidden')), [true, false]);
    assert.equal(root.querySelectorAll('input[name="customViewValue"]').find((input) => input.value === '1').checked, true, 'still chosen');
    // dispatchEvent() answers false when a listener prevented the default (submitting the form).
    assert.equal(filter.dispatchEvent({ type: 'keydown', key: 'Enter' }), false);
    assert.deepEqual(calls, []);
    filter.value = 'zzz';
    filter.dispatchEvent({ type: 'input' });
    assert.equal(root.querySelectorAll('[role="status"]').find((el) => !el.classList.contains('hidden'))?.textContent, NO_MATCHING_VALUES);
  });

  it('has no filter for a short list', async () => {
    const { $, choose } = open({ loadValues: async () => [{ id: '3', label: 'In Progress', listed: true }] });
    choose('#customViewField', 'status');
    await flush();
    assert.equal($('#customViewValueFilter'), null);
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
    const { root } = open({ view, views: [view], loadValues: async () => [{ id: '3', label: HOSTILE }] });
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

  it('gives every tab the issue key badges\' shape, bordered, with nothing just for All', () => {
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
