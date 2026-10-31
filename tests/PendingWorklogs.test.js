import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument, toHtml } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import { renderWorkingIssues } from '../src/ui/weekView.js';
import {
  renderPendingWorklogs, formatPendingDuration, siteBaseUrl, DISCARD_PENDING_WORDING
} from '../src/ui/pendingWorklogs.js';
import { openWorklogEditor, renderWorklogEditor } from '../src/ui/worklogEditor.js';
import { openDeleteWorklogDialog, describeWorklogForDeletion } from '../src/ui/deleteWorklogDialog.js';
import { toEditForm, toNewWorklogForm } from '../src/worklog/worklogEdit.js';
import { createTimeTrackingStore, siteId, TIME_TRACKING_KEY } from '../src/timer/timeTrackingStore.js';
import { createTimerController } from '../src/timer/timerController.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';

const SITE = siteId('cloud', 'https://acme.atlassian.net');
const OTHER_SITE = siteId('server', 'https://jira.example.com');
const T0 = new Date(2026, 9, 26, 9, 15).getTime();

const ISSUES = [
  { issueId: '10012', issueKey: 'KAN-12', issueSummary: 'Fix the login page', issueStatus: { name: 'In Progress', categoryKey: 'indeterminate' } }
];
const READY = { status: 'ready', issues: ISSUES };

const pendingEntry = (overrides = {}) => ({
  id: 'p1', site: SITE, issueId: '10020', issueKey: 'KAN-20', issueSummary: 'Write the docs',
  startedAt: T0, stoppedAt: T0 + 1_530_000, timeSpentSeconds: 1530, comment: '', ...overrides
});
const ENTRIES = [
  pendingEntry(),
  pendingEntry({ id: 'p2', issueId: '10021', issueKey: 'KAN-21', issueSummary: 'Quick call', startedAt: T0 + 3_600_000, stoppedAt: T0 + 3_645_000, timeSpentSeconds: 45 }),
  pendingEntry({ id: 'p3', site: OTHER_SITE, issueId: '500', issueKey: 'OPS-4', issueSummary: 'Old server task' })
];

const RUNNING = { id: 'r1', site: SITE, issueId: '10012', issueKey: 'KAN-12', issueSummary: 'Fix the login page', startedAt: T0 };

function sectionOptions({ entries = ENTRIES, tab = 'active', running = null, expanded = true } = {}) {
  const calls = { started: [], stopped: 0, tabs: [], edited: [], discarded: [] };
  return {
    calls,
    options: {
      state: READY,
      expanded,
      baseUrl: 'https://acme.atlassian.net',
      timer: {
        site: SITE, running, now: T0 + 5000,
        onStart: (issue) => calls.started.push(issue.issueKey),
        onStop: () => calls.stopped++
      },
      pending: {
        entries, site: SITE, tab,
        onTabChange: (t) => calls.tabs.push(t),
        onEdit: (id) => calls.edited.push(id),
        onDiscard: (id) => calls.discarded.push(id)
      }
    }
  };
}

function render(opts) {
  const { calls, options } = sectionOptions(opts);
  const section = h('section', { id: 'workingIssues' });
  renderWorkingIssues(section, options);
  return { section, calls, options };
}

const tab = (section, id) => section.querySelector(`#workingIssuesTab-${id}`);
const panel = (section, id) => section.querySelector(`#workingIssuesPanel-${id}`);

describe('My Active Issues - tabs', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  it('shows Active Issues and Pending tabs when expanded, with the issue list on the first', () => {
    const { section } = render();
    const tabs = section.querySelector('[role="tablist"]').querySelectorAll('[role="tab"]');

    assert.deepEqual(tabs.map((t) => t.dataset.tab), ['active', 'pending']);
    assert.equal(tab(section, 'active').getAttribute('aria-selected'), 'true');
    assert.equal(tab(section, 'active').getAttribute('tabindex'), '0');
    assert.equal(tab(section, 'pending').getAttribute('tabindex'), '-1');
    assert.equal(tab(section, 'active').textContent, 'Active Issues (1)');
    assert.equal(tab(section, 'pending').textContent, 'Pending (3)');
    assert.ok(!panel(section, 'active').classList.contains('hidden'));
    assert.ok(panel(section, 'pending').classList.contains('hidden'));
    assert.ok(panel(section, 'active').querySelector('.working-issues-list'));
    assert.equal(panel(section, 'active').querySelector('.working-issue-timer-btn').dataset.timerAction, 'start');
  });

  it('opens on the remembered Pending tab', () => {
    const { section } = render({ tab: 'pending' });
    assert.equal(tab(section, 'pending').getAttribute('aria-selected'), 'true');
    assert.ok(panel(section, 'active').classList.contains('hidden'));
    assert.equal(panel(section, 'pending').querySelectorAll('.pending-worklog').length, 3);
  });

  it('keeps the header as without tabs, adding only the pending line: title, issue summary, and running timer', () => {
    const { section } = render({ running: RUNNING, expanded: false });
    const { options } = sectionOptions({ running: RUNNING, expanded: false });
    const plain = h('section', { id: 'workingIssues' });
    renderWorkingIssues(plain, { ...options, pending: undefined });

    // Without the pending line, the headers are the same.
    const withoutPendingLine = (s) => toHtml(s.querySelector('.working-issues-heading')).replace(/<span class="working-issues-pending-count[^"]*">[^<]*<\/span>/, '');
    assert.equal(withoutPendingLine(section), withoutPendingLine(plain));
    assert.equal(section.querySelector('.working-issues-title').textContent, 'My Active Issues');
    assert.equal(section.querySelector('.working-issues-subtitle').textContent, '1 issue · In progress and recently logged');
    assert.equal(section.querySelector('.working-issues-count'), null, 'no count badge');
    assert.ok(plain.querySelector('.working-issues-pending-count').classList.contains('hidden'), 'no pending line without the timer');
  });

  it('shows the pending worklogs on their own line under the subtitle, collapsed or not', () => {
    for (const expanded of [false, true]) {
      const { section } = render({ expanded });
      const titles = section.querySelector('.working-issues-titles').childNodes.map((n) => n.className);
      assert.deepEqual(titles, ['working-issues-title', 'working-issues-subtitle', 'working-issues-pending-count']);
      const line = section.querySelector('.working-issues-pending-count');
      assert.ok(!line.classList.contains('hidden'));
      assert.equal(line.textContent, '3 pending worklogs');
    }
  });

  it('says "pending worklog" for one, and "pending worklogs" for none or several', () => {
    for (const [entries, expected] of [[[], '0 pending worklogs'], [ENTRIES.slice(0, 1), '1 pending worklog'], [ENTRIES.slice(0, 2), '2 pending worklogs']]) {
      const { section } = render({ entries });
      assert.equal(section.querySelector('.working-issues-pending-count').textContent, expected);
      assert.equal(tab(section, 'pending').textContent, `Pending (${entries.length})`);
    }
  });

  it('counts sessions, not issues: two pending worklogs on one issue count twice', () => {
    const twice = [pendingEntry(), pendingEntry({ id: 'p9', startedAt: T0 + 7_200_000, stoppedAt: T0 + 7_260_000, timeSpentSeconds: 60 })];
    const { section } = render({ entries: twice, tab: 'pending' });
    assert.equal(tab(section, 'pending').textContent, 'Pending (2)');
    assert.equal(section.querySelector('.working-issues-pending-count').textContent, '2 pending worklogs');
    assert.equal(panel(section, 'pending').querySelectorAll('.pending-worklog').length, 2);
  });

  it('counts the Active Issues rows, including the running issue Jira doesn\'t list, starting at 0', () => {
    const elsewhere = { ...RUNNING, issueId: '10099', issueKey: 'KAN-99' };
    assert.equal(tab(render({ running: elsewhere }).section, 'active').textContent, 'Active Issues (2)');
    assert.equal(tab(render({ running: RUNNING }).section, 'active').textContent, 'Active Issues (1)');

    // Both tabs start at (0): while Jira's issues load, after a failure, and with nothing pending.
    const { options } = sectionOptions({ entries: [] });
    const section = h('section');
    for (const state of [{ status: 'loading' }, { status: 'error', message: 'Server error' }, { status: 'ready', issues: [] }]) {
      renderWorkingIssues(section, { ...options, state });
      assert.equal(tab(section, 'active').textContent, 'Active Issues (0)', state.status);
      assert.equal(tab(section, 'pending').textContent, 'Pending (0)', state.status);
    }
    // The running issue is listed (and counted) while Jira's issues load.
    renderWorkingIssues(section, { ...options, state: { status: 'loading' }, timer: { ...options.timer, running: elsewhere } });
    assert.equal(tab(section, 'active').textContent, 'Active Issues (1)');
  });

  it('styles the tabs as the app\'s buttons: primary when selected, secondary otherwise', () => {
    const { section } = render();
    const classes = (id) => tab(section, id).className.split(' ');
    assert.deepEqual(classes('active'), ['btn', 'working-issues-tab', 'btn-primary']);
    assert.deepEqual(classes('pending'), ['btn', 'working-issues-tab', 'btn-secondary']);

    tab(section, 'pending').click();
    assert.ok(classes('pending').includes('btn-primary') && !classes('pending').includes('btn-secondary'));
    assert.ok(classes('active').includes('btn-secondary') && !classes('active').includes('btn-primary'));

    // Like Test Connection (btn btn-secondary) and Save Settings (btn btn-primary); no pill of their own.
    const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
    assert.match(html, /id="testConnectionBtn" class="btn btn-secondary"/);
    assert.match(html, /id="saveSettingsBtn" class="btn btn-primary"/);
    const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
    assert.doesNotMatch(css, /\.working-issues-tab \{|\.working-issues-tab-count/);
    assert.match(css, /\.working-issues-tab:focus-visible \{\s*outline: 2px solid var\(--border-focus\);/);
  });

  it('hides the tabs while collapsed, and keeps the running timer showing in the header', () => {
    const { section } = render({ running: RUNNING, expanded: false });
    assert.ok(section.querySelector('.working-issues-body').classList.contains('hidden'));
    assert.ok(section.querySelector('.working-issues-body').querySelector('[role="tablist"]'));
    const indicator = section.querySelector('.working-issues-timer');
    assert.ok(!indicator.classList.contains('hidden'));
    assert.equal(indicator.querySelector('.working-issues-timer-key').textContent, 'KAN-12');
  });

  it('switches tabs without touching the timer or pending worklogs, and reports the choice', () => {
    const { section, calls } = render({ running: RUNNING });

    tab(section, 'pending').click();
    assert.equal(tab(section, 'pending').getAttribute('aria-selected'), 'true');
    assert.ok(panel(section, 'active').classList.contains('hidden'));
    assert.ok(!panel(section, 'pending').classList.contains('hidden'));

    tab(section, 'active').click();
    assert.deepEqual(calls.tabs, ['pending', 'active']);
    assert.deepEqual(calls.started, []);
    assert.equal(calls.stopped, 0);
    assert.deepEqual(calls.edited, []);
    assert.deepEqual(calls.discarded, []);
  });

  it('moves between tabs with the arrow keys', () => {
    const { section } = render();
    const tablist = section.querySelector('[role="tablist"]');
    tablist.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} });
    assert.equal(document.activeElement, tab(section, 'pending'));
    tablist.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} });
    assert.equal(document.activeElement, tab(section, 'active'));
  });

  it('shows a note on the Active Issues tab while loading or when there are no issues', () => {
    const { options } = sectionOptions();
    const section = h('section');
    renderWorkingIssues(section, { ...options, state: { status: 'loading' } });
    assert.match(panel(section, 'active').textContent, /Retrieving issues from Jira/);
    renderWorkingIssues(section, { ...options, state: { status: 'ready', issues: [] } });
    assert.match(panel(section, 'active').textContent, /No issues in progress or logged in the last 14 days/);
  });

  it('keeps the old layout without pending options', () => {
    const { options } = sectionOptions();
    const section = h('section');
    renderWorkingIssues(section, { ...options, pending: undefined });
    assert.equal(section.querySelector('[role="tablist"]'), null);
    assert.ok(section.querySelector('.working-issues-body').childNodes[0].classList.contains('working-issues-list'));
  });
});

