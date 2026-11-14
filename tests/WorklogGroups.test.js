import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import { renderWorkingIssues } from '../src/ui/weekView.js';
import { pendingTabTotals } from '../src/ui/pendingWorklogs.js';
import { createPendingActionsMenu } from '../src/ui/pendingActionsMenu.js';
import { openWorklogGroupEditor, deleteGroupQuestion } from '../src/ui/worklogGroupEditor.js';
import {
  MAX_WORKLOG_GROUPS, groupNameProblem, isGroupId, newGroupId, normalizeSiteGroups, normalizeWorklogGroupsBySite, validateGroupDraft
} from '../src/worklog/worklogGroups.js';
import {
  bulkActions, classificationsFor, classifyPendingWorklogs, createPendingSelection, entriesIn, resolveClassification, rowActions,
  settleBulkSelection, summarizeClassifications
} from '../src/worklog/pendingClassification.js';
import {
  createTimeTrackingStore, classificationOf, normalizeTimeTracking, siteId, TIME_TRACKING_KEY
} from '../src/timer/timeTrackingStore.js';
import { createTimerController } from '../src/timer/timerController.js';
import { createSettingsStore, normalizeSettings, worklogGroupsForSite } from '../src/settings/settingsStore.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';

const SITE = siteId('cloud', 'https://acme.atlassian.net');
const OTHER_SITE = siteId('server', 'https://jira.example.com');
const T0 = new Date(2026, 10, 9, 9, 15).getTime();
const HOUR = 3600;

const XMAS = { id: 'group-xmas', name: 'Christmas Week' };
const OVERTIME = { id: 'group-overtime', name: 'Overtime' };
const GROUPS = [XMAS, OVERTIME];

const entry = (id, overrides = {}) => ({
  id, site: SITE, issueId: String(10000 + Number(id.replace(/\D/g, '') || 0)), issueKey: `KAN-${id.replace(/\D/g, '') || 1}`,
  issueSummary: `Work ${id}`, startedAt: T0, stoppedAt: T0 + 1_800_000, timeSpentSeconds: 1800, comment: '', ...overrides
});

// Pending: p1 (1h), p2 (30m). On Hold: p3 (30m). Christmas Week: p4 (2h), p5 (30m). Overtime: p6 (30m).
// p7 names a group that's gone (deleted, or another site's): it reads as On Hold.
const ENTRIES = [
  entry('p1', { timeSpentSeconds: HOUR, stoppedAt: T0 + HOUR * 1000 }),
  entry('p2'),
  entry('p3', { classification: 'on-hold' }),
  entry('p4', { classification: XMAS.id, timeSpentSeconds: 2 * HOUR, stoppedAt: T0 + 2 * HOUR * 1000 }),
  entry('p5', { classification: XMAS.id }),
  entry('p6', { classification: OVERTIME.id }),
  entry('p7', { classification: 'group-gone' })
];

function serialLock() {
  let tail = Promise.resolve();
  return { run(fn) { const r = tail.then(() => fn()); tail = r.catch(() => {}); return r; } };
}

async function seededStorage(pending = ENTRIES) {
  const storage = createMemoryStorageArea();
  const writes = [];
  const set = storage.set.bind(storage);
  storage.set = async (items) => { writes.push(items); return set(items); };
  storage.writes = writes;
  await set({ [TIME_TRACKING_KEY]: { version: 2, running: null, pending } });
  return storage;
}

const stored = async (storage) => (await storage.get(TIME_TRACKING_KEY))[TIME_TRACKING_KEY];
const filedAs = (state, id) => classificationOf(state.pending.find((e) => e.id === id));

