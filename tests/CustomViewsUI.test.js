import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument, toHtml } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import { renderWorkingIssues, VIEW_SEARCHING, VIEW_NO_MATCHES, VIEW_FIELD_UNAVAILABLE, VIEW_UPDATING, VIEW_MOVE_HINT } from '../src/ui/weekView.js';
import {
  openCustomViewEditor, NO_VALUES, VALUES_UNAVAILABLE, FIELDS_UNAVAILABLE, NO_MATCHING_VALUES, NOT_IN_JIRA,
  VIEW_SEARCH_HINT, VALUE_FILTER_THRESHOLD, VALUE_SEARCH_DELAY_MS, ADD_CONDITION
} from '../src/ui/customViewEditor.js';
import { validateViewDraft, describeView, SYSTEM_FIELDS, ALL_VIEW_ID, MAX_CUSTOM_VIEWS } from '../src/jira/customViews.js';

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

const condition = (fieldId, values, operator = 'in') => ({ field: { id: fieldId, name: fieldId === 'reporter' ? 'Reporter' : fieldId === 'status' ? 'Status' : fieldId }, operator, values });
const REPORTED = { id: 'reported', name: 'Reported', conditions: [condition('reporter', [{ currentUser: true, label: 'Me' }])] };
const QUEUE = { id: 'queue', name: 'Development Queue', conditions: [condition('status', [{ id: '3', label: 'In Progress' }, { id: '4', label: 'In Review' }], 'in')] };

const ready = (issues, { total = issues.length, hasMore = false } = {}) => ({ status: 'ready', issues, total, hasMore, message: '' });
/** The Reported view's own search: issues Active Issues doesn't list. */
const REPORTED_RESULT = ready([issue('OPS-7', 'Backlog'), issue('OPS-8', 'Done')]);