describe('My Active Issues - Pending tab', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  it('lists every pending worklog on its own row, most recently stopped first', () => {
    const { section } = render({ tab: 'pending' });
    const rows = panel(section, 'pending').querySelectorAll('.pending-worklog');
    assert.deepEqual(rows.map((r) => r.dataset.pendingId), ['p3', 'p2', 'p1']);
  });

  it('shows the issue, summary, local date and start time, and duration', () => {
    const { section } = render({ tab: 'pending' });
    const row = panel(section, 'pending').querySelector('[data-pending-id="p1"]');
    const time = new Date(T0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    assert.equal(row.querySelector('.issue-key-badge').textContent, 'KAN-20');
    assert.equal(row.querySelector('.issue-key-badge').getAttribute('href'), 'https://acme.atlassian.net/browse/KAN-20');
    assert.equal(row.querySelector('.pending-worklog-summary').textContent, 'Write the docs');
    assert.equal(row.querySelector('.pending-worklog-when').textContent, `26 Oct 2026 · Monday, ${time}`);
    assert.equal(row.querySelector('.pending-worklog-duration').textContent, '0h 25m');
    assert.equal(row.querySelector('.pending-edit-btn').getAttribute('aria-label'), `Edit pending worklog for KAN-20, started ${time}`);
    assert.equal(row.querySelector('.pending-discard-btn').getAttribute('aria-label'), `Discard pending worklog for KAN-20, started ${time}`);
  });

  it('flags a session under a minute, showing its seconds', () => {
    const { section } = render({ tab: 'pending' });
    const row = panel(section, 'pending').querySelector('[data-pending-id="p2"]');
    assert.ok(row.classList.contains('is-too-short'));
    assert.equal(row.querySelector('.pending-worklog-duration').textContent, '45s');
    assert.equal(row.querySelector('.pending-flag.is-warning').textContent, 'Under 1 minute');
  });

  it('keeps a worklog from another Jira site visible, marked and linked to its own site', () => {
    const { section } = render({ tab: 'pending' });
    const row = panel(section, 'pending').querySelector('[data-pending-id="p3"]');
    assert.ok(row.classList.contains('is-other-site'));
    assert.equal(row.querySelector('.pending-flag').textContent, 'Other site · jira.example.com');
    assert.equal(row.querySelector('.issue-key-badge').getAttribute('href'), 'https://jira.example.com/browse/OPS-4');
    assert.ok(row.querySelector('.pending-edit-btn'));
    assert.ok(row.querySelector('.pending-discard-btn'));
  });

  it('calls back with the pending worklog\'s ID from Edit and Discard', () => {
    const { section, calls } = render({ tab: 'pending' });
    panel(section, 'pending').querySelector('.pending-edit-btn[data-pending-id="p2"]').click();
    panel(section, 'pending').querySelector('.pending-discard-btn[data-pending-id="p3"]').click();
    assert.deepEqual(calls.edited, ['p2']);
    assert.deepEqual(calls.discarded, ['p3']);
  });

  it('shows a short note when nothing is pending', () => {
    const { section } = render({ tab: 'pending', entries: [] });
    assert.equal(panel(section, 'pending').querySelector('.pending-worklogs'), null);
    assert.match(panel(section, 'pending').querySelector('.working-issues-empty').textContent, /^No pending worklogs\./);
    assert.equal(tab(section, 'pending').textContent, 'Pending (0)');
  });

  it('follows new pending worklogs (another tab\'s changes), keeping focus on the same button', () => {
    const { section, options } = render({ tab: 'pending' });
    panel(section, 'pending').querySelector('.pending-edit-btn[data-pending-id="p2"]').focus();

    renderWorkingIssues(section, { ...options, pending: { ...options.pending, entries: ENTRIES.filter((e) => e.id !== 'p1') } });

    assert.deepEqual(panel(section, 'pending').querySelectorAll('.pending-worklog').map((r) => r.dataset.pendingId), ['p3', 'p2']);
    assert.equal(tab(section, 'pending').textContent, 'Pending (2)');
    assert.equal(section.querySelector('.working-issues-pending-count').textContent, '2 pending worklogs');
    assert.equal(document.activeElement.dataset.focusKey, 'edit:p2');
  });

  it('moves focus to the Pending tab when the focused worklog is gone', () => {
    const { section, options } = render({ tab: 'pending' });
    panel(section, 'pending').querySelector('.pending-discard-btn[data-pending-id="p1"]').focus();
    renderWorkingIssues(section, { ...options, pending: { ...options.pending, entries: ENTRIES.filter((e) => e.id !== 'p1') } });
    assert.equal(document.activeElement, tab(section, 'pending'));
  });

  it('formats durations and site addresses', () => {
    assert.equal(formatPendingDuration(0), '0s');
    assert.equal(formatPendingDuration(59), '59s');
    assert.equal(formatPendingDuration(60), '0h 01m');
    assert.equal(formatPendingDuration(3725), '1h 02m');
    assert.equal(siteBaseUrl('cloud|https://acme.atlassian.net'), 'https://acme.atlassian.net');
  });

  it('renders on its own, without the section', () => {
    const list = renderPendingWorklogs({ entries: ENTRIES, site: SITE, onEdit: () => {}, onDiscard: () => {} });
    assert.equal(list.querySelectorAll('.pending-worklog').length, 3);
  });
});

