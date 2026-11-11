import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import { renderWorkingIssues } from '../src/ui/weekView.js';
import { renderPendingWorklogs, formatSelectionSummary, pendingTabTotals } from '../src/ui/pendingWorklogs.js';
import { createPendingActionsMenu, placeMenu } from '../src/ui/pendingActionsMenu.js';
import {
  CLASSIFICATIONS, NOT_MOVED_REASONS, bulkActions, classifyPendingWorklogs, createPendingSelection, entriesIn, rowActions,
  settleBulkSelection, summarizeClassifications
} from '../src/worklog/pendingClassification.js';
import {
  createTimeTrackingStore, classificationOf, normalizeTimeTracking, siteId, TIME_TRACKING_KEY
} from '../src/timer/timeTrackingStore.js';
import { createTimerController } from '../src/timer/timerController.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';

const SITE = siteId('cloud', 'https://acme.atlassian.net');
const OTHER_SITE = siteId('server', 'https://jira.example.com');
const T0 = new Date(2026, 10, 9, 9, 15).getTime();
const HOUR = 3600;

const entry = (id, overrides = {}) => ({
  id, site: SITE, issueId: String(10000 + Number(id.replace(/\D/g, '') || 0)), issueKey: `KAN-${id.replace(/\D/g, '') || 1}`,
  issueSummary: `Work ${id}`, startedAt: T0, stoppedAt: T0 + 1_800_000, timeSpentSeconds: 1800, comment: '', ...overrides
});

// Two Pending worklogs of 10h 05m (20h 10m together), two On Hold (0h 55m together), and a Pending one
// tracked on another Jira site.
const ENTRIES = [
  entry('p1', { timeSpentSeconds: 10 * HOUR + 300, stoppedAt: T0 + (10 * HOUR + 300) * 1000 }),
  entry('p2', { timeSpentSeconds: 10 * HOUR + 300, stoppedAt: T0 + (10 * HOUR + 300) * 1000 }),
  entry('p3', { classification: 'on-hold', timeSpentSeconds: 2700, stoppedAt: T0 + 2_700_000 }),
  entry('p4', { classification: 'on-hold', timeSpentSeconds: 600, stoppedAt: T0 + 600_000 }),
  entry('p5', { site: OTHER_SITE, issueKey: 'OPS-5', timeSpentSeconds: 900, stoppedAt: T0 + 900_000 })
];

/** A lock that runs changes one after the other, like Web Locks across tabs. */
function serialLock() {
  let tail = Promise.resolve();
  return { run(fn) { const r = tail.then(() => fn()); tail = r.catch(() => {}); return r; } };
}

/** Storage holding these pending worklogs, counting writes. */
function seededStorage(pending = ENTRIES, running = null) {
  const storage = createMemoryStorageArea();
  const writes = [];
  const set = storage.set.bind(storage);
  storage.set = async (items) => { writes.push(items); return set(items); };
  storage.writes = writes;
  return set({ [TIME_TRACKING_KEY]: { version: 2, running, pending } }).then(() => storage);
}

const stored = async (storage) => (await storage.get(TIME_TRACKING_KEY))[TIME_TRACKING_KEY];