describe('Worklog Queue groups - definitions', () => {
  it('makes and recognizes custom group IDs, never a built-in one', () => {
    assert.match(newGroupId('abc-123'), /^group-abc-123$/);
    assert.ok(isGroupId(newGroupId()));
    for (const value of ['ready', 'on-hold', 'archived', 'group-', 'group-a b', 7, null, undefined]) assert.equal(isGroupId(value), false, String(value));
  });

  it('refuses an empty, overlong, or built-in name, in any letter case', () => {
    assert.match(groupNameProblem('  '), /Enter a name/);
    assert.match(groupNameProblem('x'.repeat(31)), /at most 30/);
    assert.match(groupNameProblem('pending'), /"Pending" is a built-in group/);
    assert.match(groupNameProblem('ON HOLD'), /"On Hold" is a built-in group/);
    assert.equal(groupNameProblem(' Overtime '), '');
  });

  it('reads a site\'s groups, dropping malformed and repeated ones, and any past five', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `group-${i}`, name: `G${i}` }));
    assert.deepEqual(normalizeSiteGroups({ version: 1, groups: many }).groups.map((g) => g.id),
      ['group-0', 'group-1', 'group-2', 'group-3', 'group-4']);
    const read = normalizeSiteGroups({ version: 1, groups: [XMAS, { id: 'on-hold', name: 'X' }, { id: 'group-x', name: 'pending' }, { ...XMAS, name: 'Other' }, { id: 'group-y', name: 'christmas week' }, OVERTIME] });
    assert.deepEqual(read.groups, GROUPS);
  });

  it('leaves another version\'s groups alone (unsupported), and keeps sites apart', () => {
    assert.deepEqual(normalizeSiteGroups({ version: 2, groups: GROUPS }), { version: 1, groups: [], unsupported: true });
    const bySite = normalizeWorklogGroupsBySite({ [SITE]: { version: 1, groups: [XMAS] }, [OTHER_SITE]: { version: 1, groups: [OVERTIME] } });
    assert.deepEqual(bySite[SITE].groups, [XMAS]);
    assert.deepEqual(bySite[OTHER_SITE].groups, [OVERTIME]);
    assert.deepEqual(normalizeWorklogGroupsBySite([]), {});
  });

  it('checks a new or renamed group against the site\'s others, and allows five at most', () => {
    assert.deepEqual(validateGroupDraft({ name: ' Infra ' }, { groups: GROUPS }), { errors: {}, group: { name: 'Infra' } });
    assert.match(validateGroupDraft({ name: 'overtime' }, { groups: GROUPS }).errors.name, /Another group/);
    // Renaming a group to its own name, in another case, is fine.
    assert.deepEqual(validateGroupDraft({ name: 'OVERTIME' }, { groups: GROUPS, editingId: OVERTIME.id }).group, { name: 'OVERTIME' });
    const five = Array.from({ length: MAX_WORKLOG_GROUPS }, (_, i) => ({ id: `group-${i}`, name: `G${i}` }));
    assert.match(validateGroupDraft({ name: 'Sixth' }, { groups: five }).errors.form, /at most 5 custom groups/);
    assert.match(validateGroupDraft({ name: 'X' }, { groups: GROUPS, editingId: 'group-gone' }).errors.form, /deleted/);
  });
});