// A page's timer, on in-memory storage, with a fake Jira client whose worklog calls are recorded:
// managing pending worklogs must never reach them.
async function createTimerPage() {
  const storage = createMemoryStorageArea();
  let tail = Promise.resolve();
  const lock = { run(fn) { const r = tail.then(() => fn()); tail = r.catch(() => {}); return r; } };
  let clock = T0;
  const store = createTimeTrackingStore(storage, { lock, now: () => clock });
  const errors = [];
  const controller = createTimerController({
    createStore: () => store,
    watchStorage: () => () => {},
    onChange: () => {},
    onTick: () => {},
    onError: (message) => errors.push(message),
    setInterval: () => 1,
    clearInterval: () => {}
  });
  await controller.init();
  const jiraCalls = [];
  const jira = Object.fromEntries(['createWorklog', 'updateWorklog', 'deleteWorklog'].map((name) =>
    [name, async (...args) => { jiraCalls.push([name, ...args]); return {}; }]));
  const advance = (ms) => { clock += ms; };
  return { storage, store, controller, errors, jira, jiraCalls, advance };
}

describe('My Active Issues - counts follow the stored state', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  // The section as options.js renders it from a page's timer state (no Jira: the list is fixed).
  function renderFrom(page, section = h('section', { id: 'workingIssues' }), { expanded = false } = {}) {
    const { running, pending } = page.controller.getState().tracking;
    renderWorkingIssues(section, {
      state: READY, expanded, baseUrl: 'https://acme.atlassian.net',
      timer: { site: SITE, running, now: T0, onStart: (i) => page.controller.start({ site: SITE, issueId: i.issueId, issueKey: i.issueKey }), onStop: () => page.controller.stop() },
      pending: { entries: pending, site: SITE, tab: 'active', onEdit: () => {}, onDiscard: () => {} }
    });
    return section;
  }
  const counts = (section) => ({
    active: section.querySelector('#workingIssuesTab-active').textContent,
    pending: section.querySelector('#workingIssuesTab-pending').textContent,
    line: section.querySelector('.working-issues-pending-count').textContent,
    timer: section.querySelector('.working-issues-timer').classList.contains('hidden') ? null : section.querySelector('.working-issues-timer-key').textContent
  });

  it('updates on stop, switch, and discard, and lists then drops a running issue Jira doesn\'t list', async () => {
    const page = await createTimerPage();
    const section = renderFrom(page);
    assert.deepEqual(counts(section), { active: 'Active Issues (1)', pending: 'Pending (0)', line: '0 pending worklogs', timer: null });

    // KAN-10 isn't in Jira's list (started from the Log work panel): it's listed while it runs.
    await page.controller.start({ site: SITE, issueId: '10010', issueKey: 'KAN-10', issueSummary: 'Onboarding guide' });
    renderFrom(page, section);
    assert.deepEqual(counts(section), { active: 'Active Issues (2)', pending: 'Pending (0)', line: '0 pending worklogs', timer: 'KAN-10' });
    assert.ok(section.querySelector('.is-timer-only').querySelector('.working-issue-timer-btn[data-timer-action="stop"]'));

    // Stop from its row: its session is pending, and the row and header timer go.
    page.advance(90_000);
    section.querySelector('.is-timer-only').querySelector('.working-issue-timer-btn[data-timer-action="stop"]').click();
    await new Promise((resolve) => setImmediate(resolve));
    renderFrom(page, section);
    assert.deepEqual(counts(section), { active: 'Active Issues (1)', pending: 'Pending (1)', line: '1 pending worklog', timer: null });
    assert.deepEqual(page.controller.getState().tracking.pending.map((p) => [p.issueKey, p.timeSpentSeconds]), [['KAN-10', 90]]);
    assert.equal(section.querySelector('.is-timer-only'), null);

    // Switching finalizes the previous session.
    await page.controller.start({ site: SITE, issueId: '10012', issueKey: 'KAN-12' });
    page.advance(60_000);
    await page.controller.start({ site: SITE, issueId: '10013', issueKey: 'KAN-13' });
    renderFrom(page, section);
    assert.deepEqual(counts(section), { active: 'Active Issues (2)', pending: 'Pending (2)', line: '2 pending worklogs', timer: 'KAN-13' });

    await page.controller.discardPending(page.controller.getState().tracking.pending[0].id);
    renderFrom(page, section);
    assert.deepEqual(counts(section), { active: 'Active Issues (2)', pending: 'Pending (1)', line: '1 pending worklog', timer: 'KAN-13' });
    assert.deepEqual(page.jiraCalls, []);
  });

  it('updates from another tab\'s change, collapsed, without writing', async () => {
    const storage = createMemoryStorageArea();
    let tail = Promise.resolve();
    const lock = { run(fn) { const r = tail.then(() => fn()); tail = r.catch(() => {}); return r; } };
    let section = null;
    const makePage = (onChange) => {
      const store = createTimeTrackingStore(storage, { lock, now: () => T0 + 60_000 });
      const controller = createTimerController({
        createStore: () => store,
        watchStorage: (listener) => { storage.onChanged.addListener(listener); return () => storage.onChanged.removeListener(listener); },
        onChange, onTick: () => {}, onError: () => {}, setInterval: () => 1, clearInterval: () => {}
      });
      return { controller };
    };
    const tabB = makePage(() => { if (tabB.controller.getState().tracking) section = renderFrom(tabB, section ?? undefined); });
    const tabA = makePage(() => {});
    await tabA.controller.init();
    await tabB.controller.init();
    let writes = 0;
    const set = storage.set;
    storage.set = async (items) => { writes++; return set(items); };

    await tabA.controller.start({ site: SITE, issueId: '10012', issueKey: 'KAN-12' });
    await tabA.controller.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(section.querySelector('.working-issues-body').classList.contains('hidden'), true, 'collapsed');
    assert.equal(section.querySelector('.working-issues-pending-count').textContent, '1 pending worklog');
    assert.equal(section.querySelector('#workingIssuesTab-pending').textContent, 'Pending (1)');
    assert.equal(writes, 2, 'tab B only read');
  });
});