describe('Pending worklog classification - stored metadata', () => {
  it('reads every worklog without a classification as Pending (ID ready), and keeps On Hold', () => {
    const state = normalizeTimeTracking({ version: 2, running: null, pending: ENTRIES });
    assert.deepEqual(state.pending.map(classificationOf), ['ready', 'ready', 'on-hold', 'on-hold', 'ready']);
    // Ready is never stored: the field is absent.
    assert.equal('classification' in state.pending[0], false);
    assert.equal(state.pending[2].classification, 'on-hold');
  });

  it('reads an unknown, damaged, Archived, or explicit Ready classification as Pending, never dropping the worklog', () => {
    // 'archived' was a classification while 1.2.2 was developed, never released.
    const state = normalizeTimeTracking({
      version: 2, running: null,
      pending: [entry('a', { classification: 'snoozed' }), entry('b', { classification: 7 }), entry('c', { classification: 'ready' }), entry('d', { classification: null }),
        entry('e', { classification: 'archived' })]
    });
    assert.equal(state.pending.length, 5);
    assert.deepEqual(state.pending.map(classificationOf), ['ready', 'ready', 'ready', 'ready', 'ready']);
    assert.ok(state.pending.every((e) => !('classification' in e)));
  });

  it('reads version 1 pending worklogs as Ready', () => {
    const state = normalizeTimeTracking({ version: 1, running: null, pending: [entry('a')] });
    assert.equal(classificationOf(state.pending[0]), 'ready');
  });

  it('files one worklog in one write, changing nothing else about it, the others, or the running timer', async () => {
    const running = { id: 'r1', site: SITE, issueId: '1', issueKey: 'KAN-1', issueSummary: '', startedAt: T0, accumulatedMs: 0, resumedAt: T0 };
    const failed = entry('p9', { comment: 'Kept', submission: { state: 'failed', at: T0, message: 'No' } });
    const storage = await seededStorage([...ENTRIES, failed], running);
    const store = createTimeTrackingStore(storage, { lock: serialLock(), now: () => T0 + 5000 });
    const before = await stored(storage);

    const result = await store.classifyPending(['p9'], 'on-hold');

    assert.equal(storage.writes.length, 1);
    assert.deepEqual(result.classified.map((e) => e.id), ['p9']);
    assert.deepEqual(result.refused, []);
    const after = await stored(storage);
    assert.deepEqual(after.running, before.running);
    assert.deepEqual(after.pending.slice(0, 5), before.pending.slice(0, 5));
    assert.deepEqual(after.pending[5], { ...failed, classification: 'on-hold' });
  });

  it('removes the field when a worklog goes back to Pending', async () => {
    const storage = await seededStorage();
    const store = createTimeTrackingStore(storage, { lock: serialLock() });
    await store.classifyPending(['p3', 'p4'], 'ready');
    const after = await stored(storage);
    assert.ok(after.pending.every((e) => !('classification' in e)));
  });

  it('files several worklogs in a single write, leaving those already there as they are', async () => {
    const storage = await seededStorage();
    const store = createTimeTrackingStore(storage, { lock: serialLock() });

    const result = await store.classifyPending(['p1', 'p2', 'p3', 'p1'], 'on-hold');

    assert.equal(storage.writes.length, 1, 'one write for all of them');
    assert.deepEqual(result.classified.map((e) => e.id), ['p1', 'p2']);
    assert.deepEqual(result.unchanged.map((e) => e.id), ['p3']);
    assert.deepEqual((await stored(storage)).pending.map(classificationOf), ['on-hold', 'on-hold', 'on-hold', 'on-hold', 'ready']);
  });

  it('writes nothing when every worklog is already there', async () => {
    const storage = await seededStorage();
    const store = createTimeTrackingStore(storage, { lock: serialLock() });
    const result = await store.classifyPending(['p3'], 'on-hold');
    assert.equal(storage.writes.length, 0);
    assert.deepEqual(result.unchanged.map((e) => e.id), ['p3']);
  });

  it('refuses a worklog that is gone or being submitted, and still files the others', async () => {
    const submitting = entry('p6', { submission: { state: 'submitting', at: T0 } });
    const storage = await seededStorage([...ENTRIES, submitting]);
    const store = createTimeTrackingStore(storage, { lock: serialLock(), now: () => T0 + 1000 });

    const result = await store.classifyPending(['p1', 'gone', 'p6'], 'on-hold');

    assert.deepEqual(result.classified.map((e) => e.id), ['p1']);
    assert.deepEqual(result.refused, [
      { id: 'gone', code: 'PENDING_NOT_FOUND' },
      { id: 'p6', code: 'SUBMISSION_IN_PROGRESS', issueKey: 'KAN-6' }
    ]);
    const after = await stored(storage);
    assert.equal(classificationOf(after.pending.find((e) => e.id === 'p1')), 'on-hold');
    assert.equal(classificationOf(after.pending.find((e) => e.id === 'p6')), 'ready');
  });

  it('refuses no IDs or an unknown classification without writing', async () => {
    const storage = await seededStorage();
    const store = createTimeTrackingStore(storage, { lock: serialLock() });
    for (const [ids, to] of [[[], 'on-hold'], [['p1'], 'deleted'], [['p1'], 'archived'], ['p1', 'on-hold'], [[''], 'ready']]) {
      await assert.rejects(store.classifyPending(ids, to), { code: 'INVALID_CLASSIFICATION' });
    }
    assert.equal(storage.writes.length, 0);
  });

  it('changes nothing when the write fails', async () => {
    const storage = await seededStorage();
    storage.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
    const store = createTimeTrackingStore(storage, { lock: serialLock() });
    await assert.rejects(store.classifyPending(['p1', 'p2'], 'on-hold'), /quota/);
    assert.deepEqual((await stored(storage)).pending.map(classificationOf), ['ready', 'ready', 'on-hold', 'on-hold', 'ready']);
  });

  it('keeps the classification through an edit and a failed submission, and drops it with the worklog once submitted', async () => {
    let clock = T0 + 10_000;
    const storage = await seededStorage();
    const store = createTimeTrackingStore(storage, { lock: serialLock(), now: () => clock });

    await store.updatePending('p3', { comment: 'Waiting on the client' });
    assert.equal(classificationOf((await store.load()).pending[2]), 'on-hold');
    await store.beginSubmission('p3', { site: SITE });
    await store.failSubmission('p3', { uncertain: false, message: 'Refused' });
    assert.equal(classificationOf((await store.load()).pending[2]), 'on-hold');
    clock += 1000;
    await store.beginSubmission('p3', { site: SITE });
    await store.completeSubmission('p3');
    assert.equal((await store.load()).pending.some((e) => e.id === 'p3'), false);
  });

  it('is read back by a new page, and followed by another tab without that tab writing', async () => {
    const storage = await seededStorage();
    const lock = serialLock();
    const watch = (listener) => { storage.onChanged.addListener(listener); return () => storage.onChanged.removeListener(listener); };
    const makePage = () => {
      const changes = [];
      const controller = createTimerController({
        createStore: () => createTimeTrackingStore(storage, { lock }),
        watchStorage: watch, onChange: (state) => changes.push(state), onTick: () => {}, onError: () => {},
        setInterval: () => 1, clearInterval: () => {}
      });
      return { controller, changes };
    };
    const tabA = makePage();
    const tabB = makePage();
    await tabA.controller.init();
    await tabB.controller.init();

    await tabA.controller.classifyPending(['p1', 'p5'], 'on-hold');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(storage.writes.length, 1, 'only tab A wrote');
    const seen = tabB.controller.getState().tracking.pending;
    assert.deepEqual(summarizeClassifications(seen)['on-hold'], { count: 4, seconds: 10 * HOUR + 300 + 2700 + 600 + 900 });

    const fresh = createTimeTrackingStore(storage, { lock });
    assert.deepEqual((await fresh.load()).pending.map(classificationOf), ['on-hold', 'ready', 'on-hold', 'on-hold', 'on-hold']);
  });

  it('rejects through the controller with a user-facing message, keeping the stored state', async () => {
    const storage = await seededStorage();
    storage.set = async () => { throw new Error('IO error'); };
    const errors = [];
    const controller = createTimerController({
      createStore: () => createTimeTrackingStore(storage, { lock: serialLock() }),
      watchStorage: () => () => {}, onChange: () => {}, onTick: () => {}, onError: (m) => errors.push(m),
      setInterval: () => 1, clearInterval: () => {}, logError: () => {}
    });
    await controller.init();
    await assert.rejects(controller.classifyPending(['p1'], 'on-hold'), /Couldn't save the timer/);
    assert.deepEqual(errors, [], 'the caller says it, not a second toast');
    assert.equal(classificationOf(controller.getState().tracking.pending[0]), 'ready');
  });
});

describe('Pending worklog classification - tabs, actions, and selection', () => {
  it('counts and totals each classification, adding up to every pending worklog', () => {
    const summary = summarizeClassifications(ENTRIES);
    assert.deepEqual(summary, {
      ready: { count: 3, seconds: 2 * (10 * HOUR + 300) + 900 },
      'on-hold': { count: 2, seconds: 2700 + 600 }
    });
    assert.deepEqual(summarizeClassifications([]), { ready: { count: 0, seconds: 0 }, 'on-hold': { count: 0, seconds: 0 } });
    assert.deepEqual(entriesIn(ENTRIES, 'ready').map((e) => e.id), ['p1', 'p2', 'p5']);
  });

  it('offers every classification but the row\'s own in its menu', () => {
    const actions = (c) => rowActions(c).map((a) => a.action);
    assert.deepEqual(actions('ready'), ['Put On Hold']);
    assert.deepEqual(actions('on-hold'), ['Mark as Pending']);
    assert.deepEqual(CLASSIFICATIONS.map((c) => c.label), ['Pending', 'On Hold']);
  });

  it('offers no bulk action without a selection, and none the selected worklogs are all under already', () => {
    const labels = (selected) => bulkActions(selected).map((a) => a.bulkAction);
    assert.deepEqual(labels([]), []);
    assert.deepEqual(labels([ENTRIES[0], ENTRIES[1]]), ['On Hold']);
    assert.deepEqual(labels([ENTRIES[2], ENTRIES[3]]), ['Pending']);
    // A mix (never within one tab, but the rule holds): every destination moves at least one.
    assert.deepEqual(labels([ENTRIES[0], ENTRIES[2]]), ['Pending', 'On Hold']);
  });

  it('starts on a remembered tab, or Ready, with selection mode off', () => {
    assert.equal(createPendingSelection('on-hold').tab, 'on-hold');
    assert.equal(createPendingSelection('archived').tab, 'ready', 'a tab remembered from before Archived was removed');
    assert.equal(createPendingSelection(null).tab, 'ready');
    assert.equal(createPendingSelection('bogus').tab, 'ready');
    const selection = createPendingSelection();
    assert.equal(selection.selecting, false);
    assert.equal(selection.toggle('p1', ENTRIES), false, 'nothing is selected outside selection mode');
  });

  it('selects all of the tab\'s worklogs from the stored entries, including ones from another site', () => {
    const selection = createPendingSelection('ready');
    selection.setSelecting(true);
    selection.selectAll(ENTRIES);
    assert.deepEqual(selection.selectedIds(), ['p1', 'p2', 'p5']);
    selection.deselectAll();
    assert.equal(selection.size, 0);
  });

  it('selects and deselects one at a time, only within the selected tab', () => {
    const selection = createPendingSelection('ready');
    selection.setSelecting(true);
    assert.equal(selection.toggle('p2', ENTRIES), true);
    assert.equal(selection.toggle('p3', ENTRIES), false, 'On Hold\'s worklog');
    assert.equal(selection.toggle('gone', ENTRIES), false);
    assert.deepEqual(selection.selectedIds(), ['p2']);
    selection.toggle('p1', ENTRIES);
    selection.toggle('p2', ENTRIES);
    assert.deepEqual(selection.selectedIds(), ['p1']);
  });

  it('never carries a selection to another tab', () => {
    const selection = createPendingSelection('ready');
    selection.setSelecting(true);
    selection.selectAll(ENTRIES);
    assert.equal(selection.selectTab('on-hold'), true);
    assert.equal(selection.size, 0);
    assert.equal(selection.selecting, true, 'selection mode stays on');
    selection.selectAll(ENTRIES);
    assert.deepEqual(selection.selectedIds(), ['p3', 'p4']);
    assert.equal(selection.selectTab('on-hold'), false, 'the same tab keeps it');
    assert.deepEqual(selection.selectedIds(), ['p3', 'p4']);
    assert.equal(selection.selectTab('nonsense'), false);
    assert.equal(selection.selectTab('archived'), false, 'no Archived tab any more');
  });

  it('drops worklogs that left the tab, and clears everything when selection mode ends', () => {
    const selection = createPendingSelection('ready');
    selection.setSelecting(true);
    selection.selectAll(ENTRIES);
    const moved = ENTRIES.map((e) => (e.id === 'p2' ? { ...e, classification: 'on-hold' } : e)).filter((e) => e.id !== 'p5');
    assert.equal(selection.reconcile(moved), true);
    assert.deepEqual(selection.selectedIds(), ['p1']);
    assert.equal(selection.reconcile(moved), false);
    selection.setSelecting(false);
    assert.equal(selection.size, 0);
    selection.selectAll(ENTRIES);
    assert.equal(selection.size, 0, 'Select all needs selection mode');
  });
});

describe('Pending worklog classification - running a change', () => {
  const run = (result, ids, to = 'on-hold') => classifyPendingWorklogs({
    classify: async (...args) => {
      run.calls.push(args);
      if (result instanceof Error) throw result;
      return result;
    },
    entries: ENTRIES, ids, to
  });
  run.calls = [];

  it('reports one worklog moved by its issue key, and several by their number', async () => {
    const one = await run({ classified: [ENTRIES[0]], unchanged: [], refused: [] }, ['p1']);
    assert.deepEqual({ status: one.status, keep: one.keep, message: one.message }, { status: 'done', keep: [], message: 'Moved KAN-1 to On Hold' });
    const many = await run({ classified: [ENTRIES[2], ENTRIES[3]], unchanged: [], refused: [] }, ['p3', 'p4'], 'ready');
    assert.equal(many.message, 'Moved 2 worklogs to Pending');
    assert.deepEqual(run.calls.at(-1), [['p3', 'p4'], 'ready']);
  });

  it('reports a partial change as such, keeping the worklogs that weren\'t moved but still exist', async () => {
    const outcome = await run({
      classified: [ENTRIES[0]], unchanged: [],
      refused: [{ id: 'p2', code: 'SUBMISSION_IN_PROGRESS', issueKey: 'KAN-2' }, { id: 'p5', code: 'PENDING_NOT_FOUND' }]
    }, ['p1', 'p2', 'p5']);
    assert.equal(outcome.status, 'partial');
    assert.deepEqual(outcome.keep, ['p2']);
    assert.equal(outcome.message, 'Moved 1 of 3 worklogs to On Hold');
    // Named by issue key: the one kept (and why it stays selected), and the one that's gone.
    assert.equal(outcome.detail, 'KAN-2 is being submitted to Jira, so it stays selected. OPS-5 is no longer pending (submitted or discarded in another tab).');
    assert.deepEqual(outcome.failures, [{ id: 'p2', issueKey: 'KAN-2', reason: NOT_MOVED_REASONS.SUBMISSION_IN_PROGRESS }]);
  });

  it('names a few refused worklogs, then counts the rest', async () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
    const refused = ids.slice(1).map((id, i) => ({ id, code: 'SUBMISSION_IN_PROGRESS', issueKey: `KAN-${i + 2}` }));
    const outcome = await run({ classified: [ENTRIES[0]], unchanged: [], refused }, ids);
    assert.equal(outcome.detail, 'KAN-2, KAN-3, KAN-4, KAN-5, and 2 more are being submitted to Jira, so they stay selected.');
    assert.equal(outcome.failures.length, 6);
  });

  it('reports a failure, never success, when every worklog was refused', async () => {
    const outcome = await run({ classified: [], unchanged: [], refused: [{ id: 'p1', code: 'SUBMISSION_IN_PROGRESS', issueKey: 'KAN-1' }] }, ['p1']);
    assert.equal(outcome.status, 'failed');
    assert.deepEqual(outcome.keep, ['p1']);
    assert.equal(outcome.message, "Couldn't move KAN-1 to On Hold");
    assert.equal(outcome.detail, "It's being submitted to Jira. Try again once that's done.");
  });

  it('keeps the whole selection when nothing could be saved', async () => {
    const outcome = await run(new Error("Couldn't save the timer in the browser's storage, so nothing changed. Try again in a moment."), ['p1', 'p2']);
    assert.equal(outcome.status, 'failed');
    assert.deepEqual(outcome.keep, ['p1', 'p2']);
    assert.equal(outcome.message, "Couldn't move 2 worklogs to On Hold");
    assert.match(outcome.detail, /nothing changed/);
    assert.deepEqual(outcome.failures.map((f) => [f.issueKey, f.reason]), [['KAN-1', NOT_MOVED_REASONS.STORAGE], ['KAN-2', NOT_MOVED_REASONS.STORAGE]]);
  });

  it('closes selection mode after a complete change, and keeps it with the leftovers otherwise', () => {
    const selection = createPendingSelection('ready');
    selection.setSelecting(true);
    selection.selectAll(ENTRIES);
    assert.equal(settleBulkSelection(selection, { status: 'done', keep: [], failures: [], message: 'Moved 3 worklogs to On Hold', detail: '' }), null);
    assert.deepEqual([selection.selecting, selection.size, selection.tab], [false, 0, 'ready']);

    selection.setSelecting(true);
    selection.selectAll(ENTRIES);
    const failures = [{ id: 'p2', issueKey: 'KAN-2', reason: 'Not moved: busy' }];
    const left = settleBulkSelection(selection, { status: 'partial', keep: ['p2'], failures, message: 'Moved 2 of 3 worklogs to On Hold', detail: 'KAN-2 is being submitted to Jira, so it stays selected.' });
    assert.deepEqual(left, { items: failures, notice: 'Moved 2 of 3 worklogs to On Hold. KAN-2 is being submitted to Jira, so it stays selected.' });
    assert.deepEqual([selection.selecting, selection.selectedIds(), selection.tab], [true, ['p2'], 'ready']);

    settleBulkSelection(selection, { status: 'failed', keep: ['p2'], failures, message: 'x', detail: 'y' });
    assert.deepEqual([selection.selecting, selection.selectedIds()], [true, ['p2']]);
  });
});

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function sectionOptions({ entries = ENTRIES, tab, selection, onMenu } = {}) {
  const calls = { tabs: [], menus: [], toggled: [], mode: 0, all: 0, none: 0, classified: [], edited: [], discarded: [], submitted: [] };
  return {
    calls,
    options: {
      state: { status: 'ready', issues: [] },
      expanded: true,
      baseUrl: 'https://acme.atlassian.net',
      pending: {
        entries, site: SITE, now: T0 + 5000, tab,
        onEdit: (id) => calls.edited.push(id),
        onDiscard: (id) => calls.discarded.push(id),
        onSubmit: (id) => calls.submitted.push(id),
        onSelectTab: (t) => calls.tabs.push(t),
        onMenu: onMenu ?? ((id) => calls.menus.push(id)),
        selection: {
          active: false, ids: [],
          onToggleMode: () => calls.mode++,
          onToggle: (id) => calls.toggled.push(id),
          onSelectAll: () => calls.all++,
          onDeselectAll: () => calls.none++,
          onClassify: (to) => calls.classified.push(to),
          ...selection
        }
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

const pendingGroup = (section) => section.querySelector('#workingIssuesGroup-pending');
const pendingHeader = (section) => section.querySelector('#workingIssuesGroupToggle-pending');
const rowIds = (section) => pendingGroup(section).querySelectorAll('.pending-worklog').map((r) => r.dataset.pendingId);
const tabTexts = (section) => pendingGroup(section).querySelectorAll('.pending-tab').map((t) => t.textContent);

describe('Pending Worklogs - classification tabs', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  it('shows Pending and On Hold with their counts, Pending selected by default, listing only its worklogs', () => {
    const { section } = render();
    assert.deepEqual(tabTexts(section), ['Pending (3)', 'On Hold (2)']);
    const tabs = pendingGroup(section).querySelectorAll('.pending-tab');
    assert.deepEqual(tabs.map((t) => [t.getAttribute('aria-selected'), t.getAttribute('tabindex')]), [['true', '0'], ['false', '-1']]);
    assert.deepEqual(rowIds(section), ['p5', 'p2', 'p1']);
    assert.equal(pendingGroup(section).querySelector('[role="tabpanel"]').getAttribute('aria-labelledby'), 'pendingTab-ready');
    assert.equal(tabs[0].getAttribute('title'), 'Pending: 20h 25m');
  });

  it('shows worklogs stored as Ready, Archived, or before classifications, under Pending, keeping On Hold', () => {
    // As 1.2.1 stored them (no classification), as a Ready one could be written ('ready'), and
    // 'archived', a classification only while 1.2.2 was developed.
    const stored = normalizeTimeTracking({ version: 2, running: null, pending: [
      entry('p1'), entry('p2', { classification: 'ready' }), entry('p3', { classification: 'on-hold' }), entry('p4', { classification: 'archived' })
    ] }).pending;
    const { section } = render({ entries: stored });
    assert.deepEqual(tabTexts(section), ['Pending (3)', 'On Hold (1)']);
    assert.deepEqual(rowIds(section), ['p4', 'p2', 'p1']);
    assert.equal(pendingHeader(section).textContent, 'Worklogs · Pending (3)');
    // The worklogs themselves, times and comments included, are as stored.
    assert.deepEqual(stored.map(({ classification, ...rest }) => rest), [entry('p1'), entry('p2'), entry('p3'), entry('p4')]);
  });

  it('marks each tab with its classification, for its color, selected or not', () => {
    for (const tab of ['ready', 'on-hold']) {
      const tabs = pendingGroup(render({ tab }).section).querySelectorAll('.pending-tab');
      assert.deepEqual(tabs.map((t) => [t.dataset.classification, t.classList.contains(`is-${t.dataset.classification}`), t.classList.contains('is-selected')]),
        [['ready', true, tab === 'ready'], ['on-hold', true, tab === 'on-hold']]);
      // The view tabs' shape, so the size and spacing stay the same.
      assert.ok(tabs.every((t) => t.classList.contains('working-issues-view-tab')));
    }
  });

  it('names the selected tab in the header, in its color, with its count and total, expanded or collapsed', () => {
    const cases = [
      ['ready', ENTRIES, '3', 'Pending', '20h 25m'],
      ['on-hold', ENTRIES, '2', 'On Hold', '0h 55m'],
      ['on-hold', [ENTRIES[0]], '0', 'On Hold', '0h 00m'],
      ['ready', [ENTRIES[2]], '0', 'Pending', '0h 00m']
    ];
    for (const [tab, entries, count, label, total] of cases) {
      for (const groupsExpanded of [{ pending: true }, { pending: false }]) {
        const { calls, options } = sectionOptions({ entries, tab });
        const section = h('section', { id: 'workingIssues' });
        renderWorkingIssues(section, { ...options, groupsExpanded });
        const toggle = pendingHeader(section);
        const head = toggle.closest('.working-issues-group-header');
        // Chevron, clock, "Worklogs", then the dot, the tab's name, and its count together; the
        // total outside, at the right.
        assert.deepEqual(toggle.children.map((c) => c.getAttribute('class')), [
          'working-issues-group-chevron', 'working-issues-group-icon is-pending', 'working-issues-group-title',
          `working-issues-group-classification is-${tab}`]);
        assert.equal(toggle.querySelector('.working-issues-group-title').textContent, 'Worklogs');
        const name = toggle.querySelector('.working-issues-group-classification');
        assert.equal(name.querySelector('.working-issues-group-separator').getAttribute('aria-hidden'), 'true');
        assert.equal(name.textContent, ` · ${label} (${count})`);
        assert.equal(name.querySelector('.working-issues-group-classification-name').textContent, label);
        assert.equal(name.querySelector('.working-issues-group-count').textContent, `(${count})`, 'the count is inside the colored name');
        assert.equal(name.getAttribute('title'), `${label} (${count})`);
        const totalEl = head.querySelector('.working-issues-group-total');
        assert.equal(totalEl.textContent, total, 'the total alone, without the tab\'s name');
        assert.ok(head.childNodes.at(-1) === totalEl, 'last in the header');
        assert.equal(totalEl.classList.contains('is-empty'), count === '0');
        assert.equal(toggle.getAttribute('aria-expanded'), String(groupsExpanded.pending), JSON.stringify(calls.tabs));
      }
    }
  });

  it('follows the selected tab and its worklogs as they change', () => {
    const { section, options } = render();
    const read = () => [pendingHeader(section).textContent, section.querySelector('.working-issues-group-total').textContent];
    assert.deepEqual(read(), ['Worklogs · Pending (3)', '20h 25m']);
    renderWorkingIssues(section, { ...options, pending: { ...options.pending, tab: 'on-hold' } });
    assert.deepEqual(read(), ['Worklogs · On Hold (2)', '0h 55m']);
    // A worklog put on hold elsewhere, then one edited, then one submitted (gone).
    const moved = ENTRIES.map((e) => (e.id === 'p1' ? { ...e, classification: 'on-hold' } : e));
    renderWorkingIssues(section, { ...options, pending: { ...options.pending, tab: 'on-hold', entries: moved } });
    assert.deepEqual(read(), ['Worklogs · On Hold (3)', '11h 00m']);
    const edited = moved.map((e) => (e.id === 'p3' ? { ...e, timeSpentSeconds: 3600 } : e));
    renderWorkingIssues(section, { ...options, pending: { ...options.pending, tab: 'on-hold', entries: edited } });
    assert.deepEqual(read(), ['Worklogs · On Hold (3)', '11h 15m']);
    renderWorkingIssues(section, { ...options, pending: { ...options.pending, tab: 'on-hold', entries: edited.filter((e) => e.id !== 'p1') } });
    assert.deepEqual(read(), ['Worklogs · On Hold (2)', '1h 10m']);
  });

  it('colors the header\'s tab name like its tab, and keeps the header on one line, the total at the right', () => {
    const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
    // Pending (internal ID 'ready'): the selected view tabs' blue, in both themes.
    assert.match(css, /\.working-issues-group-classification\.is-ready \{\s*color: #58a6ff;/);
    assert.match(css, /\[data-theme="light"\] \.working-issues-group-classification\.is-ready \{\s*color: var\(--primary\);/);
    assert.match(css, /\.working-issues-group-classification\.is-on-hold \{\s*color: var\(--warning\);/);
    assert.doesNotMatch(css, /is-archived/, 'no Archived styles left');
    assert.match(css, /\.working-issues-group\.is-pending \.working-issues-group-header \{\s*flex-wrap: nowrap;/);
    // The tab's name gives way first, with an ellipsis, its count staying whole; the total never shrinks.
    assert.match(css, /\.working-issues-group-classification \{\s*display: contents;/);
    assert.match(css, /\.working-issues-group-classification \.working-issues-group-classification-name \{\s*flex: 0 1000 auto;\s*min-width: 2\.5em;/);
    assert.match(css, /\.working-issues-group-classification-name \{\s*min-width: 0;\s*overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap;/);
    assert.match(css, /\.working-issues-group-separator,\s*\.working-issues-group-count \{\s*flex: none;/);
    // The count takes the name's color and weight: no color or weight of its own.
    assert.doesNotMatch(css, /\.working-issues-group-count \{[^}]*(color|font-weight)/);
    assert.match(css, /\.working-issues-group-total \{\s*flex: none;/);
    // Only Pending Worklogs' header changes: Issues keeps its wrapping header.
    assert.doesNotMatch(css, /\.working-issues-group\.is-active \.working-issues-group-header/);
  });

  it('counts and totals the selected tab in the group header', () => {
    const ready = render().section;
    assert.equal(pendingHeader(ready).textContent, 'Worklogs · Pending (3)');
    assert.equal(ready.querySelector('.working-issues-group-total').textContent, '20h 25m');

    const onHold = render({ tab: 'on-hold' }).section;
    assert.equal(pendingHeader(onHold).textContent, 'Worklogs · On Hold (2)');
    assert.equal(onHold.querySelector('.working-issues-group-total').textContent, '0h 55m');
    assert.equal(onHold.querySelector('.working-issues-group-total').getAttribute('title'), 'Total time in On Hold: 0h 55m');
    assert.deepEqual(rowIds(onHold), ['p4', 'p3']);
    assert.deepEqual(pendingTabTotals(ENTRIES, 'on-hold'), { id: 'on-hold', label: 'On Hold', count: 2, seconds: 3300 });
    // A tab remembered from before Archived was removed shows Pending.
    assert.deepEqual(pendingTabTotals(ENTRIES, 'archived'), { id: 'ready', label: 'Pending', count: 3, seconds: 2 * (10 * HOUR + 300) + 900 });
  });

  it('says why a tab is empty, and that nothing is pending when nothing is', () => {
    const note = (section) => pendingGroup(section).querySelector('.working-issues-empty').textContent;
    const onlyReady = [ENTRIES[0]];
    assert.equal(note(render({ entries: onlyReady, tab: 'on-hold' }).section), 'Nothing is on hold.');
    assert.equal(note(render({ entries: [ENTRIES[3]], tab: 'ready' }).section), 'Nothing is pending.');
    for (const tab of ['ready', 'on-hold']) {
      const { section } = render({ entries: [], tab });
      assert.match(note(section), /^No pending worklogs\./);
      assert.equal(section.querySelector('.working-issues-group-total').classList.contains('is-empty'), true);
      assert.deepEqual(tabTexts(section), ['Pending (0)', 'On Hold (0)']);
    }
  });

  it('chooses a tab by click, arrow keys, Home, and End, focusing the new one', () => {
    const { section, calls } = render();
    pendingGroup(section).querySelector('#pendingTab-on-hold').click();
    pendingGroup(section).querySelector('#pendingTab-ready').click();
    const tablist = pendingGroup(section).querySelector('[role="tablist"]');
    tablist.dispatchEvent({ type: 'keydown', key: 'ArrowRight' });
    assert.ok(document.activeElement === pendingGroup(section).querySelector('#pendingTab-on-hold'), 'focus');
    // From Pending, Left wraps round to the last tab, On Hold; Home stays on Pending.
    tablist.dispatchEvent({ type: 'keydown', key: 'ArrowLeft' });
    assert.ok(document.activeElement === pendingGroup(section).querySelector('#pendingTab-on-hold'), 'wraps');
    tablist.dispatchEvent({ type: 'keydown', key: 'End' });
    tablist.dispatchEvent({ type: 'keydown', key: 'Home' });
    assert.deepEqual(calls.tabs, ['on-hold', 'on-hold', 'on-hold', 'on-hold']);
  });

  it('keeps the rows as they were outside selection mode: no checkbox, no selection bar, plus ⋯', () => {
    const { section } = render();
    const row = pendingGroup(section).querySelector('[data-pending-id="p1"]');
    assert.equal(pendingGroup(section).querySelector('.pending-select-checkbox'), null);
    assert.equal(pendingGroup(section).querySelector('.pending-selection-bar'), null);
    assert.equal(pendingGroup(section).querySelector('.pending-worklogs').classList.contains('is-selecting'), false);
    assert.deepEqual(row.children.map((c) => c.className), ['issue-key-badge', 'pending-worklog-main', 'pending-worklog-duration', 'worklog-actions']);
    assert.deepEqual(row.querySelector('.worklog-actions').children.map((c) => c.className),
      ['pending-submit-btn', 'pending-edit-btn', 'pending-discard-btn', 'pending-menu-btn']);
    const menu = row.querySelector('.pending-menu-btn');
    assert.equal(menu.getAttribute('aria-haspopup'), 'menu');
    assert.equal(menu.getAttribute('aria-expanded'), 'false');
    assert.equal(menu.getAttribute('aria-controls'), 'pendingActionsMenu');
    assert.match(menu.getAttribute('aria-label'), /^More actions for pending worklog for KAN-1, started /);
  });

  it('opens a row\'s menu from ⋯ without touching Submit, Edit, or Discard', () => {
    const { section, calls } = render();
    pendingGroup(section).querySelector('.pending-menu-btn[data-pending-id="p2"]').click();
    pendingGroup(section).querySelector('.pending-edit-btn[data-pending-id="p1"]').click();
    assert.deepEqual(calls.menus, ['p2']);
    assert.deepEqual(calls.edited, ['p1']);
    assert.deepEqual([calls.submitted, calls.discarded], [[], []]);
  });

  it('marks ⋯ unavailable while the worklog is being submitted', () => {
    const { section } = render({ entries: [entry('p1', { submission: { state: 'submitting', at: T0 } })] });
    const menu = pendingGroup(section).querySelector('.pending-menu-btn');
    assert.equal(menu.getAttribute('aria-disabled'), 'true');
    assert.equal(menu.getAttribute('title'), 'Being submitted to Jira…');
  });
});

describe('Pending Worklogs - selection mode and the bulk bar', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  it('has a quiet Select beside the tabs that turns selection mode on and off', () => {
    const off = render();
    const toggle = pendingGroup(off.section).querySelector('.pending-select-toggle');
    assert.equal(toggle.textContent, 'Select worklogs');
    assert.match(toggle.getAttribute('title'), /^Select Pending worklogs to move several at once$/);
    // A checked box, like the rows' checkboxes.
    assert.deepEqual(toggle.querySelector('svg').childNodes.map((n) => n.localName), ['rect', 'polyline']);
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    toggle.click();
    assert.equal(off.calls.mode, 1);
    assert.equal(off.calls.menus.length, 0);

    const on = render({ selection: { active: true } });
    const done = pendingGroup(on.section).querySelector('.pending-select-toggle');
    assert.equal(done.textContent, 'Done');
    assert.equal(done.getAttribute('aria-pressed'), 'true');
  });

  it('can\'t start selection mode on an empty tab', () => {
    const { section, calls } = render({ entries: [ENTRIES[0]], tab: 'on-hold' });
    const toggle = pendingGroup(section).querySelector('.pending-select-toggle');
    assert.equal(toggle.getAttribute('aria-disabled'), 'true');
    toggle.click();
    assert.equal(calls.mode, 0);
  });

  it('adds a checkbox to each of the tab\'s rows, checked for the selected ones', () => {
    const { section } = render({ selection: { active: true, ids: ['p2'] } });
    const boxes = pendingGroup(section).querySelectorAll('.pending-select-checkbox');
    assert.deepEqual(boxes.map((b) => [b.dataset.pendingId, b.hasAttribute('checked')]), [['p5', false], ['p2', true], ['p1', false]]);
    assert.match(boxes[1].getAttribute('aria-label'), /^Select pending worklog for KAN-2, started /);
    assert.ok(pendingGroup(section).querySelector('[data-pending-id="p2"]').classList.contains('is-selected'));
    assert.ok(pendingGroup(section).querySelector('.pending-worklogs').classList.contains('is-selecting'));
    // The checkbox comes first; the rest of the row is as before.
    assert.deepEqual(pendingGroup(section).querySelector('[data-pending-id="p1"]').children.map((c) => c.className),
      ['pending-select-checkbox', 'issue-key-badge', 'pending-worklog-main', 'pending-worklog-duration', 'worklog-actions']);
  });

  it('toggles a worklog from its checkbox or the row, but not from its link or buttons', () => {
    const { section, calls } = render({ selection: { active: true } });
    const row = pendingGroup(section).querySelector('[data-pending-id="p1"]');
    row.querySelector('.pending-select-checkbox').click();
    row.querySelector('.pending-worklog-summary').click();
    row.querySelector('.issue-key-badge').click();
    row.querySelector('.pending-edit-btn').click();
    assert.deepEqual(calls.toggled, ['p1', 'p1']);
    assert.deepEqual(calls.edited, ['p1']);
  });

  it('ignores a selection of another tab\'s worklogs', () => {
    const { section } = render({ selection: { active: true, ids: ['p3', 'p4'] } });
    assert.equal(pendingGroup(section).querySelector('.pending-bulk'), null);
    assert.equal(pendingGroup(section).querySelectorAll('.pending-worklog.is-selected').length, 0);
  });

  it('offers Select all (every worklog in the tab) and Deselect all, each only when it would change something', () => {
    const none = render({ selection: { active: true } });
    const bar = pendingGroup(none.section).querySelector('.pending-selection-bar');
    assert.equal(bar.querySelector('.pending-select-all').textContent, 'Select all (3)');
    assert.equal(bar.querySelector('.pending-select-all').getAttribute('aria-disabled'), null);
    assert.equal(bar.querySelector('.pending-deselect-all').getAttribute('aria-disabled'), 'true');
    assert.equal(bar.querySelector('.pending-bulk'), null, 'no bulk actions without a selection');
    bar.querySelector('.pending-select-all').click();
    bar.querySelector('.pending-deselect-all').click();
    assert.deepEqual([none.calls.all, none.calls.none], [1, 0]);

    const all = render({ selection: { active: true, ids: ['p1', 'p2', 'p5'] } });
    const allBar = pendingGroup(all.section).querySelector('.pending-selection-bar');
    assert.equal(allBar.querySelector('.pending-select-all').getAttribute('aria-disabled'), 'true');
    allBar.querySelector('.pending-select-all').click();
    allBar.querySelector('.pending-deselect-all').click();
    assert.deepEqual([all.calls.all, all.calls.none], [0, 1]);

    const empty = render({ entries: [ENTRIES[0]], tab: 'on-hold', selection: { active: true } });
    assert.equal(pendingGroup(empty.section).querySelector('.pending-select-all').getAttribute('aria-disabled'), 'true');
  });

  it('shows how many are selected and their time, and moves them anywhere but their own tab', () => {
    const { section, calls } = render({ selection: { active: true, ids: ['p1', 'p2'] } });
    const bulk = pendingGroup(section).querySelector('.pending-bulk');
    assert.equal(bulk.querySelector('.pending-bulk-summary').textContent, '2 selected · 20h 10m');
    const buttons = bulk.querySelectorAll('.pending-bulk-btn');
    assert.deepEqual(buttons.map((b) => b.textContent), ['On Hold']);
    assert.equal(buttons[0].getAttribute('aria-label'), 'Move 2 selected worklogs to On Hold');
    buttons[0].click();
    assert.deepEqual(calls.classified, ['on-hold']);

    const onHold = render({ tab: 'on-hold', selection: { active: true, ids: ['p4'] } });
    assert.deepEqual(pendingGroup(onHold.section).querySelectorAll('.pending-bulk-btn').map((b) => b.textContent), ['Pending']);
    assert.equal(pendingGroup(onHold.section).querySelector('.pending-bulk-summary').textContent, '1 selected · 0h 10m');
  });

  it('holds the bulk actions while a change is being saved', () => {
    const { section, calls } = render({ selection: { active: true, ids: ['p1'], busy: true } });
    const button = pendingGroup(section).querySelector('.pending-bulk-btn');
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    button.click();
    assert.deepEqual(calls.classified, []);
  });

  it('formats the summary like the totals', () => {
    assert.equal(formatSelectionSummary(2, 20 * HOUR + 600), '2 selected · 20h 10m');
    assert.equal(formatSelectionSummary(1, 45), '1 selected · 45s');
  });

  it('moves focus to the selected tab when the focused row or bulk action goes', () => {
    const { section, options } = render({ selection: { active: true, ids: ['p1'] } });
    pendingGroup(section).querySelector('.pending-menu-btn[data-pending-id="p1"]').focus();
    const moved = ENTRIES.map((e) => (e.id === 'p1' ? { ...e, classification: 'on-hold' } : e));
    renderWorkingIssues(section, { ...options, pending: { ...options.pending, entries: moved, selection: { ...options.pending.selection, ids: [] } } });
    assert.ok(document.activeElement === pendingGroup(section).querySelector('#pendingTab-ready'), 'the Ready tab');

    const again = render({ selection: { active: true, ids: ['p1'] } });
    pendingGroup(again.section).querySelector('.pending-bulk-btn').focus();
    renderWorkingIssues(again.section, { ...again.options, pending: { ...again.options.pending, entries: moved, selection: { ...again.options.pending.selection, ids: [] } } });
    assert.ok(document.activeElement === pendingGroup(again.section).querySelector('#pendingTab-ready'), 'the Ready tab');
  });

  it('works on its own, without the section', () => {
    const contents = renderPendingWorklogs({ entries: ENTRIES, site: SITE, onEdit: () => {}, onDiscard: () => {} });
    assert.equal(contents.querySelectorAll('.pending-worklog').length, 3);
    assert.equal(contents.querySelector('.pending-select-toggle'), null, 'no Select without selection options');
    assert.equal(contents.querySelector('.pending-menu-btn'), null, 'no ⋯ without onMenu');
  });
});

describe('Pending Worklogs - a row\'s ⋯ menu', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  function setup() {
    const body = h('body');
    const rows = h('div', {},
      h('button', { class: 'pending-menu-btn', 'data-pending-id': 'p1', 'aria-expanded': 'false' }),
      h('button', { class: 'outside' }));
    body.append(rows);
    const chosen = [];
    const menu = createPendingActionsMenu({
      container: body,
      findButton: (id) => rows.querySelector(`.pending-menu-btn[data-pending-id="${id}"]`)
    });
    const el = body.querySelector('#pendingActionsMenu');
    // The menu lists whatever it's given (a row offers rowActions(): one, now); two show its keyboard.
    const open = () => menu.open({ id: 'p1', label: 'Move the pending worklog for KAN-1', actions: CLASSIFICATIONS, onChoose: (c) => chosen.push(c) });
    return { body, rows, menu, el, chosen, open, button: () => rows.querySelector('.pending-menu-btn') };
  }

  it('opens with the row\'s actions, focus on the first, the button marked expanded', () => {
    const { menu, el, open, button } = setup();
    assert.ok(el.classList.contains('hidden'));
    open();
    assert.equal(el.getAttribute('role'), 'menu');
    assert.equal(el.getAttribute('aria-label'), 'Move the pending worklog for KAN-1');
    assert.deepEqual(el.querySelectorAll('[role="menuitem"]').map((i) => i.textContent), ['Mark as Pending', 'Put On Hold']);
    assert.ok(document.activeElement === el.querySelector('[role="menuitem"]'), 'first item');
    assert.equal(button().getAttribute('aria-expanded'), 'true');
    assert.equal(menu.openFor(), 'p1');
  });

  it('moves with the arrow keys, Home, and End, and closes with Escape, focus back on ⋯', () => {
    const { el, menu, open, button, chosen } = setup();
    open();
    const items = el.querySelectorAll('[role="menuitem"]');
    items[0].dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
    assert.ok(document.activeElement === items[1]);
    items[1].dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
    assert.ok(document.activeElement === items[0], 'wraps');
    items[0].dispatchEvent({ type: 'keydown', key: 'End' });
    assert.ok(document.activeElement === items[1]);
    items[1].dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(menu.isOpen(), false);
    assert.ok(el.classList.contains('hidden'));
    assert.ok(document.activeElement === button(), 'back on ⋯');
    assert.equal(button().getAttribute('aria-expanded'), 'false');
    assert.deepEqual(chosen, []);
  });

  it('chooses an action: closes, focus back on ⋯, then reports it', () => {
    const { el, menu, open, button, chosen } = setup();
    open();
    el.querySelectorAll('[role="menuitem"]')[1].click();
    assert.deepEqual(chosen, ['on-hold']);
    assert.equal(menu.isOpen(), false);
    assert.ok(document.activeElement === button());
  });

  it('closes on a click outside it, but not on its own button', () => {
    const { rows, menu, open, button } = setup();
    open();
    button().dispatchEvent({ type: 'pointerdown' });
    assert.equal(menu.isOpen(), true);
    rows.querySelector('.outside').dispatchEvent({ type: 'pointerdown' });
    assert.equal(menu.isOpen(), false);
  });

  it('follows the row\'s new ⋯ when My Work is drawn again, and closes once the row is gone', () => {
    const { rows, menu, open } = setup();
    open();
    // Drawn again: a new button for the same row.
    const fresh = h('button', { class: 'pending-menu-btn', 'data-pending-id': 'p1', 'aria-expanded': 'false' });
    rows.replaceChildren(fresh);
    menu.sync();
    assert.equal(menu.isOpen(), true);
    assert.equal(fresh.getAttribute('aria-expanded'), 'true');
    // Moved to another tab: no button.
    rows.replaceChildren();
    menu.sync();
    assert.equal(menu.isOpen(), false);
  });

  it('places itself under the button, right-aligned, or above it, inside the window', () => {
    const viewport = { width: 800, height: 600 };
    assert.deepEqual(placeMenu({ left: 700, right: 724, top: 100, bottom: 124 }, { width: 170, height: 80 }, viewport), { left: 554, top: 128 });
    assert.deepEqual(placeMenu({ left: 700, right: 724, top: 560, bottom: 584 }, { width: 170, height: 80 }, viewport), { left: 554, top: 476 });
    assert.deepEqual(placeMenu({ left: 2, right: 26, top: 100, bottom: 124 }, { width: 170, height: 80 }, viewport), { left: 8, top: 128 });
  });
});

// ---------------------------------------------------------------------------------------------
// End to end: the page's flow (options.js) on in-memory storage, with a Jira client that records
// every call. Classifying must never reach it.
// ---------------------------------------------------------------------------------------------

describe('Pending Worklogs - classifying, end to end', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  async function createPage(pending = ENTRIES) {
    const storage = await seededStorage(pending);
    const controller = createTimerController({
      createStore: () => createTimeTrackingStore(storage, { lock: serialLock(), now: () => T0 + 10_000 }),
      watchStorage: () => () => {}, onChange: () => {}, onTick: () => {}, onError: () => {},
      setInterval: () => 1, clearInterval: () => {}, logError: () => {}
    });
    await controller.init();
    const jiraCalls = [];
    const selection = createPendingSelection('ready');
    const section = h('section', { id: 'workingIssues' });
    const toasts = [];
    const entries = () => controller.getState().tracking.pending;
    let notMoved = null;

    // As options.js's pendingOptions() and classifyPending().
    const draw = () => {
      selection.reconcile(entries());
      renderWorkingIssues(section, {
        state: { status: 'ready', issues: [] }, expanded: true, baseUrl: 'https://acme.atlassian.net',
        pending: {
          entries: entries(), site: SITE, now: T0 + 10_000, tab: selection.tab,
          onEdit: () => jiraCalls.push('edit'), onDiscard: () => jiraCalls.push('discard'), onSubmit: () => jiraCalls.push('submit'),
          onSelectTab: (tab) => { notMoved = null; selection.selectTab(tab); draw(); },
          onMenu: () => {},
          selection: {
            active: selection.selecting, ids: selection.selectedIds(),
            notMoved: notMoved?.items, notice: notMoved?.notice,
            onToggleMode: () => { notMoved = null; selection.setSelecting(!selection.selecting); draw(); },
            onToggle: (id) => { if (selection.toggle(id, entries())) { notMoved = null; draw(); } },
            onSelectAll: () => { notMoved = null; selection.selectAll(entries()); draw(); },
            onDeselectAll: () => { notMoved = null; selection.deselectAll(); draw(); },
            onClassify: (to) => classify(selection.selectedIds(), to, true)
          }
        }
      });
    };
    let pendingRun = Promise.resolve();
    const classify = (ids, to, bulk = false) => {
      pendingRun = (async () => {
        const outcome = await classifyPendingWorklogs({ classify: controller.classifyPending, entries: entries(), ids, to });
        if (bulk) notMoved = settleBulkSelection(selection, outcome);
        toasts.push(outcome);
        draw();
      })();
      return pendingRun;
    };
    draw();
    return { storage, controller, selection, section, draw, classify, settle: () => pendingRun, toasts, jiraCalls, entries };
  }

  const tabsOf = (section) => pendingGroup(section).querySelectorAll('.pending-tab').map((t) => t.textContent);
  const click = (section, selector) => pendingGroup(section).querySelector(selector).click();

  it('moves every selected worklog with Select all, updates every tab, closes selection mode, and persists it', async () => {
    const page = await createPage();
    click(page.section, '.pending-select-toggle');
    click(page.section, '.pending-select-all');
    assert.equal(pendingGroup(page.section).querySelector('.pending-bulk-summary').textContent, '3 selected · 20h 25m');

    click(page.section, '.pending-bulk-btn[data-classification="on-hold"]');
    await page.settle();

    assert.deepEqual(tabsOf(page.section), ['Pending (0)', 'On Hold (5)']);
    assert.equal(pendingHeader(page.section).textContent, 'Worklogs · Pending (0)');
    assert.equal(page.section.querySelector('.working-issues-group-total').textContent, '0h 00m');
    assert.deepEqual(rowIds(page.section), [], 'the moved worklogs leave the view');
    // Still on Pending, now empty, with its own note.
    assert.equal(pendingGroup(page.section).querySelector('.pending-tab.is-selected').id, 'pendingTab-ready');
    assert.equal(pendingGroup(page.section).querySelector('.working-issues-empty').textContent, 'Nothing is pending.');
    // Selection mode closed by itself: no Done needed.
    assert.equal(page.selection.selecting, false);
    assert.equal(page.selection.size, 0);
    assert.ok(pendingGroup(page.section).querySelector('.pending-selection-bar') === null, 'no selection bar');
    assert.equal(pendingGroup(page.section).querySelector('.pending-select-toggle').textContent, 'Select worklogs');
    assert.equal(page.toasts.at(-1).message, 'Moved 3 worklogs to On Hold');
    assert.equal(page.storage.writes.length, 1);
    assert.deepEqual((await stored(page.storage)).pending.map(classificationOf), ['on-hold', 'on-hold', 'on-hold', 'on-hold', 'on-hold']);
    assert.deepEqual(page.jiraCalls, []);

    click(page.section, '#pendingTab-on-hold');
    assert.equal(pendingHeader(page.section).textContent, 'Worklogs · On Hold (5)');
    assert.equal(page.section.querySelector('.working-issues-group-total').textContent, '21h 20m');
  });

  it('moves part of a tab, leaving the rest selected-free and counted where they are', async () => {
    const page = await createPage();
    click(page.section, '.pending-select-toggle');
    click(page.section, '.pending-select-checkbox[data-pending-id="p2"]');
    click(page.section, '.pending-select-checkbox[data-pending-id="p5"]');
    click(page.section, '.pending-select-checkbox[data-pending-id="p5"]');
    assert.equal(pendingGroup(page.section).querySelector('.pending-bulk-summary').textContent, '1 selected · 10h 05m');

    click(page.section, '.pending-bulk-btn[data-classification="on-hold"]');
    await page.settle();

    assert.deepEqual(tabsOf(page.section), ['Pending (2)', 'On Hold (3)']);
    assert.deepEqual(rowIds(page.section), ['p5', 'p1']);
    assert.equal(pendingHeader(page.section).textContent, 'Worklogs · Pending (2)');
    assert.equal(page.section.querySelector('.working-issues-group-total').textContent, '10h 20m');
    assert.equal(pendingGroup(page.section).querySelector('.pending-tab.is-selected').id, 'pendingTab-ready', 'stays on Pending');
    assert.equal(page.selection.size, 0);
    assert.equal(page.selection.selecting, false);
    assert.ok(pendingGroup(page.section).querySelector('.pending-select-checkbox') === null, 'the rows are back to normal');
  });

  it('keeps selection mode and the worklogs left selected, naming them, when only part of it could move', async () => {
    const submitting = entry('p6', { submission: { state: 'submitting', at: T0 + 9000 } });
    const page = await createPage([...ENTRIES, submitting]);
    click(page.section, '.pending-select-toggle');
    click(page.section, '.pending-select-all');
    assert.equal(page.selection.size, 4);

    click(page.section, '.pending-bulk-btn[data-classification="on-hold"]');
    await page.settle();

    const outcome = page.toasts.at(-1);
    assert.equal(outcome.status, 'partial');
    assert.equal(outcome.message, 'Moved 3 of 4 worklogs to On Hold');
    assert.deepEqual(page.selection.selectedIds(), ['p6'], 'the one that didn\'t move stays selected');
    assert.deepEqual(tabsOf(page.section), ['Pending (1)', 'On Hold (5)']);
    assert.equal(pendingHeader(page.section).textContent, 'Worklogs · Pending (1)');
    assert.equal(page.section.querySelector('.working-issues-group-total').textContent, '0h 30m');
    assert.equal(page.selection.selecting, true, 'selection mode stays, to try again');
    assert.equal(pendingGroup(page.section).querySelector('.pending-bulk-summary').textContent, '1 selected · 0h 30m');
    // The one left is named in the bar, and flagged on its row, which stays checked.
    const notice = pendingGroup(page.section).querySelector('.pending-selection-notice');
    assert.equal(notice.textContent, 'Moved 3 of 4 worklogs to On Hold. KAN-6 is being submitted to Jira, so it stays selected.');
    assert.equal(notice.getAttribute('role'), 'alert');
    const row = pendingGroup(page.section).querySelector('[data-pending-id="p6"]');
    assert.ok(row.classList.contains('is-not-moved'));
    assert.equal(row.querySelector('.pending-not-moved').textContent, 'Not moved');
    assert.equal(row.querySelector('.pending-not-moved').getAttribute('title'), NOT_MOVED_REASONS.SUBMISSION_IN_PROGRESS);
    assert.ok(row.querySelector('.pending-select-checkbox').hasAttribute('checked'));

    // The next selection change clears the note.
    click(page.section, '.pending-deselect-all');
    assert.ok(pendingGroup(page.section).querySelector('.pending-selection-notice') === null, 'no notice');
    assert.ok(pendingGroup(page.section).querySelector('.pending-not-moved') === null, 'no flag');
  });

  it('keeps the whole selection, and never reports success, when nothing could be saved', async () => {
    const page = await createPage();
    click(page.section, '.pending-select-toggle');
    click(page.section, '.pending-select-all');
    page.storage.set = async () => { throw new Error('IO error'); };

    click(page.section, '.pending-bulk-btn[data-classification="on-hold"]');
    await page.settle();

    assert.equal(page.toasts.at(-1).status, 'failed');
    assert.equal(page.selection.selecting, true);
    assert.deepEqual(page.selection.selectedIds(), ['p1', 'p2', 'p5']);
    assert.deepEqual(tabsOf(page.section), ['Pending (3)', 'On Hold (2)']);
    assert.equal(pendingGroup(page.section).querySelectorAll('.pending-not-moved').length, 3);
    assert.match(pendingGroup(page.section).querySelector('.pending-selection-notice').textContent, /^Couldn't move 3 worklogs to On Hold\./);
  });

  it('moves one worklog from its menu\'s action, outside selection mode', async () => {
    const page = await createPage();
    await page.classify(['p3'], 'ready');
    assert.deepEqual(tabsOf(page.section), ['Pending (4)', 'On Hold (1)']);
    assert.equal(page.toasts.at(-1).message, 'Moved KAN-3 to Pending');
    assert.deepEqual(rowIds(page.section), ['p5', 'p3', 'p2', 'p1']);
  });

  it('never carries a selection across tabs in the page', async () => {
    const page = await createPage();
    click(page.section, '.pending-select-toggle');
    click(page.section, '.pending-select-all');
    click(page.section, '#pendingTab-on-hold');
    assert.equal(page.selection.size, 0);
    assert.equal(pendingGroup(page.section).querySelector('.pending-bulk'), null);
    assert.equal(pendingGroup(page.section).querySelector('.pending-select-all').textContent, 'Select all (2)');
  });
});

describe('Pending Worklogs - page wiring and styles', () => {
  const options = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');

  it('remembers the selected tab in this browser, and never saves the selection', () => {
    assert.match(options, /createPendingSelection\(localStorage\.getItem\('jts-pending-classification'\)\)/);
    assert.match(options, /localStorage\.setItem\('jts-pending-classification', tab\)/);
    assert.doesNotMatch(options, /localStorage\.setItem\([^)]*selected/i);
  });

  it('classifies through the timer only, never through a Jira client', () => {
    const start = options.indexOf('async function classifyPending(');
    const fn = options.slice(start, options.indexOf('\n}\n', start));
    assert.match(fn, /classify: timer\.classifyPending/);
    assert.doesNotMatch(fn, /client|Jira\(/);
  });

  it('styles the checkbox column only in selection mode, and the menu as a fixed popup', () => {
    assert.match(css, /\.pending-worklogs\.is-selecting \.pending-worklog \{\s*grid-template-columns: auto auto minmax\(0, 1fr\) auto auto;/);
    assert.match(css, /\.pending-worklog \{\s*display: grid;\s*grid-template-columns: auto minmax\(0, 1fr\) auto auto;/);
    assert.match(css, /\.pending-actions-menu \{\s*position: fixed;/);
  });

  it('colors the tabs blue (Pending) and amber (On Hold) from the theme\'s own colors, subtly unselected and stronger selected', () => {
    assert.match(css, /\.pending-tabs \.pending-tab\.is-ready \{\s*\/\*[^*]*\*\/\s*--tab-color: #58a6ff;/);
    assert.match(css, /\[data-theme="light"\] \.pending-tabs \.pending-tab\.is-ready \{\s*--tab-color: var\(--primary\);/);
    assert.match(css, /\.pending-tabs \.pending-tab\.is-on-hold \{\s*--tab-color: var\(--warning\);/);
    const rule = (selector) => css.match(new RegExp(`${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
    const base = rule('.pending-tabs .pending-tab');
    assert.match(base, /color: var\(--tab-color\);/);
    assert.match(base, /background-color: color-mix\(in srgb, var\(--tab-color\) 5%, transparent\);/);
    assert.match(base, /border-color: color-mix\(in srgb, var\(--tab-color\) 28%, transparent\);/);
    const selected = rule('.pending-tabs .pending-tab.is-selected');
    assert.match(selected, /background-color: color-mix\(in srgb, var\(--tab-color\) 16%, transparent\);/);
    assert.match(selected, /border-color: var\(--tab-color\);/);
    // No size change: no padding, border width, or font size of their own.
    assert.doesNotMatch(base + selected, /padding|border-width|font-size|border:/);
    // After the view tabs' selected rules (light theme included), so they win.
    assert.ok(css.indexOf('.pending-tabs .pending-tab.is-selected {') > css.indexOf('[data-theme="light"] .working-issues-view-tab.is-selected {'));
  });

  it('closes selection mode after a complete bulk change through the shared rule', () => {
    const start = options.indexOf('async function classifyPending(');
    const fn = options.slice(start, options.indexOf('\n}\n', start));
    assert.match(fn, /if \(bulk\) pendingNotMoved = settleBulkSelection\(pendingSelection, outcome\);/);
  });
});