describe('Worklog Queue groups - stored with the worklogs', () => {
  it('keeps a custom group\'s ID as stored, even for a group that\'s gone, and Pending and On Hold as before', () => {
    const state = normalizeTimeTracking({ version: 2, running: null, pending: ENTRIES });
    assert.deepEqual(state.pending.map(classificationOf), ['ready', 'ready', 'on-hold', XMAS.id, XMAS.id, OVERTIME.id, 'group-gone']);
  });

  it('files worklogs under a custom group in one write, and moves them between groups, one group at a time', async () => {
    const storage = await seededStorage();
    const store = createTimeTrackingStore(storage, { lock: serialLock() });
    const result = await store.classifyPending(['p1', 'p6'], XMAS.id);
    assert.deepEqual(result.classified.map((e) => e.id), ['p1', 'p6']);
    assert.equal(storage.writes.length, 1);
    let after = await stored(storage);
    assert.equal(filedAs(after, 'p1'), XMAS.id);
    assert.equal(filedAs(after, 'p6'), XMAS.id, 'left Overtime: one field, one group');

    await store.classifyPending(['p4'], OVERTIME.id);
    after = await stored(storage);
    assert.equal(filedAs(after, 'p4'), OVERTIME.id);
    await store.classifyPending(['p4'], 'ready');
    after = await stored(storage);
    assert.equal('classification' in after.pending.find((e) => e.id === 'p4'), false, 'Pending is never stored');
    // Nothing else about the worklogs changed.
    assert.deepEqual(after.pending.map(({ classification, ...rest }) => rest), ENTRIES.map(({ classification, ...rest }) => rest));
  });

  it('keeps the group through an edit, and drops it with the worklog once submitted', async () => {
    const storage = await seededStorage();
    const store = createTimeTrackingStore(storage, { lock: serialLock(), now: () => T0 + 10_000 });
    await store.updatePending('p4', { comment: 'Edited' });
    assert.equal(filedAs(await stored(storage), 'p4'), XMAS.id);
    await store.beginSubmission('p4', { site: SITE });
    await store.completeSubmission('p4');
    const after = await stored(storage);
    assert.equal(after.pending.some((e) => e.id === 'p4'), false);
    assert.deepEqual(entriesIn(after.pending, XMAS.id, GROUPS).map((e) => e.id), ['p5']);
  });

  it('moves a deleted group\'s worklogs to On Hold in one write, being submitted or not, and only those', async () => {
    const pending = ENTRIES.map((e) => (e.id === 'p5' ? { ...e, submission: { state: 'submitting', at: T0 + 9_000 } } : e));
    const storage = await seededStorage(pending);
    const store = createTimeTrackingStore(storage, { lock: serialLock(), now: () => T0 + 10_000 });
    const { released } = await store.releaseGroup(XMAS.id);
    assert.deepEqual(released.map((e) => e.id), ['p4', 'p5']);
    assert.equal(storage.writes.length, 1);
    const after = await stored(storage);
    assert.deepEqual(after.pending.map(classificationOf), ['ready', 'ready', 'on-hold', 'on-hold', 'on-hold', OVERTIME.id, 'group-gone']);
    assert.deepEqual(after.pending.find((e) => e.id === 'p5').submission, { state: 'submitting', at: T0 + 9_000 }, 'submission untouched');

    await store.releaseGroup(XMAS.id);
    assert.equal(storage.writes.length, 1, 'nothing left to move: nothing written');
    await assert.rejects(store.releaseGroup('on-hold'), { code: 'INVALID_CLASSIFICATION' });
  });

  it('releases a group through the timer controller, even while another change runs', async () => {
    const storage = await seededStorage();
    const controller = createTimerController({
      createStore: () => createTimeTrackingStore(storage, { lock: serialLock(), now: () => T0 + 10_000 }),
      watchStorage: () => () => {}, onChange: () => {}, onTick: () => {}, onError: () => {},
      setInterval: () => 1, clearInterval: () => {}, logError: () => {}
    });
    await controller.init();
    const [moved, released] = await Promise.all([controller.classifyPending(['p1'], OVERTIME.id), controller.releaseGroup(OVERTIME.id)]);
    assert.deepEqual(moved.classified.map((e) => e.id), ['p1']);
    // The release ran after the move (one lock): both Overtime worklogs are in On Hold.
    assert.deepEqual(released.map((e) => e.id), ['p1', 'p6']);
    assert.deepEqual(entriesIn(controller.getState().tracking.pending, 'on-hold', [XMAS]).map((e) => e.id), ['p1', 'p3', 'p6', 'p7']);
  });
});