describe('Editing a pending worklog', () => {
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

  /** Opens the panel the way options.js does for a pending worklog. */
  function openPending(page, entry, { onClose = () => {} } = {}) {
    const root = h('aside', { class: 'worklog-editor hidden' });
    const expected = { startedAt: entry.startedAt, timeSpentSeconds: entry.timeSpentSeconds, comment: entry.comment };
    openWorklogEditor(root, {
      mode: 'pending',
      worklog: { ...entry, started: new Date(entry.startedAt).toISOString() },
      baseUrl: siteBaseUrl(entry.site),
      onSave: (changes) => page.controller.updatePending(entry.id, {
        startedAt: changes.started?.getTime(), timeSpentSeconds: changes.timeSpentSeconds, comment: changes.comment
      }, expected),
      onClose
    });
    return root;
  }
  const setField = (root, selector, value) => {
    const input = root.querySelector(selector);
    input.value = value;
    input.dispatchEvent({ type: 'input' });
  };

  it('is the worklog panel in an explicit local mode: its own title and note, Save, and no Delete', () => {
    const html = toHtml(renderWorklogEditor(pendingEntry({ started: new Date(T0).toISOString() }), toEditForm({ started: new Date(T0), timeSpentSeconds: 1530 }), '', { mode: 'pending' }));
    assert.match(html, /id="worklogEditorTitle">Edit pending worklog</);
    assert.match(html, /saved in this browser only\. Nothing is sent to Jira until you submit this worklog\./);
    assert.match(html, /data-save-label="">Save</);
    assert.doesNotMatch(html, /data-action="delete"|data-confirm="delete"|data-action="start-timer"/);
  });

  it('opens with the pending worklog\'s issue, date, start time, duration, and comment', async () => {
    const page = await createTimerPage();
    const entry = pendingEntry({ comment: 'Draft notes' });
    const root = openPending(page, entry);
    assert.equal(root.querySelector('.editor-issue').querySelector('.issue-key-badge').textContent, 'KAN-20');
    assert.equal(root.querySelector('#worklogEditDate').value, '2026-10-26');
    assert.equal(root.querySelector('#worklogEditTime').value, '09:15');
    assert.equal(root.querySelector('#worklogEditHours').value, '0');
    assert.equal(root.querySelector('#worklogEditMinutes').value, '25');
    assert.equal(root.querySelector('#worklogEditComment').textContent, 'Draft notes');
  });

  it('saves the changed fields to the selected pending worklog only, and never calls Jira', async () => {
    const page = await createTimerPage();
    await page.controller.start({ site: SITE, issueId: '10020', issueKey: 'KAN-20', issueSummary: 'Write the docs' });
    page.advance(1_530_500);
    await page.controller.start({ site: SITE, issueId: '10021', issueKey: 'KAN-21' });
    page.advance(60_000);
    await page.controller.stop();
    const [first, second] = page.controller.getState().tracking.pending;
    const closed = [];

    const root = openPending(page, first, { onClose: (reason) => closed.push(reason) });
    setField(root, '#worklogEditMinutes', '40');
    setField(root, '#worklogEditComment', 'Wrote the setup guide');
    root.querySelector('.editor-form').dispatchEvent({ type: 'submit' });
    await flush();

    const [edited, untouched] = page.controller.getState().tracking.pending;
    assert.deepEqual(closed, ['saved']);
    assert.equal(edited.id, first.id);
    assert.equal(edited.timeSpentSeconds, 40 * 60);
    assert.equal(edited.comment, 'Wrote the setup guide');
    assert.equal(edited.startedAt, first.startedAt, 'the start time was not changed');
    assert.deepEqual(untouched, second);
    assert.deepEqual(page.jiraCalls, []);
  });

  it('keeps the exact seconds when only the comment changes', async () => {
    const page = await createTimerPage();
    await page.controller.start({ site: SITE, issueId: '10020', issueKey: 'KAN-20' });
    page.advance(1_530_000);
    await page.controller.stop();
    const [entry] = page.controller.getState().tracking.pending;

    const root = openPending(page, entry);
    setField(root, '#worklogEditComment', 'Notes');
    root.querySelector('.editor-form').dispatchEvent({ type: 'submit' });
    await flush();

    assert.equal(page.controller.getState().tracking.pending[0].timeSpentSeconds, 1530);
  });

  it('keeps a short session pending, warns about it, and lets its duration be raised to a minute', async () => {
    const page = await createTimerPage();
    await page.controller.start({ site: SITE, issueId: '10021', issueKey: 'KAN-21' });
    page.advance(45_000);
    await page.controller.stop();
    const [entry] = page.controller.getState().tracking.pending;

    const root = openPending(page, entry);
    assert.match(root.querySelector('.editor-short-note').textContent, /under a minute/);

    // Only the comment: the form needs a duration of a minute, so nothing is saved yet.
    setField(root, '#worklogEditComment', 'Call');
    root.querySelector('.editor-form').dispatchEvent({ type: 'submit' });
    await flush();
    assert.match(root.querySelector('[data-error-for="duration"]').textContent, /at least 1 minute/);
    assert.equal(page.controller.getState().tracking.pending[0].timeSpentSeconds, 45);

    setField(root, '#worklogEditMinutes', '1');
    root.querySelector('.editor-form').dispatchEvent({ type: 'submit' });
    await flush();
    assert.equal(page.controller.getState().tracking.pending[0].timeSpentSeconds, 60);
    assert.equal(page.controller.getState().tracking.pending[0].comment, 'Call');
  });

  it('shows why a save failed (changed in another tab) and keeps the panel open', async () => {
    const page = await createTimerPage();
    await page.controller.start({ site: SITE, issueId: '10020', issueKey: 'KAN-20' });
    page.advance(120_000);
    await page.controller.stop();
    const [entry] = page.controller.getState().tracking.pending;
    const closed = [];
    const root = openPending(page, entry, { onClose: (reason) => closed.push(reason) });

    // Another tab edits it while the panel is open.
    await page.store.updatePending(entry.id, { comment: 'Other tab' });
    setField(root, '#worklogEditComment', 'Mine');
    root.querySelector('.editor-form').dispatchEvent({ type: 'submit' });
    await flush();

    assert.deepEqual(closed, []);
    assert.match(root.querySelector('[data-submit-error]').textContent, /changed in another tab/);
    assert.equal((await page.store.load()).pending[0].comment, 'Other tab');
  });
});