/** renderWorkingIssues()'s `views`, from saved views and their results, recording what's asked. */
function viewsOptions(saved, { selectedId = ALL_VIEW_ID, unavailable = [], results = {}, canCreate = saved.length < MAX_CUSTOM_VIEWS, canReorder = saved.length > 1, announcement = '' } = {}) {
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
      onRefresh: (id) => calls.push(['refresh', id]),
      canReorder,
      onMove: (id, toIndex) => calls.push(['move', id, toIndex]),
      announcement
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

describe('Custom views - tabs in Issues', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  const myIssues = (section) => group(section, 'active');
  const header = (section) => section.querySelector('#workingIssuesGroupToggle-active').textContent;

  it('shows no tabs without custom views options, as before', () => {
    const section = render();
    assert.deepEqual(groupIds(section), ['active', 'pending']);
    assert.equal(tabs(section).length, 0);
    assert.equal(header(section), 'Issues (3)');
  });

  it('keeps one Issues group, with no Views group: Active and the custom views side by side in it', () => {
    const { views } = viewsOptions([REPORTED, QUEUE]);
    const section = render({ views });
    assert.deepEqual(groupIds(section), ['active', 'pending']);
    assert.deepEqual(section.querySelectorAll('.working-issues-group-toggle').map((el) => el.textContent), ['Issues (3)', 'Pending Worklogs (1)']);
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
    assert.equal(section.querySelector('.working-issues-view-query').textContent, 'Jira search: Reporter in Me · Updated, descending');
    assert.equal(section.querySelector('#recentlyLoggedSwitch'), null);
    assert.equal(header(section), 'Issues (2)');
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
    assert.equal(header(section), 'Issues (6)');
  });

  it('says when more issues match than it lists, with Jira\'s count where it gives one', () => {
    const many = Array.from({ length: 20 }, (_, i) => issue(`OPS-${i + 1}`));
    const withTotal = viewsOptions([REPORTED], { selectedId: 'reported', results: { reported: ready(many, { total: 147, hasMore: true }) } });
    const section = render({ views: withTotal.views });
    assert.equal(section.querySelector('.working-issues-view-more').textContent, 'Showing the first 20 of 147 matching issues.');
    assert.equal(rowKeys(section).length, 20);
    assert.equal(header(section), 'Issues (20+)');
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
      assert.equal(header(section), 'Issues');
    }
  });

  it('keeps a view\'s issues, and their count, while it\'s searched again, with a spinner and a note', () => {
    const stale = { ...REPORTED_RESULT, status: 'loading', stale: true };
    const { views } = viewsOptions([REPORTED], { selectedId: 'reported', results: { reported: stale } });
    const section = render({ views });
    const panel = section.querySelector('#workingIssuesViewPanel');
    assert.deepEqual(rowKeys(section), ['OPS-7', 'OPS-8']);
    assert.deepEqual(tabTexts(section), ['Active (3)', 'Reported (2)']);
    const note = panel.querySelector('.working-issues-view-updating');
    assert.equal(note.textContent, VIEW_UPDATING);
    assert.equal(note.getAttribute('role'), 'status');
    assert.ok(note.querySelector('.working-issues-spinner'));
    assert.equal(panel.getAttribute('aria-busy'), 'true');
    assert.equal(panel.querySelectorAll('.working-issues-empty').length, 0, 'not "Searching Jira…"');
  });

  it('keeps a view\'s issues below the error when searching it again fails, with Retry', () => {
    const failed = { ...REPORTED_RESULT, status: 'error', stale: true, message: 'Jira refused the search.' };
    const { views, calls } = viewsOptions([REPORTED], { selectedId: 'reported', results: { reported: failed } });
    const section = render({ views });
    assert.match(section.querySelector('#workingIssuesViewPanel').querySelector('.working-issues-message').textContent, /Jira refused the search\./);
    assert.deepEqual(rowKeys(section), ['OPS-7', 'OPS-8']);
    assert.equal(section.querySelector('.working-issues-view-updating'), null);
    section.querySelector('#workingIssuesViewPanel').querySelector('.working-issues-message').querySelector('button').click();
    assert.deepEqual(calls, [['refresh', 'reported']]);
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

  it('has + for a new view, until there are five, and the edit button only for a selected custom view', () => {
    const { views, calls } = viewsOptions([REPORTED], { selectedId: 'reported' });
    const section = render({ views });
    const bar = section.querySelector('.working-issues-viewbar');
    assert.deepEqual(bar.children.map((child) => child.getAttribute('data-action') ?? child.getAttribute('role')), ['tablist', 'edit-view', 'add-view']);
    section.querySelector('[data-action="edit-view"]').click();
    section.querySelector('[data-action="add-view"]').click();
    assert.deepEqual(calls, [['edit', 'reported'], ['create']]);
    assert.equal(section.querySelector('[data-action="edit-view"]').getAttribute('aria-label'), 'Edit the Reported view');
    const many = (n) => Array.from({ length: n }, (_, i) => ({ ...QUEUE, id: `q${i}`, name: `Queue ${i + 1}` }));
    assert.ok(render({ views: viewsOptions(many(4)).views }).querySelector('[data-action="add-view"]'), 'a fifth can be added');
    const five = render({ views: viewsOptions(many(5)).views });
    assert.equal(five.querySelector('[data-action="add-view"]'), null);
    assert.deepEqual(tabTexts(five), ['Active (3)', 'Queue 1', 'Queue 2', 'Queue 3', 'Queue 4', 'Queue 5'], 'all side by side');
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
    assert.equal(section.querySelector('[role="tablist"]').getAttribute('aria-label'), 'Views of Issues');
    assert.deepEqual(tabs(section).map((tab) => [tab.getAttribute('aria-selected'), tab.getAttribute('tabindex')]), [['true', '0'], ['false', '-1'], ['false', '-1']]);
    assert.equal(tabs(section)[1].getAttribute('title'), 'Reporter in Me · Updated, descending');
    assert.equal(section.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby'), 'workingIssuesViewTab-all');
  });

  it('moves between tabs with the arrow keys, Home, and End, focusing and choosing the new one', () => {
    const { views, calls } = viewsOptions([REPORTED, QUEUE], { selectedId: ALL_VIEW_ID });
    const section = render({ views });
    const press = (key) => section.querySelector('[role="tablist"]').dispatchEvent({ type: 'keydown', key });
    press('ArrowRight');
    assert.ok(document.activeElement === tabs(section)[1], 'focus');
    press('ArrowLeft');
    assert.ok(document.activeElement === tabs(section)[2], 'wraps to the last');
    press('End');
    press('Home');
    assert.ok(document.activeElement === tabs(section)[0], 'focus');
    assert.deepEqual(calls, [['select', 'reported'], ['select', 'queue'], ['select', 'queue']]);
  });

  it('keeps focus on the chosen tab when the section is drawn again', () => {
    const { views } = viewsOptions([REPORTED, QUEUE], { selectedId: ALL_VIEW_ID });
    const section = render({ views });
    tabs(section)[2].focus();
    render({ views: { ...views, selectedId: 'queue' }, section });
    assert.ok(document.activeElement === tabs(section)[2], 'focus');
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

describe('Custom views - moving the tabs', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  const THREE = [REPORTED, QUEUE, { ...QUEUE, id: 'qa', name: 'Ready for QA' }];
  /**
   * Gives the tabs boxes on the page, one row, 100 px wide each from x = 0 (Active first), and
   * returns how to drag with a pointer over them.
   */
  function layout(section) {
    tabs(section).forEach((tab, i) => {
      tab.getBoundingClientRect = () => ({ left: i * 110, right: i * 110 + 100, top: 0, bottom: 24 });
    });
    const tablist = section.querySelector('[role="tablist"]');
    const tabFor = (id) => tabs(section).find((tab) => tab.getAttribute('data-view') === id);
    const pointer = (type, target, x, y = 10) => target.dispatchEvent({ type, pointerId: 1, button: 0, clientX: x, clientY: y });
    return {
      tablist,
      tabFor,
      /** Presses on a tab, moves to x, and releases: the click that follows a release too. */
      drag(id, toX, { release = true } = {}) {
        const tab = tabFor(id);
        const from = Number(tabs(section).indexOf(tab)) * 110 + 50;
        pointer('pointerdown', tab, from);
        pointer('pointermove', tab, from + (toX > from ? 3 : -3));
        pointer('pointermove', tab, toX);
        if (!release) return;
        pointer('pointerup', tab, toX);
        tab.click();
      },
      pointer
    };
  }

  it('drags a custom view to the right, after the tab it\'s dropped on', () => {
    const { views, calls } = viewsOptions(THREE);
    const section = render({ views });
    // Reported (x 110-210) dropped on Ready for QA's right half (x 330-430).
    layout(section).drag('reported', 400);
    assert.deepEqual(calls, [['move', 'reported', 2]]);
  });

  it('drags a custom view to the left, before the tab it\'s dropped on', () => {
    const { views, calls } = viewsOptions(THREE);
    const section = render({ views });
    layout(section).drag('qa', 120);
    assert.deepEqual(calls, [['move', 'qa', 0]]);
  });

  it('never puts a view before Active: dropped on Active, it goes first among the custom views', () => {
    const { views, calls } = viewsOptions(THREE);
    const section = render({ views });
    layout(section).drag('qa', 10);
    assert.deepEqual(calls, [['move', 'qa', 0]]);
  });

  it('never drags Active', () => {
    const { views, calls } = viewsOptions(THREE);
    const section = render({ views });
    const { pointer, tabFor } = layout(section);
    pointer('pointerdown', tabFor(ALL_VIEW_ID), 50);
    pointer('pointermove', tabFor(ALL_VIEW_ID), 400);
    pointer('pointerup', tabFor(ALL_VIEW_ID), 400);
    assert.deepEqual(calls, []);
    assert.equal(tabFor(ALL_VIEW_ID).classList.contains('is-movable'), false);
    assert.equal(tabFor(ALL_VIEW_ID).getAttribute('aria-keyshortcuts'), null);
  });

  it('never chooses the dragged tab, but a press without a drag still chooses it', () => {
    const { views, calls } = viewsOptions(THREE);
    const section = render({ views });
    const { drag, pointer, tabFor } = layout(section);
    drag('reported', 400);
    assert.deepEqual(calls.filter(([what]) => what === 'select'), []);
    // A press that moves under the threshold is a click.
    pointer('pointerdown', tabFor('qa'), 380);
    pointer('pointermove', tabFor('qa'), 382);
    pointer('pointerup', tabFor('qa'), 382);
    tabFor('qa').click();
    assert.deepEqual(calls.at(-1), ['select', 'qa']);
  });

  it('dropped back where it was, moves nothing', () => {
    const { views, calls } = viewsOptions(THREE);
    const section = render({ views });
    layout(section).drag('queue', 280);
    assert.deepEqual(calls, []);
  });

  it('fades the dragged tab, shows a line where it would go, and clears both on release', () => {
    const { views } = viewsOptions(THREE);
    const section = render({ views });
    const { drag, tabFor, tablist, pointer } = layout(section);
    drag('reported', 400, { release: false });
    assert.ok(tabFor('reported').classList.contains('is-dragging'));
    assert.ok(tabFor('qa').classList.contains('is-drop-after'));
    assert.ok(tablist.classList.contains('is-reordering'));
    pointer('pointermove', tabFor('reported'), 340);
    assert.ok(tabFor('qa').classList.contains('is-drop-before'));
    assert.equal(tabFor('qa').classList.contains('is-drop-after'), false);
    pointer('pointerup', tabFor('reported'), 340);
    assert.ok(tabs(section).every((tab) => !/is-dragging|is-drop-/.test(tab.className)));
    assert.equal(tablist.classList.contains('is-reordering'), false);
  });

  it('cancels a drag with Escape, moving nothing and choosing nothing', () => {
    const { views, calls } = viewsOptions(THREE);
    const section = render({ views });
    const { drag, tabFor, tablist, pointer } = layout(section);
    drag('reported', 400, { release: false });
    assert.equal(tablist.dispatchEvent({ type: 'keydown', key: 'Escape', target: tabFor('reported') }), false);
    pointer('pointerup', tabFor('reported'), 400);
    tabFor('reported').click();
    assert.deepEqual(calls, []);
    assert.equal(tabFor('reported').classList.contains('is-dragging'), false);
  });

  it('moves the focused custom view with Alt+Shift and the arrow keys, one place each', () => {
    const { views, calls } = viewsOptions(THREE, { selectedId: 'queue' });
    const section = render({ views });
    const { tablist, tabFor } = layout(section);
    const press = (key, id) => tablist.dispatchEvent({ type: 'keydown', key, altKey: true, shiftKey: true, target: tabFor(id) });
    assert.equal(press('ArrowRight', 'queue'), false, 'handled');
    press('ArrowLeft', 'queue');
    press('ArrowLeft', 'reported');
    press('ArrowRight', 'qa');
    press('ArrowLeft', ALL_VIEW_ID);
    assert.deepEqual(calls, [['move', 'queue', 2], ['move', 'queue', 0]], 'nothing past either end, and never Active');
  });

  it('describes the keys on each custom view\'s tab', () => {
    const { views } = viewsOptions(THREE);
    const section = render({ views });
    const tab = layout(section).tabFor('queue');
    assert.equal(tab.getAttribute('aria-keyshortcuts'), 'Alt+Shift+ArrowLeft Alt+Shift+ArrowRight');
    assert.equal(tab.getAttribute('aria-describedby'), 'workingIssuesViewMoveHint');
    assert.equal(section.querySelector('#workingIssuesViewMoveHint').textContent, VIEW_MOVE_HINT);
  });

  it('announces a move, once, through a status region kept across renders', () => {
    const section = render({ views: viewsOptions(THREE).views });
    const announcer = section.querySelector('#workingIssuesAnnouncer');
    assert.equal(announcer.getAttribute('role'), 'status');
    assert.equal(announcer.textContent, '');
    render({ views: viewsOptions(THREE, { announcement: 'Moved Reported to position 4 of 4.' }).views, section });
    assert.ok(section.querySelector('#workingIssuesAnnouncer') === announcer, 'the same region');
    assert.equal(announcer.textContent, 'Moved Reported to position 4 of 4.');
  });

  it('can\'t move anything with one custom view, or when the page doesn\'t allow it', () => {
    for (const views of [viewsOptions([REPORTED]).views, viewsOptions(THREE, { canReorder: false }).views]) {
      const section = render({ views });
      assert.equal(section.querySelectorAll('.is-movable').length, 0);
      assert.equal(section.querySelector('#workingIssuesViewMoveHint'), null);
    }
    const { views, calls } = viewsOptions(THREE, { canReorder: false });
    const section = render({ views });
    layout(section).drag('reported', 400);
    assert.deepEqual(calls, [['select', 'reported']], 'a press is only a click');
  });

  it('leaves ✎ and + working, and the selected view selected', () => {
    const { views, calls } = viewsOptions([REPORTED, QUEUE], { selectedId: 'queue', canCreate: true });
    const section = render({ views });
    layout(section).drag('reported', 290);
    section.querySelector('[data-action="edit-view"]').click();
    section.querySelector('[data-action="add-view"]').click();
    assert.deepEqual(calls, [['move', 'reported', 1], ['edit', 'queue'], ['create']]);
    assert.equal(layout(section).tabFor('queue').getAttribute('aria-selected'), 'true');
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
    /** The value's checkbox, as drawn now (each change draws the values again, chosen ones first). */
    const valueInput = (label) => root.querySelectorAll('.custom-view-value').find((el) => el.querySelector('span').textContent === label)?.querySelector('input');
    const setValue = (label, checked) => {
      const input = valueInput(label);
      input.checked = checked;
      input.dispatchEvent({ type: 'change' });
    };
    const check = (...labels) => {
      for (const label of labels) if (valueInput(label)) setValue(label, true);
    };
    const uncheck = (...labels) => {
      for (const label of labels) setValue(label, false);
    };
    const submit = () => $('form').dispatchEvent({ type: 'submit' });
    const valueLabels = () => root.querySelectorAll('.custom-view-value').map((label) => label.querySelector('span').textContent);
    const search = (text) => {
      $('#customViewValueSearch-1').value = text;
      $('#customViewValueSearch-1').dispatchEvent({ type: 'input' });
    };
    return { root, editor, calls, $, choose, check, uncheck, submit, valueLabels, search };
  }

  it('opens to create a view, focused on its name, with the fields grouped', () => {
    const { root, $ } = open();
    assert.equal(root.classList.contains('hidden'), false);
    assert.equal(root.getAttribute('aria-labelledby'), 'customViewTitle');
    assert.equal($('#customViewTitle').textContent, 'New view');
    assert.ok(document.activeElement === $('#customViewName'), 'focus');
    assert.equal($('#customViewName').getAttribute('maxlength'), '30');
    assert.deepEqual($('#customViewField-1').querySelectorAll('optgroup').map((g) => [g.getAttribute('label'), g.querySelectorAll('option').map((o) => o.textContent)]), [
      ['Fields', ['Status', 'Priority', 'Assignee', 'Reporter']],
      ['Additional Assignment Fields', ['QA Assignee']]
    ]);
    assert.equal($('#customViewOperator-1').disabled, true);
    assert.equal($('[data-action="delete-view"]'), null);
    // Where a view's issues come from: its own search, not Active Issues.
    assert.equal($('.custom-view-hint').textContent, VIEW_SEARCH_HINT);
    assert.match(VIEW_SEARCH_HINT, /first 20 issues you can see in Jira that match all its conditions, whether Active lists them or not/);
  });

  it('offers In and Not in, In first, each with the values Jira lists as checkboxes', async () => {
    const { $, choose, check, valueLabels, root } = open();
    choose('#customViewField-1', 'status');
    await flush();
    assert.deepEqual($('#customViewOperator-1').querySelectorAll('option').map((o) => [o.getAttribute('value'), o.textContent]), [['in', 'In'], ['notIn', 'Not in']]);
    assert.equal($('#customViewOperator-1').value, 'in');
    assert.equal($('#customViewOperator-1').disabled, false);
    assert.deepEqual(valueLabels(), ['In Progress', 'In Review']);
    assert.ok(root.querySelectorAll('input[name="customViewValue-1"]').every((input) => input.getAttribute('type') === 'checkbox'));
    assert.equal(root.querySelector('legend').textContent, 'Values');
    // Changing the operator keeps the values chosen.
    check('In Progress', 'In Review');
    choose('#customViewOperator-1', 'notIn');
    assert.ok(root.querySelectorAll('input[name="customViewValue-1"]').every((input) => input.getAttribute('type') === 'checkbox'));
    assert.deepEqual(root.querySelectorAll('input[name="customViewValue-1"]').map((input) => input.checked), [true, true]);
  });

  it('offers In and Not in, and only Me, chosen already, for user fields', async () => {
    for (const fieldId of ['assignee', 'reporter', 'customfield_10050']) {
      const { $, choose, valueLabels, root, submit, calls } = open();
      $('#customViewName').value = 'Mine';
      choose('#customViewField-1', fieldId);
      await flush();
      assert.deepEqual($('#customViewOperator-1').querySelectorAll('option').map((o) => o.textContent), ['In', 'Not in'], fieldId);
      assert.deepEqual(valueLabels(), ['Me']);
      assert.equal(root.querySelector('input[name="customViewValue-1"]').checked, true);
      choose('#customViewOperator-1', 'notIn');
      submit();
      await flush();
      assert.deepEqual(calls[0][1].conditions[0].operator, 'notIn', fieldId);
      assert.deepEqual(calls[0][1].conditions[0].values, [{ currentUser: true, label: 'Me' }]);
    }
  });

  it('saves a valid view: its trimmed name and one condition', async () => {
    const { $, choose, check, submit, calls } = open();
    $('#customViewName').value = '  Development Queue ';
    choose('#customViewField-1', 'status');
    await flush();
    choose('#customViewOperator-1', 'in');
    check('In Progress', 'In Review');
    submit();
    await flush();
    assert.deepEqual(calls, [
      ['save', { name: 'Development Queue', conditions: [{ field: { id: 'status', name: 'Status' }, operator: 'in', values: [{ id: '3', label: 'In Progress' }, { id: '4', label: 'In Review' }] }], orderBy: { field: 'updated', direction: 'DESC' } }],
      ['close']
    ]);
  });

  it('saves Assignee equals Me', async () => {
    const { $, choose, submit, calls } = open();
    $('#customViewName').value = 'Mine';
    choose('#customViewField-1', 'assignee');
    await flush();
    submit();
    await flush();
    assert.deepEqual(calls[0][1].conditions, [{ field: { id: 'assignee', name: 'Assignee' }, operator: 'in', values: [{ currentUser: true, label: 'Me' }] }]);
  });

  it('shows what\'s wrong and saves nothing: name, field, values, the limit', async () => {
    const empty = open();
    empty.submit();
    assert.match(empty.$('#customViewNameError').textContent, /Enter a name/);
    assert.match(empty.$('#customViewFieldError-1').textContent, /Choose a field/);
    assert.equal(empty.calls.length, 0);
    assert.ok(document.activeElement === empty.$('#customViewName'), 'focus');

    const twoValues = open({ views: [{ id: 'x', name: 'Taken', conditions: [] }] });
    twoValues.$('#customViewName').value = 'taken';
    twoValues.choose('#customViewField-1', 'status');
    await flush();
    twoValues.choose('#customViewOperator-1', 'notIn');
    twoValues.submit();
    assert.match(twoValues.$('#customViewNameError').textContent, /Another view already has this name/);
    assert.match(twoValues.$('#customViewValuesError-1').textContent, /Choose at least one value/);

    const full = open({ views: ['A', 'B', 'D', 'E', 'F'].map((name) => ({ id: name.toLowerCase(), name, conditions: [] })) });
    full.$('#customViewName').value = 'C';
    full.choose('#customViewField-1', 'assignee');
    await flush();
    full.submit();
    assert.match(full.$('#customViewFormError').textContent, /at most 5 custom views/);
    assert.equal(full.calls.length, 0);
  });

  it('keeps the form and says why when saving fails', async () => {
    const { $, choose, submit, calls, editor } = open({ onSave: async () => { throw new Error('Storage is full.'); } });
    $('#customViewName').value = 'Mine';
    choose('#customViewField-1', 'assignee');
    await flush();
    submit();
    await flush();
    assert.equal($('#customViewFormError').textContent, 'Storage is full.');
    assert.equal(editor.isOpen, true);
    assert.deepEqual(calls, []);
  });

  it('offers Order by, after the condition, with Jira\'s sortable fields, Updated descending for a new view', () => {
    const { $, root } = open();
    const select = $('#customViewOrderBy');
    assert.deepEqual(select.querySelectorAll('option').map((o) => [o.getAttribute('value'), o.textContent]), [
      ['updated', 'Updated'], ['created', 'Created'], ['priority', 'Priority'], ['duedate', 'Due date'], ['status', 'Status'], ['key', 'Issue key']
    ]);
    assert.equal(select.value, 'updated');
    const directions = root.querySelectorAll('input[name="customViewOrderDirection"]');
    assert.deepEqual(directions.map((input) => [input.value, input.getAttribute('type'), input.checked]), [['ASC', 'radio', false], ['DESC', 'radio', true]]);
    assert.deepEqual(root.querySelectorAll('.custom-view-direction').map((label) => label.textContent), ['Ascending (ASC)', 'Descending (DESC)']);
    const groups = root.querySelectorAll('.form-group');
    const at = (el) => groups.indexOf(el.closest('.form-group'));
    assert.ok(at(select) > at($('#customViewValues-1')), 'after the condition');
  });

  it('saves the chosen order and direction', async () => {
    const { $, root, choose, submit, calls } = open();
    $('#customViewName').value = 'By priority';
    choose('#customViewField-1', 'reporter');
    await flush();
    choose('#customViewOrderBy', 'priority');
    const ascending = root.querySelectorAll('input[name="customViewOrderDirection"]').find((input) => input.value === 'ASC');
    ascending.checked = true;
    root.querySelectorAll('input[name="customViewOrderDirection"]').find((input) => input.value === 'DESC').checked = false;
    submit();
    await flush();
    assert.deepEqual(calls[0][1].orderBy, { field: 'priority', direction: 'ASC' });
  });

  it('restores a saved view\'s order, and opens one saved without an order on Updated descending', async () => {
    const sorted = { ...QUEUE, orderBy: { field: 'duedate', direction: 'ASC' } };
    const edited = open({ view: sorted, views: [sorted] });
    assert.equal(edited.$('#customViewOrderBy').value, 'duedate');
    assert.equal(edited.root.querySelectorAll('input[name="customViewOrderDirection"]').find((input) => input.checked).value, 'ASC');
    const old = open({ view: QUEUE, views: [QUEUE] });
    assert.equal(old.$('#customViewOrderBy').value, 'updated');
    assert.equal(old.root.querySelectorAll('input[name="customViewOrderDirection"]').find((input) => input.checked).value, 'DESC');
    const invalid = { ...QUEUE, orderBy: { field: 'summary', direction: 'sideways' } };
    assert.equal(open({ view: invalid, views: [invalid] }).$('#customViewOrderBy').value, 'updated');
  });

  it('refuses an order that isn\'t offered, saying so, and saves nothing', async () => {
    const { $, root, choose, submit, calls } = open();
    $('#customViewName').value = 'Mine';
    choose('#customViewField-1', 'assignee');
    await flush();
    for (const input of root.querySelectorAll('input[name="customViewOrderDirection"]')) input.checked = false;
    submit();
    assert.match($('#customViewOrderByError').textContent, /Choose an order and a direction/);
    assert.ok(document.activeElement === $('#customViewOrderBy'), 'focus');
    assert.deepEqual(calls, []);
  });

  it('opens a saved view to edit it, with its name, field, operator, and values', async () => {
    const view = { id: 'queue', name: 'Development Queue', conditions: [condition('status', [{ id: '3', label: 'In Progress' }, { id: '4', label: 'In Review' }], 'in')] };
    const { $, root } = open({ view, views: [view] });
    await flush();
    assert.equal($('#customViewTitle').textContent, 'Edit view');
    assert.equal($('#customViewName').value, 'Development Queue');
    assert.equal($('#customViewField-1').value, 'status');
    assert.equal($('#customViewOperator-1').value, 'in');
    assert.deepEqual(root.querySelectorAll('input[name="customViewValue-1"]').map((input) => input.checked), [true, true]);
  });

  it('keeps a saved status Jira doesn\'t list any more, saying so', async () => {
    const view = { id: 'queue', name: 'Queue', conditions: [condition('status', [{ id: '7', label: 'Blocked' }])] };
    const { valueLabels, root, submit, calls } = open({ view, views: [view] });
    await flush();
    // Chosen, so first.
    assert.deepEqual(valueLabels(), ['Blocked', 'In Progress', 'In Review']);
    assert.equal(root.querySelector('.custom-view-value-note').textContent, ` (${NOT_IN_JIRA})`);
    assert.equal(root.querySelectorAll('input[name="customViewValue-1"]')[0].checked, true);
    submit();
    await flush();
    assert.deepEqual(calls[0][1].conditions[0].values, [{ id: '7', label: 'Blocked' }]);
  });

  it('shows a saved field that\'s gone, which can\'t be chosen again', async () => {
    const view = { id: 'team', name: 'Team', conditions: [condition('customfield_10999', [{ id: '1', label: 'X' }])] };
    const { $ } = open({ view, views: [view] });
    await flush();
    const gone = $('#customViewField-1').querySelectorAll('option').find((o) => o.getAttribute('value') === 'customfield_10999');
    assert.equal(gone.textContent, 'customfield_10999 (no longer available)');
    assert.equal(gone.hasAttribute('disabled'), true);
    assert.equal($('#customViewField-1').value, '');
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
    assert.deepEqual($('#customViewField-1').querySelectorAll('optgroup').map((g) => g.getAttribute('label')), ['Fields', 'Additional Assignment Fields', 'Custom fields']);
    assert.equal($('#customViewField-1').value, 'customfield_10100');
    assert.deepEqual(root.querySelectorAll('input[name="customViewValue-1"]').map((input) => input.checked), [true]);
  });

  it('says when the custom fields or the values can\'t be loaded', async () => {
    const { $, choose } = open({ loadCustomFields: async () => { throw new Error('no'); }, loadValues: async () => { throw new Error('no'); } });
    await flush();
    assert.equal($('#customViewFieldsStatus').textContent, FIELDS_UNAVAILABLE);
    choose('#customViewField-1', 'status');
    await flush();
    assert.equal($('#customViewValues-1').textContent, VALUES_UNAVAILABLE);
  });

  it('says when Jira has no values for the field', async () => {
    const { $, choose } = open();
    choose('#customViewField-1', 'priority');
    await flush();
    assert.equal($('#customViewValues-1').textContent, NO_VALUES);
  });

  it('filters a long list by name, keeping what\'s chosen, and Enter doesn\'t save', async () => {
    const values = Array.from({ length: VALUE_FILTER_THRESHOLD + 2 }, (_, i) => ({ id: String(i + 1), label: i === 5 ? 'Selected for Development' : `Status ${i + 1}` }));
    const { root, choose, check, $, calls } = open({ loadValues: async () => values });
    choose('#customViewField-1', 'status');
    await flush();
    assert.equal($('#customViewValueFilter-1').getAttribute('aria-label'), 'Filter values');
    check('Status 1');
    // The values are drawn again on each change: the filter box too.
    const filter = $('#customViewValueFilter-1');
    filter.value = 'selected';
    filter.dispatchEvent({ type: 'input' });
    const visible = root.querySelectorAll('li').filter((li) => !li.classList.contains('hidden'));
    assert.deepEqual(visible.map((li) => li.textContent), ['Status 1', 'Selected for Development'], 'the chosen value stays in view');
    assert.equal(root.querySelectorAll('input[name="customViewValue-1"]').find((input) => input.value === '1').checked, true, 'still chosen');
    // dispatchEvent() answers false when a listener prevented the default (submitting the form).
    assert.equal(filter.dispatchEvent({ type: 'keydown', key: 'Enter' }), false);
    assert.deepEqual(calls, []);
    filter.value = 'zzz';
    filter.dispatchEvent({ type: 'input' });
    assert.equal(root.querySelectorAll('[role="status"]').find((el) => !el.classList.contains('hidden'))?.textContent, NO_MATCHING_VALUES);
  });

  describe('chosen values first', () => {
    const STATUSES = ['Verify', 'Analysis', 'Selected for Development', 'Approved', 'Review', 'Scheduled', 'Awaiting Customer']
      .map((label, i) => ({ id: String(100 + i), label }));
    const ALPHABETICAL = ['Analysis', 'Approved', 'Awaiting Customer', 'Review', 'Scheduled', 'Selected for Development', 'Verify'];
    const chosenLabels = (root) => root.querySelectorAll('.custom-view-value').filter((label) => label.querySelector('input').checked).map((label) => label.textContent);
    async function openStatus(extra = {}) {
      const editor = open({ loadValues: async () => STATUSES, ...extra });
      editor.choose('#customViewField-1', 'status');
      await flush();
      return editor;
    }

    it('lists the values alphabetically while none is chosen', async () => {
      const { valueLabels, root } = await openStatus();
      assert.deepEqual(valueLabels(), ALPHABETICAL);
      assert.equal(root.querySelectorAll('.custom-view-value-others').length, 0);
    });

    it('moves a value to the top as soon as it\'s chosen, the chosen ones alphabetically, then the others', async () => {
      const { valueLabels, check, root } = await openStatus();
      check('Verify');
      assert.deepEqual(valueLabels(), ['Verify', 'Analysis', 'Approved', 'Awaiting Customer', 'Review', 'Scheduled', 'Selected for Development']);
      check('Selected for Development');
      check('Review');
      assert.deepEqual(valueLabels(), ['Review', 'Selected for Development', 'Verify', 'Analysis', 'Approved', 'Awaiting Customer', 'Scheduled']);
      assert.deepEqual(chosenLabels(root), ['Review', 'Selected for Development', 'Verify']);
      // A line between the two groups: on the first value not chosen.
      assert.deepEqual(root.querySelectorAll('.custom-view-value-others').map((li) => li.textContent), ['Analysis']);
    });

    it('puts a value back in its place among the others as soon as it\'s no longer chosen', async () => {
      const { valueLabels, check, uncheck } = await openStatus();
      check('Verify', 'Review');
      uncheck('Verify');
      assert.deepEqual(valueLabels(), ['Review', 'Analysis', 'Approved', 'Awaiting Customer', 'Scheduled', 'Selected for Development', 'Verify']);
      uncheck('Review');
      assert.deepEqual(valueLabels(), ALPHABETICAL);
    });

    it('keeps focus on the value just changed, in its new place', async () => {
      const { check, root } = await openStatus();
      check('Scheduled');
      assert.equal(document.activeElement?.value, '105');
      assert.ok(root.querySelectorAll('input[name="customViewValue-1"]')[0] === document.activeElement, 'focus');
    });

    it('lists each value once, and saves the chosen ones', async () => {
      const { valueLabels, check, uncheck, submit, calls, $ } = await openStatus();
      $('#customViewName').value = 'Queue';
      check('Verify', 'Analysis', 'Review');
      uncheck('Analysis');
      assert.equal(new Set(valueLabels()).size, valueLabels().length);
      assert.equal(valueLabels().length, STATUSES.length);
      submit();
      await flush();
      assert.deepEqual(calls[0][1].conditions[0].values.map((v) => v.label).sort(), ['Review', 'Verify']);
    });

    it('starts an edited view with its saved values first', async () => {
      const view = { id: 'q', name: 'Queue', conditions: [condition('status', [{ id: '106', label: 'Awaiting Customer' }, { id: '100', label: 'Verify' }])] };
      const { valueLabels } = open({ view, views: [view], loadValues: async () => STATUSES });
      await flush();
      assert.deepEqual(valueLabels(), ['Awaiting Customer', 'Verify', 'Analysis', 'Approved', 'Review', 'Scheduled', 'Selected for Development']);
    });

    it('keeps the chosen values in view, and chosen, whatever the filter shows', async () => {
      const many = Array.from({ length: VALUE_FILTER_THRESHOLD + 3 }, (_, i) => ({ id: String(i + 1), label: `Status ${String(i + 1).padStart(2, '0')}` }));
      const { root, $, check } = await openStatus({ loadValues: async () => many });
      check('Status 07', 'Status 03');
      const filter = $('#customViewValueFilter-1');
      filter.value = '1';
      filter.dispatchEvent({ type: 'input' });
      const visible = () => root.querySelectorAll('li').filter((li) => !li.classList.contains('hidden')).map((li) => li.textContent);
      assert.deepEqual(visible(), ['Status 03', 'Status 07', 'Status 01', 'Status 10', 'Status 11', 'Status 12', 'Status 13']);
      assert.deepEqual(chosenLabels(root), ['Status 03', 'Status 07']);
      // Choosing among the filtered values keeps the filter, and moves the value up.
      check('Status 11');
      assert.equal($('#customViewValueFilter-1').value, '1');
      assert.deepEqual(visible(), ['Status 03', 'Status 07', 'Status 11', 'Status 01', 'Status 10', 'Status 12', 'Status 13']);
      // Nothing matches: says so, the chosen ones still there.
      $('#customViewValueFilter-1').value = 'zzz';
      $('#customViewValueFilter-1').dispatchEvent({ type: 'input' });
      assert.deepEqual(visible(), ['Status 03', 'Status 07', 'Status 11']);
      assert.equal(root.querySelectorAll('[role="status"]').find((el) => !el.classList.contains('hidden'))?.textContent, NO_MATCHING_VALUES);
    });

    it('lists a custom field\'s chosen values first, alphabetically, then Jira\'s suggestions', async () => {
      const suggestions = ['Sega', 'Atari', 'Nintendo', 'Devops'].map((label) => ({ id: label, label }));
      const { root, valueLabels, check, search } = open({
        loadCustomFields: async () => [{ id: 'customfield_11300', name: 'Team', kind: 'option' }],
        loadValues: async (field, query) => suggestions.filter((value) => value.label.toLowerCase().startsWith(query.toLowerCase()))
      });
      await flush();
      const select = root.querySelector('#customViewField-1');
      select.value = 'customfield_11300';
      select.dispatchEvent({ type: 'change' });
      await flush();
      assert.deepEqual(valueLabels(), ['Atari', 'Devops', 'Nintendo', 'Sega']);
      check('Sega', 'Devops');
      assert.deepEqual(valueLabels(), ['Devops', 'Sega', 'Atari', 'Nintendo']);
      // A search that finds neither keeps them, chosen, at the top.
      search('N');
      mock.timers.tick(VALUE_SEARCH_DELAY_MS);
      await flush();
      assert.deepEqual(valueLabels(), ['Devops', 'Sega', 'Nintendo']);
      assert.deepEqual(chosenLabels(root), ['Devops', 'Sega']);
    });
  });

  it('has no filter for a short list', async () => {
    const { $, choose } = open({ loadValues: async () => [{ id: '3', label: 'In Progress' }] });
    choose('#customViewField-1', 'status');
    await flush();
    assert.equal($('#customViewValueFilter-1'), null);
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
      choose('#customViewField-1', 'customfield_10100');
      await flush();
      assert.deepEqual(asked, [['customfield_10100', '']]);
      assert.deepEqual(valueLabels(), [...OPTIONS].sort());
      assert.equal($('#customViewValueSearch-1').getAttribute('aria-label'), 'Search values in Jira');
    });

    it('searches Jira once typing pauses, keeping the search box (and focus) as it is', async () => {
      const { $, choose, valueLabels, asked, search } = openTeam();
      await flush();
      choose('#customViewField-1', 'customfield_10100');
      await flush();
      const box = $('#customViewValueSearch-1');
      box.focus();
      search('Pl');
      search('Pla');
      assert.equal(asked.length, 1, 'not yet: typing hasn\'t paused');
      mock.timers.tick(VALUE_SEARCH_DELAY_MS);
      await flush();
      assert.deepEqual(asked.at(-1), ['customfield_10100', 'Pla']);
      assert.equal(asked.length, 2, 'once, for what was typed last');
      assert.deepEqual(valueLabels(), ['Platform', 'Platform Ops']);
      assert.equal($('#customViewValueSearch-1'), box);
      assert.ok(document.activeElement === box, 'focus');
    });

    it('keeps the chosen values listed, checked, whatever the search shows, and saves them by name', async () => {
      const { $, choose, check, valueLabels, search, submit, calls, root } = openTeam();
      await flush();
      $('#customViewName').value = 'Teams';
      choose('#customViewField-1', 'customfield_10100');
      await flush();
      choose('#customViewOperator-1', 'in');
      check('Platform');
      search('Pro');
      mock.timers.tick(VALUE_SEARCH_DELAY_MS);
      await flush();
      assert.deepEqual(valueLabels(), ['Platform', 'Product']);
      check('Product');
      assert.deepEqual(root.querySelectorAll('input[name="customViewValue-1"]').map((input) => input.checked), [true, true]);
      submit();
      await flush();
      assert.deepEqual(calls[0][1].conditions[0], {
        field: { id: 'customfield_10100', name: 'Team' }, operator: 'in',
        values: [{ id: 'Platform', label: 'Platform' }, { id: 'Product', label: 'Product' }]
      });
    });

    it('searches at once on Enter, which doesn\'t save the view', async () => {
      const { $, choose, asked, calls, search } = openTeam();
      await flush();
      choose('#customViewField-1', 'customfield_10100');
      await flush();
      search('Cis');
      // Before typing pauses.
      assert.equal($('#customViewValueSearch-1').dispatchEvent({ type: 'keydown', key: 'Enter' }), false);
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
      choose('#customViewField-1', 'customfield_10100');
      await flush();
      search('zzz');
      mock.timers.tick(VALUE_SEARCH_DELAY_MS);
      await flush();
      assert.equal($('#customViewValueResults-1').textContent, NO_MATCHING_VALUES);
      const failing = openTeam({ loadValues: async () => { throw new Error('no'); } });
      await flush();
      failing.choose('#customViewField-1', 'customfield_10100');
      await flush();
      assert.equal(failing.$('#customViewValueResults-1').textContent, VALUES_UNAVAILABLE);
    });
  });

  describe('several conditions', () => {
    const titles = (root) => root.querySelectorAll('.custom-view-condition-title').map((el) => el.textContent);
    const block = (root, n) => root.querySelectorAll('.custom-view-condition')[n - 1];
    const addCondition = (root) => root.querySelector('[data-action="add-condition"]').click();
    /** Chooses a field, operator, and values in one condition block. */
    async function fill(root, n, { field, operator, values = [] }) {
      const b = block(root, n);
      const fieldSelect = b.querySelector('select');
      fieldSelect.value = field;
      fieldSelect.dispatchEvent({ type: 'change' });
      await flush();
      if (operator) {
        const operatorSelect = b.querySelectorAll('select')[1];
        operatorSelect.value = operator;
        operatorSelect.dispatchEvent({ type: 'change' });
      }
      for (const value of values) {
        const input = block(root, n).querySelectorAll('.custom-view-value').find((label) => label.querySelector('span').textContent === value)?.querySelector('input');
        if (!input) continue;
        input.checked = true;
        input.dispatchEvent({ type: 'change' });
      }
    }

    it('starts a new view with one empty, numbered condition, and + Add Condition', () => {
      const { root } = open();
      assert.deepEqual(titles(root), ['Condition 1']);
      const add = root.querySelector('[data-action="add-condition"]');
      assert.equal(add.textContent, ADD_CONDITION);
      assert.equal(ADD_CONDITION, '+ Add Condition');
      assert.equal(block(root, 1).querySelector('[data-action="delete-condition"]').getAttribute('aria-label'), 'Delete condition 1');
    });

    it('adds empty conditions, focused on their field, keeping the others as they are', async () => {
      const { root } = open();
      await fill(root, 1, { field: 'status', values: ['In Progress'] });
      addCondition(root);
      assert.deepEqual(titles(root), ['Condition 1', 'Condition 2']);
      assert.ok(document.activeElement === block(root, 2).querySelector('select'), 'focus');
      assert.equal(block(root, 2).querySelector('select').value, '');
      assert.equal(block(root, 1).querySelector('select').value, 'status');
      assert.equal(block(root, 1).querySelectorAll('input').find((input) => input.checked)?.value, '3');
    });

    it('saves several conditions, each with its own values: Status, Assignee, and an Additional Assignment Field', async () => {
      const { root, $, submit, calls } = open();
      $('#customViewName').value = 'Development Queue';
      await fill(root, 1, { field: 'status', operator: 'in', values: ['In Progress', 'In Review'] });
      addCondition(root);
      await fill(root, 2, { field: 'assignee' });
      addCondition(root);
      await fill(root, 3, { field: 'customfield_10050' });
      submit();
      await flush();
      assert.deepEqual(calls[0][1].conditions, [
        { field: { id: 'status', name: 'Status' }, operator: 'in', values: [{ id: '3', label: 'In Progress' }, { id: '4', label: 'In Review' }] },
        { field: { id: 'assignee', name: 'Assignee' }, operator: 'in', values: [{ currentUser: true, label: 'Me' }] },
        { field: { id: 'customfield_10050', name: 'QA Assignee' }, operator: 'in', values: [{ currentUser: true, label: 'Me' }] }
      ]);
    });

    it('keeps each condition\'s values apart: choosing in one never changes another', async () => {
      const { root, $, submit, calls } = open({ loadValues: async (field) => (field.kind === 'user' ? [{ currentUser: true, label: 'Me' }]
        : field.id === 'status' ? VALUES.status : [{ id: '1', label: 'Highest' }, { id: '2', label: 'High' }]) });
      $('#customViewName').value = 'Queue';
      await fill(root, 1, { field: 'status', values: ['In Review'] });
      addCondition(root);
      await fill(root, 2, { field: 'priority', values: ['High'] });
      assert.notEqual(block(root, 1).querySelector('input').getAttribute('name'), block(root, 2).querySelector('input').getAttribute('name'));
      assert.equal(block(root, 1).querySelectorAll('input').find((input) => input.checked).value, '4');
      submit();
      await flush();
      assert.deepEqual(calls[0][1].conditions, [
        { field: { id: 'status', name: 'Status' }, operator: 'in', values: [{ id: '4', label: 'In Review' }] },
        { field: { id: 'priority', name: 'Priority' }, operator: 'in', values: [{ id: '2', label: 'High' }] }
      ]);
    });

    it('removes a condition, renumbering the others and keeping what they have', async () => {
      const { root } = open({ loadValues: async (field) => (field.kind === 'user' ? [{ currentUser: true, label: 'Me' }]
        : field.id === 'status' ? VALUES.status : [{ id: '2', label: 'High' }]) });
      await fill(root, 1, { field: 'status', values: ['In Progress'] });
      addCondition(root);
      await fill(root, 2, { field: 'priority', values: ['High'] });
      addCondition(root);
      await fill(root, 3, { field: 'assignee' });
      block(root, 2).querySelector('[data-action="delete-condition"]').click();
      assert.deepEqual(titles(root), ['Condition 1', 'Condition 2']);
      assert.equal(block(root, 2).querySelector('select').value, 'assignee');
      assert.equal(block(root, 2).querySelector('[data-action="delete-condition"]').getAttribute('aria-label'), 'Delete condition 2');
      assert.ok(document.activeElement === block(root, 2).querySelector('[data-action="toggle-condition"]'), 'focus');
      assert.equal(block(root, 1).querySelectorAll('input').find((input) => input.checked).value, '3');
    });

    it('never saves a view without conditions', async () => {
      const { root, $, submit, calls } = open();
      $('#customViewName').value = 'Empty';
      block(root, 1).querySelector('[data-action="delete-condition"]').click();
      assert.deepEqual(titles(root), []);
      assert.ok(document.activeElement === root.querySelector('[data-action="add-condition"]'), 'focus');
      submit();
      await flush();
      assert.equal($('#customViewConditionsError').textContent, 'Add at least one condition.');
      assert.deepEqual(calls, []);
    });

    it('starts a condition afresh when its field changes: In, and no values from the other field', async () => {
      const { root } = open();
      await fill(root, 1, { field: 'status', operator: 'notIn', values: ['In Progress', 'In Review'] });
      await fill(root, 1, { field: 'priority' });
      assert.equal(block(root, 1).querySelectorAll('select')[1].value, 'in');
      await fill(root, 1, { field: 'status' });
      assert.equal(block(root, 1).querySelectorAll('select')[1].value, 'in');
      assert.deepEqual(block(root, 1).querySelectorAll('input').map((input) => input.checked), [false, false]);
    });

    it('shows each condition\'s own errors, and focuses the first', async () => {
      const { root, $, submit, calls } = open();
      $('#customViewName').value = 'Errors';
      await fill(root, 1, { field: 'status', values: ['In Progress'] });
      addCondition(root);
      await fill(root, 2, { field: 'status', values: ['In Review'] });
      addCondition(root);
      submit();
      await flush();
      assert.equal($('#customViewFieldError-1').textContent, '');
      assert.equal($('#customViewFieldError-2').textContent, 'Another condition already uses this field.');
      assert.equal($('#customViewFieldError-3').textContent, 'Choose a field.');
      assert.ok(document.activeElement === $('#customViewField-2'), 'focus');
      assert.deepEqual(calls, []);
    });

    it('restores every saved condition when editing, in order', async () => {
      const view = { id: 'q', name: 'Queue', conditions: [
        condition('status', [{ id: '3', label: 'In Progress' }]),
        condition('assignee', [{ currentUser: true, label: 'Me' }]),
        condition('customfield_10050', [{ currentUser: true, label: 'Me' }])
      ], orderBy: { field: 'priority', direction: 'ASC' } };
      const { root, submit, calls } = open({ view, views: [view] });
      await flush();
      assert.deepEqual(titles(root), ['Condition 1', 'Condition 2', 'Condition 3']);
      assert.deepEqual(root.querySelectorAll('.custom-view-condition').map((b) => b.querySelector('select').value), ['status', 'assignee', 'customfield_10050']);
      submit();
      await flush();
      assert.deepEqual(calls[0][1].conditions.map((c) => c.field.id), ['status', 'assignee', 'customfield_10050']);
      assert.deepEqual(calls[0][1].orderBy, { field: 'priority', direction: 'ASC' });
    });

    it('offers the site\'s custom user fields once loaded, with In, Not in, and Me only', async () => {
      const { root } = open({ loadCustomFields: async () => [{ id: 'customfield_13931', name: 'QA Assignee', kind: 'user', group: 'User fields' }] });
      await flush();
      await flush();
      const groups = block(root, 1).querySelector('select').querySelectorAll('optgroup');
      assert.deepEqual(groups.map((g) => g.getAttribute('label')), ['Fields', 'Additional Assignment Fields', 'User fields']);
      await fill(root, 1, { field: 'customfield_13931' });
      assert.deepEqual(block(root, 1).querySelectorAll('select')[1].querySelectorAll('option').map((o) => o.textContent), ['In', 'Not in']);
      assert.deepEqual(block(root, 1).querySelectorAll('.custom-view-value').map((label) => label.textContent), ['Me']);
    });
  });

  describe('collapsible condition cards', () => {
    const cards = (root) => root.querySelectorAll('.custom-view-condition');
    const toggleOf = (card) => card.querySelector('[data-action="toggle-condition"]');
    const isOpen = (card) => toggleOf(card).getAttribute('aria-expanded') === 'true';
    const summaryOf = (card) => card.querySelector('.custom-view-condition-summary');
    const PENDING_VERIFY = [{ id: '10100', label: 'Pending' }, { id: '10200', label: 'Verify' }];
    const values = async (field) => (field.kind === 'user' ? [{ currentUser: true, label: 'Me' }]
      : field.id === 'status' ? [...PENDING_VERIFY, { id: '3', label: 'In Progress' }] : [{ id: '2', label: 'High' }]);
    const twoConditions = {
      id: 'q', name: 'Queue', conditions: [
        { field: { id: 'status', name: 'Status' }, operator: 'notIn', values: [...PENDING_VERIFY].reverse() },
        { field: { id: 'assignee', name: 'Assignee' }, operator: 'in', values: [{ currentUser: true, label: 'Me' }] }
      ]
    };

    it('heads each card with its chevron and number, then Delete, and sums it up while collapsed', async () => {
      const { root } = open({ view: twoConditions, views: [twoConditions], loadValues: values });
      await flush();
      const [first] = cards(root);
      const header = first.querySelector('.custom-view-condition-header');
      assert.deepEqual(header.children.map((child) => child.getAttribute('data-action')), ['toggle-condition', 'delete-condition']);
      assert.ok(toggleOf(first).querySelector('.custom-view-condition-chevron'));
      assert.equal(toggleOf(first).textContent, 'Condition 1');
      assert.equal(header.querySelector('[data-action="delete-condition"]').textContent, 'Delete');
      assert.equal(summaryOf(first).textContent, 'Status · Not in · Pending, Verify');
      assert.equal(summaryOf(cards(root)[1]).textContent, 'Assignee · In · Me');
    });

    it('opens a view with several conditions collapsed, to their summaries', async () => {
      const { root } = open({ view: twoConditions, views: [twoConditions], loadValues: values });
      await flush();
      for (const card of cards(root)) {
        assert.equal(isOpen(card), false);
        assert.ok(card.classList.contains('is-collapsed'));
        assert.ok(card.querySelector('.custom-view-condition-body').classList.contains('hidden'));
        assert.equal(summaryOf(card).classList.contains('hidden'), false);
      }
    });

    it('opens a single condition, and a new view\'s empty one, expanded', async () => {
      const single = { ...twoConditions, conditions: [twoConditions.conditions[0]] };
      const { root } = open({ view: single, views: [single], loadValues: values });
      await flush();
      assert.equal(isOpen(cards(root)[0]), true);
      assert.ok(summaryOf(cards(root)[0]).classList.contains('hidden'), 'no summary while expanded');
      const fresh = open();
      assert.equal(isOpen(cards(fresh.root)[0]), true);
      assert.equal(summaryOf(cards(fresh.root)[0]).textContent, 'No field chosen yet');
    });

    it('expands and collapses one card from its header, the others as they were', async () => {
      const { root } = open({ view: twoConditions, views: [twoConditions], loadValues: values });
      await flush();
      toggleOf(cards(root)[1]).click();
      assert.deepEqual(cards(root).map(isOpen), [false, true]);
      toggleOf(cards(root)[1]).click();
      assert.deepEqual(cards(root).map(isOpen), [false, false]);
      assert.equal(toggleOf(cards(root)[0]).getAttribute('aria-controls'), cards(root)[0].querySelector('.custom-view-condition-body').id);
    });

    it('keeps the summary in step with the field, operator, and values chosen', async () => {
      const { root } = open({ loadValues: values });
      const card = cards(root)[0];
      const select = card.querySelector('select');
      select.value = 'status';
      select.dispatchEvent({ type: 'change' });
      await flush();
      assert.equal(summaryOf(card).textContent, 'Status · In · No values chosen');
      for (const label of ['Verify', 'Pending']) {
        const input = card.querySelectorAll('.custom-view-value').find((el) => el.querySelector('span').textContent === label).querySelector('input');
        input.checked = true;
        input.dispatchEvent({ type: 'change' });
      }
      const operator = card.querySelectorAll('select')[1];
      operator.value = 'notIn';
      operator.dispatchEvent({ type: 'change' });
      toggleOf(card).click();
      assert.equal(summaryOf(card).textContent, 'Status · Not in · Pending, Verify');
    });

    it('adds a new condition expanded, leaving the others collapsed', async () => {
      const { root } = open({ view: twoConditions, views: [twoConditions], loadValues: values });
      await flush();
      root.querySelector('[data-action="add-condition"]').click();
      assert.deepEqual(cards(root).map(isOpen), [false, false, true]);
      assert.ok(document.activeElement === cards(root)[2].querySelector('select'), 'focus on the new field');
    });

    it('deletes a collapsed condition, renumbering the others, focus on the next one\'s header', async () => {
      const { root } = open({ view: twoConditions, views: [twoConditions], loadValues: values });
      await flush();
      cards(root)[0].querySelector('[data-action="delete-condition"]').click();
      assert.equal(cards(root).length, 1);
      assert.equal(toggleOf(cards(root)[0]).textContent, 'Condition 1');
      assert.equal(summaryOf(cards(root)[0]).textContent, 'Assignee · In · Me');
      assert.ok(document.activeElement === toggleOf(cards(root)[0]), 'focus on the remaining card\'s header');
    });

    it('expands a collapsed condition that has something to fix on Save, and focuses it', async () => {
      const broken = { ...twoConditions, conditions: [twoConditions.conditions[0], { field: { id: 'priority', name: 'Priority' }, operator: 'in', values: [{ id: '9', label: 'Gone' }] }] };
      const { root, $, submit, calls } = open({ view: broken, views: [broken], loadValues: values });
      await flush();
      // Clear the second condition's only value, while it's collapsed.
      const input = cards(root)[1].querySelectorAll('input').find((el) => el.checked);
      input.checked = false;
      input.dispatchEvent({ type: 'change' });
      submit();
      await flush();
      assert.deepEqual(cards(root).map(isOpen), [false, true]);
      assert.match($('#customViewValuesError-2').textContent, /Choose at least one value/);
      assert.deepEqual(calls, []);
    });
  });

  it('names the Ascending / Descending group for assistive technology only, without a visible label', () => {
    const { root } = open();
    const fieldset = root.querySelector('#customViewOrderASC').closest('fieldset');
    const legend = fieldset.querySelector('legend');
    assert.equal(legend.textContent, 'Direction');
    assert.equal(legend.className, 'sr-only');
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