describe('Worklog Queue groups - tabs, counts, and actions', () => {
  it('lists Pending, On Hold, then the custom groups, in order', () => {
    assert.deepEqual(classificationsFor(GROUPS).map((c) => [c.id, c.label, c.action]), [
      ['ready', 'Pending', 'Mark as Pending'], ['on-hold', 'On Hold', 'Put On Hold'],
      [XMAS.id, 'Christmas Week', 'Move to Christmas Week'], [OVERTIME.id, 'Overtime', 'Move to Overtime']
    ]);
  });

  it('puts every worklog in exactly one group: a group that\'s gone reads as On Hold', () => {
    assert.equal(resolveClassification(ENTRIES[6], GROUPS), 'on-hold');
    assert.equal(resolveClassification(ENTRIES[5], [XMAS]), 'on-hold', 'Overtime deleted');
    assert.equal(resolveClassification(ENTRIES[3], GROUPS), XMAS.id);
    const summary = summarizeClassifications(ENTRIES, GROUPS);
    assert.deepEqual(summary, {
      ready: { count: 2, seconds: HOUR + 1800 },
      'on-hold': { count: 2, seconds: 3600 },
      [XMAS.id]: { count: 2, seconds: 2 * HOUR + 1800 },
      [OVERTIME.id]: { count: 1, seconds: 1800 }
    });
    const total = Object.values(summary).reduce((sum, { count }) => sum + count, 0);
    assert.equal(total, ENTRIES.length);
  });

  it('offers every other group in a row\'s menu and the bulk bar', () => {
    assert.deepEqual(rowActions(XMAS.id, GROUPS).map((c) => c.id), ['ready', 'on-hold', OVERTIME.id]);
    assert.deepEqual(bulkActions([ENTRIES[3], ENTRIES[4]], GROUPS).map((c) => c.id), ['ready', 'on-hold', OVERTIME.id]);
    assert.deepEqual(bulkActions([ENTRIES[3], ENTRIES[5]], GROUPS).map((c) => c.id), ['ready', 'on-hold', XMAS.id, OVERTIME.id]);
  });

  it('selects a custom group\'s tab, selects within it only, and gives way to On Hold once the group is gone', () => {
    const selection = createPendingSelection(XMAS.id);
    assert.equal(selection.tab, XMAS.id, 'remembered before the groups are known');
    assert.equal(selection.selectTab('group-unknown', GROUPS), false);
    selection.setSelecting(true);
    selection.selectAll(ENTRIES, GROUPS);
    assert.deepEqual(selection.selectedIds(), ['p4', 'p5']);
    assert.equal(selection.toggle('p1', ENTRIES, GROUPS), false, 'Pending\'s, not this tab\'s');

    assert.equal(selection.reconcile(ENTRIES, [OVERTIME]), true);
    assert.equal(selection.tab, 'on-hold');
    assert.equal(selection.size, 0);
    assert.equal(selection.selectTab(OVERTIME.id, GROUPS), true);
  });

  it('names a custom group when it moves worklogs there', async () => {
    const classify = async (ids) => ({ classified: ids.map((id) => ({ id })), unchanged: [], refused: [] });
    const one = await classifyPendingWorklogs({ classify, entries: ENTRIES, ids: ['p1'], to: OVERTIME.id, groups: GROUPS });
    assert.equal(one.message, 'Moved KAN-1 to Overtime');
    const two = await classifyPendingWorklogs({ classify, entries: ENTRIES, ids: ['p1', 'p2'], to: XMAS.id, groups: GROUPS });
    assert.equal(two.message, 'Moved 2 worklogs to Christmas Week');
  });

  it('totals a custom group for the header, in the view tabs\' blue', () => {
    assert.deepEqual(pendingTabTotals(ENTRIES, XMAS.id, GROUPS), { id: XMAS.id, tone: 'view', label: 'Christmas Week', count: 2, seconds: 2 * HOUR + 1800 });
    assert.deepEqual(pendingTabTotals(ENTRIES, 'group-gone', GROUPS), { id: 'on-hold', tone: 'on-hold', label: 'On Hold', count: 2, seconds: 3600 });
  });
});