describe('Discarding a pending worklog', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function fakeDialog() {
    const dialog = h('dialog');
    dialog.open = false;
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    return dialog;
  }

  async function withTwoPending() {
    const page = await createTimerPage();
    await page.controller.start({ site: SITE, issueId: '10020', issueKey: 'KAN-20', issueSummary: 'Write the docs' });
    page.advance(1_530_000);
    await page.controller.start({ site: SITE, issueId: '10021', issueKey: 'KAN-21' });
    page.advance(60_000);
    await page.controller.start({ site: SITE, issueId: '10022', issueKey: 'KAN-22' });
    return page;
  }

  /** Opens the confirmation the way options.js does. */
  function openDiscard(page, entry, closed, dialog = fakeDialog()) {
    openDeleteWorklogDialog(dialog, {
      details: {
        ...describeWorklogForDeletion({ ...entry, started: new Date(entry.startedAt) }),
        duration: formatPendingDuration(entry.timeSpentSeconds)
      },
      wording: DISCARD_PENDING_WORDING,
      onDelete: () => page.controller.discardPending(entry.id),
      onClose: (reason) => closed.push(reason)
    });
    return dialog;
  }

  it('asks first, naming the issue and duration, and says nothing was sent to Jira', async () => {
    const page = await withTwoPending();
    const [entry] = page.controller.getState().tracking.pending;
    const dialog = openDiscard(page, entry, []);

    assert.equal(dialog.querySelector('.confirm-dialog-title').textContent, 'Discard pending worklog?');
    assert.match(dialog.querySelector('.confirm-dialog-text').textContent, /never sent to Jira/);
    const details = dialog.querySelector('.confirm-dialog-details').querySelectorAll('dd').map((dd) => dd.textContent);
    assert.equal(details[0], 'KAN-20 · Write the docs');
    assert.equal(details[2], '0h 25m');
    assert.equal(dialog.querySelector('[data-action="delete"]').textContent, 'Discard');
  });

  it('changes nothing when cancelled', async () => {
    const page = await withTwoPending();
    const before = (await page.storage.get(TIME_TRACKING_KEY))[TIME_TRACKING_KEY];
    const closed = [];
    const dialog = openDiscard(page, before.pending[0], closed);

    dialog.querySelector('[data-action="cancel"]').click();
    await flush();

    assert.deepEqual(closed, ['cancelled']);
    assert.deepEqual((await page.storage.get(TIME_TRACKING_KEY))[TIME_TRACKING_KEY], before);
  });

  it('removes only that pending worklog, keeps the running timer, and never calls Jira', async () => {
    const page = await withTwoPending();
    const [first, second] = page.controller.getState().tracking.pending;
    const running = page.controller.getState().tracking.running;
    const closed = [];
    const dialog = openDiscard(page, first, closed);

    dialog.querySelector('[data-action="delete"]').click();
    await flush();

    assert.deepEqual(closed, ['deleted']);
    assert.deepEqual(page.controller.getState().tracking.pending, [second]);
    assert.deepEqual(page.controller.getState().tracking.running, running);
    assert.deepEqual(page.jiraCalls, []);
  });

  it('stays open with the reason when the worklog is already gone, discarding nothing else', async () => {
    const page = await withTwoPending();
    const [first, second] = page.controller.getState().tracking.pending;
    const closed = [];
    const dialog = openDiscard(page, first, closed);
    // Another tab discards it first.
    await page.store.discardPending(first.id);

    dialog.querySelector('[data-action="delete"]').click();
    await flush();

    assert.deepEqual(closed, []);
    assert.match(dialog.querySelector('[data-delete-error]').textContent, /no longer here/);
    assert.deepEqual((await page.store.load()).pending, [second]);
  });

  it('times an issue with a pending worklog again, and discards one of its sessions only', async () => {
    const page = await withTwoPending();
    const [first] = page.controller.getState().tracking.pending;

    // KAN-20 has a pending worklog: a new session starts anyway, and becomes a second one.
    assert.equal(await page.controller.start({ site: SITE, issueId: '10020', issueKey: 'KAN-20' }), true);
    page.advance(60_000);
    await page.controller.stop();
    const kan20 = page.controller.getState().tracking.pending.filter((p) => p.issueKey === 'KAN-20');
    assert.equal(kan20.length, 2);
    assert.deepEqual(page.errors, []);

    await page.controller.discardPending(first.id);
    assert.deepEqual(page.controller.getState().tracking.pending.filter((p) => p.issueKey === 'KAN-20').map((p) => p.id), [kan20[1].id]);
  });

  it('ignores a late close event from the previous confirmation after reopening', async () => {
    const page = await withTwoPending();
    const [entry] = page.controller.getState().tracking.pending;
    const closed = [];
    const dialog = openDiscard(page, entry, closed);
    dialog.querySelector('[data-action="cancel"]').click();

    // Reopened before the browser delivered the first close's `close` event.
    openDiscard(page, entry, closed, dialog);
    dialog.dispatchEvent({ type: 'close' });

    assert.deepEqual(closed, ['cancelled']);
    assert.equal(dialog.open, true);
    assert.ok(dialog.querySelector('[data-action="delete"]'), 'the new confirmation is still there');
  });

  it('still closes when the browser closes the dialog itself', async () => {
    const page = await withTwoPending();
    const [entry] = page.controller.getState().tracking.pending;
    const closed = [];
    const dialog = openDiscard(page, entry, closed);
    dialog.open = false;
    dialog.dispatchEvent({ type: 'close' });
    assert.deepEqual(closed, ['cancelled']);
  });

  it('keeps the delete confirmation\'s own wording by default', () => {
    const dialog = fakeDialog();
    openDeleteWorklogDialog(dialog, {
      worklog: { issueKey: 'KAN-9', started: new Date(T0).toISOString(), timeSpentSeconds: 3600 },
      onDelete: async () => {}, onClose: () => {}
    });
    assert.equal(dialog.querySelector('.confirm-dialog-title').textContent, 'Delete worklog?');
    assert.equal(dialog.querySelector('[data-action="delete"]').textContent, 'Delete worklog');
  });
});