describe('Worklog Queue groups - the settings store', () => {
  it('saves one site\'s groups, keeping every other site\'s as stored', async () => {
    const area = createMemoryStorageArea({ worklogGroupsBySite: { [OTHER_SITE]: { version: 1, groups: [OVERTIME] } } });
    const store = createSettingsStore(area);
    await store.saveWorklogGroups(SITE, GROUPS);
    const settings = await store.load();
    assert.deepEqual(worklogGroupsForSite(settings, SITE).groups, GROUPS);
    assert.deepEqual(worklogGroupsForSite(settings, OTHER_SITE).groups, [OVERTIME]);
    await store.saveWorklogGroups(SITE, []);
    assert.deepEqual(Object.keys((await area.get(['worklogGroupsBySite'])).worklogGroupsBySite), [OTHER_SITE]);
    assert.deepEqual(worklogGroupsForSite(normalizeSettings({}), SITE), { version: 1, groups: [] });
  });

  it('refuses invalid groups, more than five, repeated names, and another version\'s groups', async () => {
    const area = createMemoryStorageArea({ worklogGroupsBySite: { [OTHER_SITE]: { version: 9, groups: [] } } });
    const store = createSettingsStore(area);
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `group-${i}`, name: `G${i}` }));
    await assert.rejects(store.saveWorklogGroups(SITE, six), /aren't valid/);
    await assert.rejects(store.saveWorklogGroups(SITE, [{ id: 'on-hold', name: 'X' }]), /aren't valid/);
    await assert.rejects(store.saveWorklogGroups(SITE, [XMAS, { id: 'group-2', name: 'christmas week' }]), /aren't valid/);
    await assert.rejects(store.saveWorklogGroups(OTHER_SITE, GROUPS), /another version/);
    await assert.rejects(store.saveWorklogGroups('', GROUPS), /site is required/);
  });
});

describe('Worklog Queue groups - in My Work', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  function render({ tab = 'ready', groups = GROUPS, groupActions, selection } = {}) {
    const calls = { tabs: [], created: 0, edited: [], classified: [] };
    const section = h('section', { id: 'workingIssues' });
    renderWorkingIssues(section, {
      state: { status: 'ready', issues: [] }, expanded: true, baseUrl: 'https://acme.atlassian.net',
      pending: {
        entries: ENTRIES, site: SITE, now: T0 + 5000, tab, groups,
        groupActions: groupActions === null ? undefined : {
          canCreate: true, onCreate: () => calls.created++, onEdit: (id) => calls.edited.push(id), ...groupActions
        },
        onEdit: () => {}, onDiscard: () => {}, onSubmit: () => {}, onMenu: () => {},
        onSelectTab: (t) => calls.tabs.push(t),
        selection: {
          active: false, ids: [], onToggleMode: () => {}, onToggle: () => {}, onSelectAll: () => {}, onDeselectAll: () => {},
          onClassify: (to) => calls.classified.push(to), ...selection
        }
      }
    });
    return { section, calls };
  }

  const group = (section) => section.querySelector('#workingIssuesGroup-pending');
  const tabs = (section) => group(section).querySelectorAll('[role="tab"]');
  const rows = (section) => group(section).querySelectorAll('.pending-worklog').map((r) => r.dataset.pendingId);

  it('shows the custom groups as tabs beside Pending and On Hold, with their counts, and no other navigation', () => {
    const { section } = render();
    assert.deepEqual(tabs(section).map((t) => t.textContent), ['Pending (2)', 'On Hold (2)', 'Christmas Week (2)', 'Overtime (1)']);
    // One tablist, in the Issues view tabs' shape: no All tab, heading, or second level.
    assert.equal(group(section).querySelectorAll('[role="tablist"]').length, 1);
    for (const tab of tabs(section)) assert.ok(tab.classList.contains('working-issues-view-tab'));
    // Custom groups look exactly like the view tabs: none of Pending's and On Hold's own colors.
    assert.deepEqual(tabs(section).map((t) => t.classList.contains('pending-group-tab')), [false, false, true, true]);
    assert.ok(!tabs(section)[2].classList.contains('pending-tab'));
  });

  it('lists only the selected group\'s worklogs, and names, counts, and totals it in the header', () => {
    const { section } = render({ tab: XMAS.id });
    assert.deepEqual(rows(section), ['p5', 'p4']);
    assert.equal(section.querySelector('#workingIssuesGroupToggle-pending').textContent, 'Worklog Queue · Christmas Week (2)');
    assert.ok(section.querySelector('.working-issues-group-classification').classList.contains('is-view'));
    assert.equal(section.querySelector('.working-issues-group-total').textContent, '2h 30m');
    assert.equal(tabs(section)[2].getAttribute('aria-selected'), 'true');
  });

  it('shows a deleted group\'s worklogs in On Hold, and On Hold for a tab whose group is gone', () => {
    const { section } = render({ tab: OVERTIME.id, groups: [XMAS] });
    assert.equal(section.querySelector('#workingIssuesGroupToggle-pending').textContent, 'Worklog Queue · On Hold (3)');
    assert.deepEqual(rows(section), ['p7', 'p6', 'p3']);
  });

  it('has the pencil for a selected custom group only, then +, as beside the view tabs', () => {
    const builtIn = render().section;
    const bar = group(builtIn).querySelector('.pending-groupbar');
    assert.deepEqual(bar.children.map((c) => c.getAttribute('data-action') ?? c.getAttribute('role')), ['tablist', 'add-group']);

    const { section, calls } = render({ tab: OVERTIME.id });
    const custom = group(section).querySelector('.pending-groupbar');
    assert.deepEqual(custom.children.map((c) => c.getAttribute('data-action') ?? c.getAttribute('role')), ['tablist', 'edit-group', 'add-group']);
    const edit = custom.querySelector('[data-action="edit-group"]');
    assert.equal(edit.getAttribute('aria-label'), 'Edit the Overtime group');
    assert.ok(edit.classList.contains('working-issues-view-btn'), 'the views\' button');
    edit.click();
    custom.querySelector('[data-action="add-group"]').click();
    assert.deepEqual(calls.edited, [OVERTIME.id]);
    assert.equal(calls.created, 1);
  });

  it('offers + only below five groups, and while groups can be created', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ id: `group-${i}`, name: `G${i}` }));
    assert.equal(group(render({ groups: five }).section).querySelector('[data-action="add-group"]'), null);
    assert.equal(group(render({ groupActions: { canCreate: false } }).section).querySelector('[data-action="add-group"]'), null);
    assert.equal(group(render({ groupActions: null, tab: XMAS.id }).section).querySelector('.working-issues-view-btn'), null);
  });

  it('chooses a custom group\'s tab by click and arrow keys', () => {
    const { section, calls } = render();
    tabs(section)[3].click();
    group(section).querySelector('[role="tablist"]').dispatchEvent({ type: 'keydown', key: 'End' });
    assert.deepEqual(calls.tabs, [OVERTIME.id, OVERTIME.id]);
  });

  it('says how to fill an empty custom group', () => {
    const { section } = render({ groups: [...GROUPS, { id: 'group-infra', name: 'Infrastructure' }], tab: 'group-infra' });
    assert.match(group(section).querySelector('.working-issues-empty').textContent, /Nothing is in Infrastructure\. Select worklogs in another tab to move them here\./);
  });

  it('moves the selected worklogs to any other group from the bulk bar', () => {
    const { section, calls } = render({ tab: XMAS.id, selection: { active: true, ids: ['p4'] } });
    const buttons = group(section).querySelectorAll('.pending-bulk-btn');
    assert.deepEqual(buttons.map((b) => b.textContent), ['Pending', 'On Hold', 'Overtime']);
    assert.equal(buttons[2].getAttribute('aria-label'), 'Move 1 selected worklog to Overtime');
    assert.equal(group(section).querySelector('.pending-bulk-summary').textContent, '1 selected · 2h 00m');
    buttons[2].click();
    assert.deepEqual(calls.classified, [OVERTIME.id]);
  });

  it('offers Move to each custom group in a row\'s menu, with a folder icon', () => {
    const body = h('body');
    const button = h('button', { class: 'pending-menu-btn', 'data-pending-id': 'p1', 'aria-expanded': 'false' });
    body.append(button);
    const menu = createPendingActionsMenu({ container: body, findButton: () => button });
    const chosen = [];
    menu.open({ id: 'p1', label: 'Move', actions: rowActions('ready', GROUPS), onChoose: (c) => chosen.push(c) });
    const items = body.querySelectorAll('[role="menuitem"]');
    assert.deepEqual(items.map((i) => i.textContent), ['Put On Hold', 'Move to Christmas Week', 'Move to Overtime']);
    assert.ok(items[1].querySelector('path'), 'an icon');
    items[2].click();
    assert.deepEqual(chosen, [OVERTIME.id]);
  });
});