describe('Log work panel - timer button', () => {
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
  const issue = { issueId: '10020', issueKey: 'KAN-20', issueSummary: 'Write the docs', issueStatus: { name: 'In Progress', categoryKey: 'indeterminate' } };

  /** A timer stand-in: `running` by issue key, with the calls recorded. */
  function fakeTimer({ running = null, result = true } = {}) {
    const calls = [];
    return {
      calls,
      running,
      stateOf(i) { return { running: this.running === i.issueKey }; },
      async onStart(i) { calls.push(['start', i.issueKey]); return result; },
      async onStop() { calls.push(['stop']); return result; }
    };
  }

  function openLogWork({ worklog = issue, timer, onSave = async () => {} } = {}) {
    const root = h('aside', { class: 'worklog-editor hidden' });
    const closed = [];
    const saved = [];
    const editor = openWorklogEditor(root, {
      mode: 'create',
      worklog,
      baseUrl: '',
      initialForm: toNewWorklogForm({ dateKey: '2026-10-26', now: new Date(T0) }),
      timer,
      onSave: async (...args) => { saved.push(args); return onSave(...args); },
      onClose: (reason) => closed.push(reason),
      searchIssues: async () => [issue]
    });
    return { root, closed, saved, editor };
  }
  const timerButton = (root) => root.querySelector('[data-action="timer"]');

  it('sits in the footer, right of Log work; the issue shows as before', () => {
    const { root } = openLogWork({ timer: fakeTimer() });
    const actions = root.querySelector('[data-actions="main"]');
    assert.deepEqual(actions.childNodes.map((n) => n.dataset.action ?? n.className),
      ['editor-actions-spacer', 'cancel', 'save', 'timer']);
    assert.equal(actions.querySelector('[data-action="save"]').textContent, 'Log work');
    assert.equal(timerButton(root).getAttribute('type'), 'button', 'it never submits the form');

    const issueEl = root.querySelector('.editor-issue');
    assert.equal(issueEl.className, 'editor-issue');
    assert.deepEqual(issueEl.childNodes.map((n) => n.className), ['editor-issue-row', 'editor-issue-summary']);
    assert.equal(issueEl.querySelector('[data-action="timer"]'), null);
    assert.equal(root.querySelector('[data-action="start-timer"]'), null);
  });

  it('shows play and "Start timer" when the issue isn\'t running, even while another issue is', () => {
    for (const running of [null, 'KAN-12']) {
      const { root } = openLogWork({ timer: fakeTimer({ running }) });
      const button = timerButton(root);
      assert.equal(button.dataset.timerAction, 'start');
      assert.equal(button.getAttribute('aria-label'), 'Start timer');
      assert.equal(button.getAttribute('title'), 'Start timer');
      assert.ok(!button.classList.contains('is-running'));
      assert.match(toHtml(button), /<polygon points="7 4 20 12 7 20 7 4">/);
    }
  });

  it('shows stop and "Stop timer" when the issue is running', () => {
    const { root } = openLogWork({ timer: fakeTimer({ running: 'KAN-20' }) });
    const button = timerButton(root);
    assert.equal(button.dataset.timerAction, 'stop');
    assert.equal(button.getAttribute('aria-label'), 'Stop timer');
    assert.equal(button.getAttribute('title'), 'Stop timer');
    assert.ok(button.classList.contains('is-running'));
    assert.match(toHtml(button), /<rect x="6" y="6" width="12" height="12" rx="1">/);
  });

  it('has no timer button without the timer, and hides it before an issue is chosen or when its state is unknown', async () => {
    assert.equal(timerButton(openLogWork().root), null);
    assert.deepEqual(openLogWork().root.querySelector('[data-actions="main"]').querySelectorAll('button').map((b) => b.dataset.action), ['cancel', 'save']);

    const picking = openLogWork({ worklog: null, timer: fakeTimer() });
    assert.ok(timerButton(picking.root).classList.contains('hidden'));

    const unknown = openLogWork({ timer: { stateOf: () => null, onStart: async () => true, onStop: async () => true } });
    assert.ok(timerButton(unknown.root).classList.contains('hidden'));
  });

  it('appears once an issue is chosen, and choosing it never starts a timer', async () => {
    const timer = fakeTimer();
    const { root } = openLogWork({ worklog: null, timer });
    const search = root.querySelector('#worklogIssueSearch');
    search.value = 'KAN-20';
    search.dispatchEvent({ type: 'input' });
    mock.timers.tick(1000);
    await flush();
    root.querySelector('[role="option"]').click();

    const button = timerButton(root);
    assert.ok(button);
    assert.ok(!button.classList.contains('hidden'));
    assert.equal(button.getAttribute('aria-label'), 'Start timer');
    assert.ok(root.querySelector('[data-actions="main"]').querySelectorAll('button').includes(button), 'in the footer');
    assert.deepEqual(timer.calls, []);
  });

  it('starts the timer on the issue without logging work, then closes when nothing was entered', async () => {
    const timer = fakeTimer();
    const { root, closed, saved } = openLogWork({ timer });
    timerButton(root).click();
    await flush();
    assert.deepEqual(timer.calls, [['start', 'KAN-20']]);
    assert.deepEqual(saved, [], 'no worklog was logged');
    assert.deepEqual(closed, ['closed']);
  });

  it('stops the running timer without logging work, then closes', async () => {
    const timer = fakeTimer({ running: 'KAN-20' });
    const { root, closed, saved } = openLogWork({ timer });
    timerButton(root).click();
    await flush();
    assert.deepEqual(timer.calls, [['stop']]);
    assert.deepEqual(saved, []);
    assert.deepEqual(closed, ['closed']);
  });

  it('asks before discarding entered values after a start, and never logs them', async () => {
    const timer = fakeTimer();
    const { root, closed, saved } = openLogWork({ timer });
    const hours = root.querySelector('#worklogEditHours');
    hours.value = '2';
    hours.dispatchEvent({ type: 'input' });

    timerButton(root).click();
    await flush();

    assert.deepEqual(timer.calls, [['start', 'KAN-20']]);
    assert.deepEqual(saved, []);
    assert.deepEqual(closed, []);
    assert.ok(!root.querySelector('[data-confirm="discard"]').classList.contains('hidden'), 'the discard question shows');
  });

  it('stays open as it was when the timer refuses or fails', async () => {
    const timer = fakeTimer({ result: false });
    const { root, closed, saved } = openLogWork({ timer });
    timerButton(root).click();
    await flush();
    assert.deepEqual(closed, []);
    assert.deepEqual(saved, []);
    assert.equal(timerButton(root).getAttribute('aria-disabled'), null, 'usable again');
  });

  it('marks the button busy and ignores clicks while a start is in progress', async () => {
    let finish;
    const timer = { ...fakeTimer(), calls: [] };
    timer.onStart = (i) => { timer.calls.push(i.issueKey); return new Promise((resolve) => { finish = resolve; }); };
    const { root } = openLogWork({ timer });

    timerButton(root).click();
    assert.equal(timerButton(root).getAttribute('aria-disabled'), 'true');
    timerButton(root).click();
    assert.deepEqual(timer.calls, ['KAN-20']);
    finish(false);
    await flush();
    assert.equal(timerButton(root).getAttribute('aria-disabled'), null);
  });

  it('follows the timer when it changes elsewhere, keeping the same button', () => {
    const timer = fakeTimer();
    const { root, editor } = openLogWork({ timer });
    const button = timerButton(root);
    timer.running = 'KAN-20';
    editor.refreshTimer();
    assert.equal(timerButton(root), button);
    assert.equal(button.getAttribute('aria-label'), 'Stop timer');
  });

  it('leaves Log work as it was: it still logs the entered work', async () => {
    const timer = fakeTimer();
    const { root, saved, closed } = openLogWork({ timer });
    const hours = root.querySelector('#worklogEditHours');
    hours.value = '1';
    hours.dispatchEvent({ type: 'input' });
    root.querySelector('.editor-form').dispatchEvent({ type: 'submit' });
    await flush();
    assert.equal(saved.length, 1);
    assert.equal(saved[0][0].timeSpentSeconds, 3600);
    assert.deepEqual(closed, ['saved']);
    assert.deepEqual(timer.calls, [], 'logging work never touches the timer');
  });

  it('is styled as the Active Issues timer buttons, and leaves the issue\'s layout alone', () => {
    const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
    assert.match(css, /\.working-issue-timer-btn:focus-visible,/);
    assert.doesNotMatch(css, /\.editor-issue\.has-timer/);
  });

  it('styles the timer buttons: solid blue Play (as Log work), light-red Stop, neutral Pause', () => {
    const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
    // The declarations of the rule whose selector list starts with `selector`.
    const rule = (selector) => {
      const at = css.indexOf(`${selector}`);
      return at < 0 ? '' : css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    };
    const play = rule('.working-issue-timer-btn[data-timer-action="start"],\n.working-issue-timer-btn[data-timer-action="resume"] {');
    const playHover = rule('.working-issue-timer-btn[data-timer-action="start"]:hover,');
    assert.match(play, /color: #ffffff;\s*background-color: var\(--primary\);\s*border-color: var\(--primary\);/);
    assert.match(playHover, /background-color: var\(--primary-hover\);/);
    assert.match(css, /\.working-issue-timer-btn\[data-timer-action="resume"\]:active \{/);
    // The Log work button's own blue.
    assert.match(rule('.btn-primary {'), /background-color: var\(--primary\);\s*color: #ffffff;/);

    // Stop: light red, never solid; a stronger tint on hover.
    const stop = rule('.working-issue-timer-btn.is-running {');
    const stopHover = rule('.working-issue-timer-btn.is-running:hover {');
    assert.match(stop, /color: var\(--danger\);\s*background-color: var\(--danger-bg\);\s*border-color: var\(--danger-border\);/);
    assert.match(stopHover, /background-color: var\(--danger-border\);\s*border-color: var\(--danger\);/);
    assert.doesNotMatch(stop + stopHover, /background-color: var\(--danger\);/);

    // Pause has no rule of its own: the neutral base style.
    assert.doesNotMatch(css, /data-timer-action="pause"/);
    // Keyboard focus stays visible on all of them.
    assert.match(css, /\.working-issue-timer-btn:focus-visible,/);

    // The panel's button is a play button of the same kind.
    const { root } = openLogWork({ timer: fakeTimer() });
    assert.equal(timerButton(root).dataset.timerAction, 'start');
    assert.ok(timerButton(root).classList.contains('working-issue-timer-btn'));
  });

  describe('Edit worklog panel is unaffected', () => {
    const worklog = {
      id: '10012', issueId: '10020', issueKey: 'KAN-20', issueSummary: 'Write the docs', issueStatus: null,
      started: '2026-10-26T09:15:00.000+0000', timeSpentSeconds: 3600, comment: 'Docs'
    };
    const footerOf = (root) => root.querySelector('[data-actions="main"]').childNodes.map((n) => n.dataset.action ?? n.className);

    it('keeps its footer and issue, with no timer button even when the page passes the timer', () => {
      for (const timer of [undefined, fakeTimer(), fakeTimer({ running: 'KAN-20' })]) {
        const root = h('aside', { class: 'worklog-editor hidden' });
        openWorklogEditor(root, { worklog, baseUrl: '', timer, onSave: async () => {}, onDelete: async () => {}, onClose: () => {} });
        assert.equal(root.querySelector('#worklogEditorTitle').textContent, 'Edit worklog');
        assert.deepEqual(footerOf(root), ['delete', 'editor-actions-spacer', 'cancel', 'save']);
        assert.equal(root.querySelector('[data-action="save"]').textContent, 'Save changes');
        assert.equal(timerButton(root), null);
        assert.equal(root.querySelector('.editor-issue').className, 'editor-issue');
        assert.deepEqual(root.querySelector('.editor-issue').childNodes.map((n) => n.className), ['editor-issue-row', 'editor-issue-summary']);
        assert.ok(root.querySelector('[data-confirm="delete"]'), 'its delete confirmation stays');
      }
    });

    it('renders exactly as before the Log work timer existed', () => {
      const form = toEditForm(worklog);
      const withTimer = toHtml(renderWorklogEditor(worklog, form, 'https://acme.atlassian.net', { mode: 'edit', timerState: { running: false } }));
      const without = toHtml(renderWorklogEditor(worklog, form, 'https://acme.atlassian.net', { mode: 'edit' }));
      assert.equal(withTimer, without);
      assert.doesNotMatch(without, /data-action="timer"|working-issue-timer-btn/);
    });

    it('still saves and deletes as before', async () => {
      const saved = [];
      let deleted = 0;
      const root = h('aside', { class: 'worklog-editor hidden' });
      openWorklogEditor(root, { worklog, baseUrl: '', timer: fakeTimer(), onSave: async (changes) => { saved.push(changes); }, onDelete: async () => { deleted++; }, onClose: () => {} });
      const comment = root.querySelector('#worklogEditComment');
      comment.value = 'Docs, reviewed';
      comment.dispatchEvent({ type: 'input' });
      root.querySelector('.editor-form').dispatchEvent({ type: 'submit' });
      await flush();
      assert.deepEqual(saved, [{ comment: 'Docs, reviewed' }]);

      const again = h('aside', { class: 'worklog-editor hidden' });
      openWorklogEditor(again, { worklog, baseUrl: '', timer: fakeTimer(), onSave: async () => {}, onDelete: async () => { deleted++; }, onClose: () => {} });
      again.querySelector('[data-action="delete"]').click();
      again.querySelector('[data-action="confirm-delete"]').click();
      await flush();
      assert.equal(deleted, 1);
    });

    it('keeps the pending worklog panel without a timer button too', () => {
      const root = h('aside', { class: 'worklog-editor hidden' });
      openWorklogEditor(root, { mode: 'pending', worklog: { ...worklog, id: 'p1' }, baseUrl: '', timer: fakeTimer(), onSave: async () => {}, onClose: () => {} });
      assert.deepEqual(footerOf(root), ['editor-actions-spacer', 'cancel', 'save']);
      assert.equal(timerButton(root), null);
    });
  });

  describe('through the page\'s timer', () => {
    /** The panel's timer options as options.js builds them, on a real timer controller. */
    function pageTimerOptions(page) {
      const timed = (i) => ({ site: SITE, issueId: i.issueId, issueKey: i.issueKey, issueSummary: i.issueSummary });
      return {
        stateOf(i) {
          const { tracking } = page.controller.getState();
          if (!tracking) return null;
          return { running: Boolean(tracking.running) && tracking.running.issueKey === i.issueKey };
        },
        onStart: (i) => page.controller.start(timed(i)),
        onStop: () => page.controller.stop()
      };
    }

    it('switches from another running issue: that session becomes pending, and nothing goes to Jira', async () => {
      const page = await createTimerPage();
      await page.controller.start({ site: SITE, issueId: '10012', issueKey: 'KAN-12' });
      page.advance(60_000);
      const { root } = openLogWork({ timer: pageTimerOptions(page) });

      timerButton(root).click();
      await flush();

      const { running, pending } = page.controller.getState().tracking;
      assert.deepEqual([running.site, running.issueId, running.issueKey], [SITE, '10020', 'KAN-20']);
      assert.deepEqual(pending.map((p) => p.issueKey), ['KAN-12']);
      assert.deepEqual(page.jiraCalls, []);
    });

    it('stops the issue\'s timer into a pending worklog', async () => {
      const page = await createTimerPage();
      await page.controller.start({ site: SITE, issueId: '10020', issueKey: 'KAN-20' });
      page.advance(90_000);
      const { root, closed } = openLogWork({ timer: pageTimerOptions(page) });
      assert.equal(timerButton(root).getAttribute('aria-label'), 'Stop timer');

      timerButton(root).click();
      await flush();

      const { running, pending } = page.controller.getState().tracking;
      assert.equal(running, null);
      assert.deepEqual(pending.map((p) => [p.issueKey, p.timeSpentSeconds]), [['KAN-20', 90]]);
      assert.deepEqual(closed, ['closed']);
      assert.deepEqual(page.jiraCalls, []);
    });

    it('starts a new session for an issue with a pending worklog, offering plain Start timer', async () => {
      const page = await createTimerPage();
      await page.controller.start({ site: SITE, issueId: '10020', issueKey: 'KAN-20' });
      page.advance(60_000);
      await page.controller.stop();
      const { root, closed } = openLogWork({ timer: pageTimerOptions(page) });
      assert.equal(timerButton(root).getAttribute('title'), 'Start timer');

      timerButton(root).click();
      await flush();

      const { running, pending } = page.controller.getState().tracking;
      assert.equal(running.issueKey, 'KAN-20');
      assert.equal(pending.length, 1, 'the earlier session stays pending');
      assert.deepEqual(page.errors, []);
      assert.deepEqual(closed, ['closed']);
    });
  });
});

describe('Pending worklog management - Jira stays out of it', () => {
  it('the pending modules and page functions call no Jira worklog API', () => {
    for (const file of ['../src/ui/pendingWorklogs.js', '../src/timer/timerController.js', '../src/timer/timeTrackingStore.js']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /from\s+['"][^'"]*(jira\/|weeklyWorklogService)/, file);
    }
    // options.js wires the page; its pending functions must not reach Jira either.
    const page = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
    for (const name of ['startEditPending', 'confirmDiscardPending', 'logWorkTimerOptions', 'pendingOptions']) {
      const start = page.indexOf(`function ${name}(`);
      assert.ok(start >= 0, `${name} exists`);
      const body = page.slice(start, page.indexOf('\n}\n', start));
      // Calls only: the page's confirmation <dialog> is itself named deleteWorklogDialog.
      assert.doesNotMatch(body, /logWork\(|saveWorklogChanges\(|deleteWorklog\(|deleteWorklogAndRefresh|createWorklog\(|updateWorklog\(|client\./, name);
    }
  });
});

describe('Pending tab - Submit', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  const NOW = T0 + 10 * 3_600_000;
  const rowOf = (list, id) => list.querySelector(`[data-pending-id="${id}"]`);
  function list(entries, extra = {}) {
    const calls = { submitted: [], edited: [], discarded: [] };
    const el = renderPendingWorklogs({
      entries, site: SITE, now: NOW,
      onSubmit: (id) => calls.submitted.push(id), onEdit: (id) => calls.edited.push(id), onDiscard: (id) => calls.discarded.push(id),
      ...extra
    });
    return { el, calls };
  }

  it('puts Submit beside Edit and Discard, labelled for its worklog', () => {
    const { el, calls } = list([ENTRIES[0]]);
    const row = rowOf(el, 'p1');
    const time = new Date(T0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    assert.deepEqual(row.querySelector('.worklog-actions').childNodes.map((b) => b.className), ['pending-submit-btn', 'pending-edit-btn', 'pending-discard-btn']);
    const submit = row.querySelector('.pending-submit-btn');
    assert.equal(submit.getAttribute('aria-label'), `Submit pending worklog for KAN-20, started ${time}, to Jira`);
    assert.equal(submit.getAttribute('title'), 'Submit to Jira');
    assert.equal(submit.getAttribute('aria-disabled'), null);
    submit.click();
    assert.deepEqual(calls.submitted, ['p1']);
    // Everything else on the row stays.
    assert.equal(row.querySelector('.pending-worklog-duration').textContent, '0h 25m');
    assert.equal(row.querySelector('.pending-worklog-summary').textContent, 'Write the docs');
  });

  it('marks Submit disabled, saying why, for a session under a minute or from another site', () => {
    const { el, calls } = list(ENTRIES);
    const short = rowOf(el, 'p2').querySelector('.pending-submit-btn');
    assert.equal(short.getAttribute('aria-disabled'), 'true');
    assert.match(short.getAttribute('title'), /at least 1 minute/);
    const other = rowOf(el, 'p3').querySelector('.pending-submit-btn');
    assert.equal(other.getAttribute('aria-disabled'), 'true');
    assert.match(other.getAttribute('title'), /Tracked on jira\.example\.com/);
    // The click still reaches the page, which says why nothing was sent.
    short.click();
    assert.deepEqual(calls.submitted, ['p2']);
  });

  it('shows a submission in progress, refused, or possibly in Jira', () => {
    const entries = [
      pendingEntry({ id: 's1', submission: { state: 'submitting', at: NOW - 5000 } }),
      pendingEntry({ id: 's2', issueKey: 'KAN-30', issueId: '10030', submission: { state: 'failed', at: NOW, message: 'No permission to log work.' } }),
      pendingEntry({ id: 's3', issueKey: 'KAN-31', issueId: '10031', submission: { state: 'uncertain', at: NOW } }),
      // Left running long ago (its page closed): possibly in Jira.
      pendingEntry({ id: 's4', issueKey: 'KAN-32', issueId: '10032', submission: { state: 'submitting', at: NOW - 3_600_000 } })
    ];
    const { el } = list(entries);
    const flag = (id) => rowOf(el, id).querySelectorAll('.pending-flag').at(-1);

    assert.equal(flag('s1').textContent, 'Submitting…');
    assert.equal(rowOf(el, 's1').querySelector('.pending-submit-btn').getAttribute('aria-disabled'), 'true');
    assert.equal(rowOf(el, 's1').querySelector('.pending-edit-btn').getAttribute('aria-disabled'), 'true');

    assert.equal(flag('s2').textContent, 'Not submitted');
    assert.equal(flag('s2').getAttribute('title'), 'No permission to log work.');
    assert.equal(rowOf(el, 's2').querySelector('.pending-submit-btn').getAttribute('aria-disabled'), null, 'it can be submitted again');

    for (const id of ['s3', 's4']) {
      assert.equal(flag(id).textContent, 'May be in Jira');
      assert.match(flag(id).getAttribute('title'), /checks Jira first/);
      assert.equal(rowOf(el, id).querySelector('.pending-submit-btn').getAttribute('title'), 'Check Jira and submit');
      assert.equal(rowOf(el, id).querySelector('.pending-edit-btn').getAttribute('aria-disabled'), 'true');
      assert.equal(rowOf(el, id).querySelector('.pending-discard-btn').getAttribute('aria-disabled'), null, 'it can always be discarded');
    }
  });

  it('updates the counts once a submission completes', async () => {
    const page = await createTimerPage();
    await page.controller.start({ site: SITE, issueId: '10020', issueKey: 'KAN-20', issueSummary: 'Write the docs' });
    page.advance(1_500_000);
    await page.controller.start({ site: SITE, issueId: '10021', issueKey: 'KAN-21' });
    page.advance(120_000);
    await page.controller.stop();
    const section = h('section', { id: 'workingIssues' });
    const draw = () => renderWorkingIssues(section, {
      state: READY, expanded: false,
      pending: { entries: page.controller.getState().tracking.pending, site: SITE, tab: 'pending', onEdit: () => {}, onDiscard: () => {} }
    });
    draw();
    assert.equal(section.querySelector('.working-issues-pending-count').textContent, '2 pending worklogs');

    const { submitPendingWorklog } = await import('../src/worklog/pendingSubmission.js');
    const client = {
      createWorklog: async (issue, worklog) => { page.jiraCalls.push(['createWorklog', issue]); return { id: '7', started: worklog.started.toISOString(), timeSpentSeconds: worklog.timeSpentSeconds }; }
    };
    const [first] = page.controller.getState().tracking.pending;
    const result = await submitPendingWorklog({ timer: page.controller, client, id: first.id, site: SITE });
    draw();

    assert.equal(result.status, 'submitted');
    assert.deepEqual(page.jiraCalls, [['createWorklog', '10020']]);
    assert.equal(section.querySelector('.working-issues-pending-count').textContent, '1 pending worklog');
    assert.equal(section.querySelector('#workingIssuesTab-pending').textContent, 'Pending (1)');
  });
});

describe('Pending tab - several sessions for one issue', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  /** KAN-1 twice and KAN-2 once, from the page's timer: sessions A, B, and C. */
  async function threeSessions() {
    const page = await createTimerPage();
    for (const [key, id, minutes] of [['KAN-1', '10001', 10], ['KAN-2', '10002', 5], ['KAN-1', '10001', 2]]) {
      await page.controller.start({ site: SITE, issueId: id, issueKey: key, issueSummary: `Work on ${key}` });
      page.advance(minutes * 60_000);
      await page.controller.stop();
    }
    return page;
  }
  const drawSection = (page, section = h('section', { id: 'workingIssues' })) => {
    renderWorkingIssues(section, {
      state: READY, expanded: false,
      pending: { entries: page.controller.getState().tracking.pending, site: SITE, tab: 'pending', onEdit: () => {}, onDiscard: () => {}, onSubmit: () => {} }
    });
    return section;
  };

  it('lists each session on its own row, keyed by its ID, and counts sessions', async () => {
    const page = await threeSessions();
    const [a, b, c] = page.controller.getState().tracking.pending;
    const section = drawSection(page);
    const rows = section.querySelectorAll('.pending-worklog');

    assert.deepEqual(rows.map((r) => r.dataset.pendingId), [c.id, b.id, a.id]);
    assert.deepEqual(rows.map((r) => r.querySelector('.issue-key-badge').textContent), ['KAN-1', 'KAN-2', 'KAN-1']);
    assert.deepEqual(rows.map((r) => r.querySelector('.pending-worklog-duration').textContent), ['0h 02m', '0h 05m', '0h 10m']);
    assert.equal(section.querySelector('#workingIssuesTab-pending').textContent, 'Pending (3)');
    assert.equal(section.querySelector('.working-issues-pending-count').textContent, '3 pending worklogs');
  });

  it('acts on the clicked session only: its buttons carry its ID', async () => {
    const page = await threeSessions();
    const [a, , c] = page.controller.getState().tracking.pending;
    const clicked = [];
    const section = h('section');
    renderWorkingIssues(section, {
      state: READY, expanded: true,
      pending: {
        entries: page.controller.getState().tracking.pending, site: SITE, tab: 'pending',
        onEdit: (id) => clicked.push(['edit', id]), onDiscard: (id) => clicked.push(['discard', id]), onSubmit: (id) => clicked.push(['submit', id])
      }
    });
    section.querySelector(`.pending-submit-btn[data-pending-id="${c.id}"]`).click();
    section.querySelector(`.pending-edit-btn[data-pending-id="${a.id}"]`).click();
    section.querySelector(`.pending-discard-btn[data-pending-id="${c.id}"]`).click();
    assert.deepEqual(clicked, [['submit', c.id], ['edit', a.id], ['discard', c.id]]);
  });

  it('updates the counts as sessions are edited, submitted, and discarded', async () => {
    const page = await threeSessions();
    const [a, b, c] = page.controller.getState().tracking.pending;
    const section = drawSection(page);

    await page.controller.updatePending(a.id, { comment: 'First pass' });
    drawSection(page, section);
    assert.equal(section.querySelector('#workingIssuesTab-pending').textContent, 'Pending (3)');

    const { submitPendingWorklog } = await import('../src/worklog/pendingSubmission.js');
    const client = { createWorklog: async (issue, worklog) => ({ id: '9', started: worklog.started.toISOString(), timeSpentSeconds: worklog.timeSpentSeconds }) };
    assert.equal((await submitPendingWorklog({ timer: page.controller, client, id: c.id, site: SITE })).status, 'submitted');
    drawSection(page, section);
    assert.deepEqual(page.controller.getState().tracking.pending.map((p) => p.id), [a.id, b.id], 'only the submitted KAN-1 session left');
    assert.equal(page.controller.getState().tracking.pending[0].comment, 'First pass');
    assert.equal(section.querySelector('.working-issues-pending-count').textContent, '2 pending worklogs');

    await page.controller.discardPending(b.id);
    drawSection(page, section);
    assert.equal(section.querySelector('#workingIssuesTab-pending').textContent, 'Pending (1)');
  });

  it('keeps every session when another tab adds and changes them', async () => {
    const storage = createMemoryStorageArea();
    let tail = Promise.resolve();
    const lock = { run(fn) { const r = tail.then(() => fn()); tail = r.catch(() => {}); return r; } };
    let clock = T0;
    const tab = () => createTimerController({
      createStore: () => createTimeTrackingStore(storage, { lock, now: () => clock }),
      watchStorage: (listener) => { storage.onChanged.addListener(listener); return () => storage.onChanged.removeListener(listener); },
      onChange: () => {}, onTick: () => {}, onError: () => {}, setInterval: () => 1, clearInterval: () => {}
    });
    const tabA = tab();
    const tabB = tab();
    await tabA.init();
    await tabB.init();

    for (let i = 0; i < 3; i++) {
      await tabA.start({ site: SITE, issueId: '10001', issueKey: 'KAN-1' });
      clock += 60_000;
      await tabA.stop();
    }
    const ids = tabA.getState().tracking.pending.map((p) => p.id);
    await tabA.updatePending(ids[1], { comment: 'Middle one' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(tabB.getState().tracking.pending.map((p) => [p.id, p.comment]), [[ids[0], ''], [ids[1], 'Middle one'], [ids[2], '']]);
  });
});