describe('Worklog Queue groups - the editor', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  function open({ group = null, groups = GROUPS, onSave, onDelete, count = 2 } = {}) {
    const root = h('aside', { class: 'custom-view-editor hidden' });
    const calls = [];
    const editor = openWorklogGroupEditor(root, {
      group,
      countWorklogs: () => count,
      validate: (draft) => validateGroupDraft(draft, { groups, editingId: group?.id }),
      onSave: onSave ?? (async (saved) => { calls.push(['save', saved]); }),
      onDelete: group ? (onDelete ?? (async () => { calls.push(['delete']); })) : undefined,
      onClose: () => calls.push(['close'])
    });
    const $ = (selector) => root.querySelector(selector);
    const submit = () => $('form').dispatchEvent({ type: 'submit' });
    return { root, editor, calls, $, submit };
  }
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('creates a group from its name alone, in the custom view editor\'s drawer', async () => {
    const { root, $, submit, calls } = open();
    assert.equal($('.custom-view-title').textContent, 'New group');
    assert.ok(root.querySelector('.custom-view-editor-body'), 'the view editor\'s look');
    assert.equal(root.querySelectorAll('input').length, 1, 'a name, nothing else');
    assert.equal($('.custom-view-delete'), null);
    assert.ok(document.activeElement === $('#worklogGroupName'));
    $('#worklogGroupName').value = ' Infrastructure ';
    submit();
    await flush();
    assert.deepEqual(calls, [['save', { name: 'Infrastructure' }], ['close']]);
  });

  it('says what\'s wrong with a name, and saves nothing', async () => {
    const { $, submit, calls } = open();
    $('#worklogGroupName').value = 'on hold';
    submit();
    await flush();
    assert.match($('#worklogGroupNameError').textContent, /"On Hold" is a built-in group/);
    $('#worklogGroupName').value = 'Overtime';
    submit();
    assert.match($('#worklogGroupNameError').textContent, /Another group already has this name/);
    assert.deepEqual(calls, []);
  });

  it('renames a group, and keeps it open with the reason when saving fails', async () => {
    const { $, submit, calls } = open({ group: OVERTIME, onSave: async () => { throw new Error('Storage is full.'); } });
    assert.equal($('.custom-view-title').textContent, 'Edit group');
    assert.equal($('#worklogGroupName').value, 'Overtime');
    $('#worklogGroupName').value = 'Late Hours';
    submit();
    await flush();
    assert.equal($('#worklogGroupFormError').textContent, 'Storage is full.');
    assert.deepEqual(calls, []);
  });

  it('asks before deleting, saying where the worklogs go, and can keep the group', async () => {
    const { $, calls } = open({ group: XMAS, count: 8 });
    $('[data-action="delete-group"]').click();
    assert.equal($('.custom-view-delete-question').textContent, 'Delete the Christmas Week group? Its 8 worklogs move to On Hold.');
    $('[data-action="keep-group"]').click();
    assert.ok($('[data-action="delete-group"]'));
    $('[data-action="delete-group"]').click();
    $('[data-action="confirm-delete-group"]').click();
    await flush();
    assert.deepEqual(calls, [['delete'], ['close']]);
    assert.equal(deleteGroupQuestion('X', 1), 'Delete the X group? Its worklog moves to On Hold.');
    assert.equal(deleteGroupQuestion('X', 0), 'Delete the X group? It has no worklogs.');
  });

  it('closes with Escape, Cancel, or ×, saving nothing', () => {
    for (const how of ['escape', 'cancel', 'close']) {
      const { root, $, calls, editor } = open();
      if (how === 'escape') root.querySelector('.custom-view-editor-body').dispatchEvent({ type: 'keydown', key: 'Escape' });
      else $(`[data-action="${how}-group${how === 'close' ? '-editor' : ''}"]`).click();
      assert.deepEqual(calls, [['close']], how);
      assert.equal(editor.isOpen, false);
    }
  });
});

describe('Worklog Queue groups - end to end in the page', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  it('moves worklogs into a group, between groups, and back to On Hold when the group is deleted, counting each tab', async () => {
    const storage = await seededStorage(ENTRIES.slice(0, 3));
    const controller = createTimerController({
      createStore: () => createTimeTrackingStore(storage, { lock: serialLock(), now: () => T0 + 10_000 }),
      watchStorage: () => () => {}, onChange: () => {}, onTick: () => {}, onError: () => {},
      setInterval: () => 1, clearInterval: () => {}, logError: () => {}
    });
    await controller.init();
    let groups = [...GROUPS];
    const selection = createPendingSelection('ready');
    const entries = () => controller.getState().tracking.pending;
    const counts = () => Object.fromEntries(Object.entries(summarizeClassifications(entries(), groups)).map(([id, { count }]) => [id, count]));

    // Select all of Pending, move them to Christmas Week (as options.js's classifyPending()).
    selection.setSelecting(true);
    selection.selectAll(entries(), groups);
    const outcome = await classifyPendingWorklogs({ classify: controller.classifyPending, entries: entries(), ids: selection.selectedIds(), to: XMAS.id, groups });
    settleBulkSelection(selection, outcome);
    assert.equal(outcome.status, 'done');
    assert.equal(selection.selecting, false, 'done: selection mode closes');
    assert.deepEqual(counts(), { ready: 0, 'on-hold': 1, [XMAS.id]: 2, [OVERTIME.id]: 0 });

    // One of them to Overtime: it leaves Christmas Week.
    await classifyPendingWorklogs({ classify: controller.classifyPending, entries: entries(), ids: ['p1'], to: OVERTIME.id, groups });
    assert.deepEqual(counts(), { ready: 0, 'on-hold': 1, [XMAS.id]: 1, [OVERTIME.id]: 1 });

    // Deleting Christmas Week (as options.js: the definition first, then its worklogs to On Hold).
    selection.selectTab(XMAS.id, groups);
    groups = [OVERTIME];
    assert.deepEqual(counts(), { ready: 0, 'on-hold': 2, [OVERTIME.id]: 1 }, 'On Hold at once, before storage changes');
    selection.reconcile(entries(), groups);
    assert.equal(selection.tab, 'on-hold');
    await controller.releaseGroup(XMAS.id);
    assert.deepEqual(entries().map(classificationOf), [OVERTIME.id, 'on-hold', 'on-hold']);
    assert.deepEqual(counts(), { ready: 0, 'on-hold': 2, [OVERTIME.id]: 1 });
    assert.equal(entries().length, 3, 'no worklog lost');
  });
});

describe('Worklog Queue groups - page wiring', () => {
  const options = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
  const fn = (name) => {
    const start = options.indexOf(`function ${name}(`);
    return options.slice(start, options.indexOf('\n}\n', start));
  };

  it('saves groups per Jira site, and follows changes made in another tab', () => {
    assert.match(fn('openWorklogGroupEditorFor'), /settingsStore\.saveWorklogGroups\(site, groups\)/);
    assert.match(options, /platform\.watchStorage\(\(changes\) => \{\s*if \(!\('worklogGroupsBySite' in changes\)\) return;[\s\S]*?showPendingWorklogs\(\);/);
  });

  it('moves a deleted group\'s worklogs to On Hold through the timer, after the group is gone, never through Jira', () => {
    const editor = fn('openWorklogGroupEditorFor');
    assert.ok(editor.indexOf('timer.releaseGroup(group.id)') > editor.indexOf('await store(groups.filter('));
    // The client only names the site (its type and address); nothing is asked of Jira.
    assert.doesNotMatch(editor, /client\.(?!deploymentType|baseUrl)|Jira\(/);
  });

  it('refuses to move worklogs to a group that was deleted meanwhile', () => {
    assert.match(fn('classifyPending'), /if \(!isClassification\(classification, groups\)\)/);
  });
});
