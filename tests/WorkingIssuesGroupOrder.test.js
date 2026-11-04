import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import { renderWorkingIssues, orderWorkingIssuesGroups, GROUP_MOVE_HINT, GROUP_SHORTCUTS } from '../src/ui/weekView.js';
import {
  createSettingsStore, normalizeSettings, normalizeWorkingIssuesGroupOrder, workingIssuesGroupOrderForSite, WORKING_ISSUES_GROUP_IDS
} from '../src/settings/settingsStore.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';
import { siteId } from '../src/timer/timeTrackingStore.js';

const SITE = siteId('cloud', 'https://acme.atlassian.net');
const OTHER_SITE = siteId('server', 'https://jira.example.com');
const T0 = new Date(2026, 9, 26, 9, 15).getTime();

const ISSUES = [
  { issueId: '10012', issueKey: 'KAN-12', issueSummary: 'Fix the login page', issueStatus: { name: 'In Progress', categoryKey: 'indeterminate' } }
];
const ENTRIES = [
  { id: 'p1', site: SITE, issueId: '10020', issueKey: 'KAN-20', issueSummary: 'Write the docs', startedAt: T0, stoppedAt: T0 + 1_530_000, timeSpentSeconds: 1530, comment: '' }
];

/** renderWorkingIssues()'s options, recording what's reported. */
function sectionOptions({ groupOrder, movable = true, pending = true, groupsExpanded } = {}) {
  const calls = { moves: [], groups: [], edited: [], started: [] };
  return {
    calls,
    options: {
      state: { status: 'ready', issues: ISSUES },
      expanded: true,
      baseUrl: 'https://acme.atlassian.net',
      timer: { site: SITE, running: null, now: T0, onStart: (issue) => calls.started.push(issue.issueKey), onStop() {} },
      pending: pending ? { entries: ENTRIES, site: SITE, onEdit: (id) => calls.edited.push(id), onDiscard() {} } : undefined,
      groupsExpanded,
      onGroupToggle: (group, expanded) => calls.groups.push([group, expanded]),
      groupOrder,
      onGroupMove: movable ? (order) => calls.moves.push(order) : undefined
    }
  };
}

function render(opts) {
  const { calls, options } = sectionOptions(opts);
  const section = h('section', { id: 'workingIssues' });
  renderWorkingIssues(section, options);
  return { section, calls, options };
}

const body = (section) => section.querySelector('.working-issues-body');
const groupIds = (section) => body(section).children.map((el) => el.dataset.group);
const groupEl = (section, id) => body(section).children.find((el) => el.dataset.group === id);
const handle = (section, id) => groupEl(section, id).querySelector('.working-issues-group-handle');
const toggle = (section, id) => section.querySelector(`#workingIssuesGroupToggle-${id}`);
const isOpen = (section, id) => toggle(section, id).getAttribute('aria-expanded') === 'true';

/**
 * Gives the groups boxes on the page, in their current order, each 100 px tall from y = 0, and
 * returns how to drag a group's handle to a y.
 */
function layout(section) {
  const place = () => body(section).children.forEach((el, i) => {
    el.getBoundingClientRect = () => ({ left: 0, right: 300, top: i * 100, bottom: i * 100 + 100 });
  });
  place();
  const pointer = (type, target, y, x = 5) => target.dispatchEvent({ type, pointerId: 1, button: 0, clientX: x, clientY: y });
  return {
    place,
    pointer,
    /** Presses a group's handle, moves to y, and releases: the click that follows a release too. */
    drag(id, toY, { release = true } = {}) {
      const grip = handle(section, id);
      const fromY = groupIds(section).indexOf(id) * 100 + 10;
      pointer('pointerdown', grip, fromY);
      pointer('pointermove', grip, fromY + (toY > fromY ? 3 : -3));
      pointer('pointermove', grip, toY);
      if (!release) return;
      pointer('pointerup', grip, toY);
      grip.click();
    }
  };
}

describe('My Work - group order', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  it('keeps the default order, My Issues then Pending Worklogs, without a saved one', () => {
    assert.deepEqual(groupIds(render().section), ['active', 'pending']);
    assert.deepEqual(groupIds(render({ groupOrder: [] }).section), ['active', 'pending']);
    assert.deepEqual(groupIds(render({ groupOrder: ['unknown'] }).section), ['active', 'pending']);
  });

  it('draws the groups in the order given', () => {
    assert.deepEqual(groupIds(render({ groupOrder: ['pending', 'active'] }).section), ['pending', 'active']);
    // Groups the order doesn't name follow.
    assert.deepEqual(groupIds(render({ groupOrder: ['pending'] }).section), ['pending', 'active']);
  });

  it('puts a six-dot handle at the start of each group header, outside its button', () => {
    const { section } = render();
    for (const id of ['active', 'pending']) {
      const header = groupEl(section, id).querySelector('.working-issues-group-header');
      const grip = handle(section, id);
      assert.ok(header.children[0] === grip, 'first in the header');
      assert.equal(grip.getAttribute('aria-hidden'), 'true');
      assert.equal(grip.closest('button'), null);
      assert.equal(grip.querySelectorAll('circle').length, 6);
      // The group still holds its header, then its contents.
      assert.deepEqual(groupEl(section, id).children.map((n) => n.className), ['working-issues-group-header', 'working-issues-group-body']);
    }
  });

  it('has no handle with only one group, or when the page doesn\'t allow moving', () => {
    assert.equal(render({ movable: false }).section.querySelector('.working-issues-group-handle'), null);
    assert.equal(render({ pending: false }).section.querySelector('.working-issues-group-handle'), null);
    assert.equal(render({ movable: false }).section.querySelector('#workingIssuesGroupMoveHint-active'), null);
    assert.equal(toggle(render({ movable: false }).section, 'active').getAttribute('aria-keyshortcuts'), null);
  });

  it('drags My Issues below Pending Worklogs, moving the groups themselves', () => {
    const { section, calls } = render();
    const active = groupEl(section, 'active');
    const pending = groupEl(section, 'pending');
    layout(section).drag('active', 180);
    assert.deepEqual(groupIds(section), ['pending', 'active']);
    assert.ok(groupEl(section, 'active') === active && groupEl(section, 'pending') === pending, 'the same elements, not drawn again');
    assert.deepEqual(calls.moves, [['pending', 'active']]);
    assert.deepEqual(calls.groups, [], 'neither group expanded nor collapsed');
  });

  it('drags Pending Worklogs above My Issues', () => {
    const { section, calls } = render();
    layout(section).drag('pending', 20);
    assert.deepEqual(groupIds(section), ['pending', 'active']);
    assert.deepEqual(calls.moves, [['pending', 'active']]);
  });

  it('drags from a saved order back to the default one', () => {
    const { section, calls } = render({ groupOrder: ['pending', 'active'] });
    layout(section).drag('active', 20);
    assert.deepEqual(groupIds(section), ['active', 'pending']);
    assert.deepEqual(calls.moves, [['active', 'pending']]);
  });

  it('moves nothing when dropped where it was, or pressed without a drag', () => {
    const { section, calls } = render();
    const { drag, pointer } = layout(section);
    drag('active', 40);
    drag('pending', 160);
    pointer('pointerdown', handle(section, 'active'), 10);
    pointer('pointermove', handle(section, 'active'), 12);
    pointer('pointerup', handle(section, 'active'), 12);
    assert.deepEqual(groupIds(section), ['active', 'pending']);
    assert.deepEqual(calls.moves, []);
  });

  it('fades the dragged group, shows a line where it would go, and clears both on release', () => {
    const { section } = render();
    const { drag, pointer } = layout(section);
    drag('active', 180, { release: false });
    assert.ok(groupEl(section, 'active').classList.contains('is-dragging'));
    assert.ok(groupEl(section, 'pending').classList.contains('is-drop-after'));
    assert.ok(body(section).classList.contains('is-reordering-groups'));
    // Back over itself: no line.
    pointer('pointermove', handle(section, 'active'), 30);
    assert.equal(groupEl(section, 'pending').classList.contains('is-drop-after'), false);
    pointer('pointermove', handle(section, 'active'), 180);
    pointer('pointerup', handle(section, 'active'), 180);
    assert.ok(body(section).children.every((el) => !/is-dragging|is-drop-/.test(el.className)));
    assert.equal(body(section).classList.contains('is-reordering-groups'), false);
  });

  it('shows the line before the group it would go above', () => {
    const { section } = render();
    layout(section).drag('pending', 20, { release: false });
    assert.ok(groupEl(section, 'active').classList.contains('is-drop-before'));
  });

  it('cancels a drag with Escape, moving nothing', () => {
    const { section, calls } = render();
    const { drag, pointer } = layout(section);
    drag('active', 180, { release: false });
    const escape = toggle(section, 'pending').dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(escape, false, 'handled');
    pointer('pointerup', handle(section, 'active'), 180);
    assert.deepEqual(groupIds(section), ['active', 'pending']);
    assert.deepEqual(calls.moves, []);
    assert.equal(groupEl(section, 'active').classList.contains('is-dragging'), false);
  });

  it('only drags from the handle: a press on the header button or the group contents moves nothing', () => {
    const { section, calls } = render();
    const { pointer } = layout(section);
    for (const target of [toggle(section, 'active'), groupEl(section, 'active').querySelector('.working-issues-group-body')]) {
      pointer('pointerdown', target, 10);
      pointer('pointermove', target, 100);
      pointer('pointermove', target, 180);
      pointer('pointerup', target, 180);
    }
    assert.deepEqual(groupIds(section), ['active', 'pending']);
    assert.deepEqual(calls.moves, []);
  });

  it('never expands or collapses a group from its handle, or from the click a drag ends with', () => {
    const { section, calls } = render();
    handle(section, 'active').click();
    handle(section, 'active').querySelector('circle').click();
    assert.deepEqual(calls.groups, []);
    layout(section).drag('active', 180);
    assert.deepEqual(calls.groups, []);
    assert.ok(isOpen(section, 'active') && isOpen(section, 'pending'));
  });

  it('still expands and collapses a group from the rest of its header, before and after a move', () => {
    const { section, calls } = render();
    toggle(section, 'active').click();
    assert.equal(isOpen(section, 'active'), false);
    layout(section).drag('active', 180);
    // A Escape-cancelled drag swallows nothing either.
    layout(section).drag('pending', 180, { release: false });
    toggle(section, 'pending').dispatchEvent({ type: 'keydown', key: 'Escape' });
    groupEl(section, 'active').querySelector('.working-issues-group-header').click();
    toggle(section, 'pending').click();
    assert.deepEqual(calls.groups, [['active', false], ['active', true], ['pending', false]]);
  });

  it('keeps each group\'s expanded or collapsed state and contents when moved', () => {
    const { section, calls } = render({ groupsExpanded: { active: false, pending: true } });
    const list = groupEl(section, 'pending').querySelector('.pending-worklog');
    layout(section).drag('active', 180);
    assert.equal(isOpen(section, 'active'), false);
    assert.equal(isOpen(section, 'pending'), true);
    assert.ok(groupEl(section, 'pending').querySelector('.pending-worklog') === list);
    groupEl(section, 'pending').querySelector('.pending-edit-btn').click();
    groupEl(section, 'active').querySelector('.working-issue-timer-btn').click();
    assert.deepEqual(calls.edited, ['p1']);
    assert.deepEqual(calls.started, ['KAN-12']);
  });

  it('moves the focused group with Alt+Shift and the Up or Down Arrow, one place, keeping focus', () => {
    const { section, calls } = render();
    const press = (key, id) => toggle(section, id).dispatchEvent({ type: 'keydown', key, altKey: true, shiftKey: true });
    toggle(section, 'active').focus();
    assert.equal(press('ArrowDown', 'active'), false, 'handled');
    assert.deepEqual(groupIds(section), ['pending', 'active']);
    assert.ok(document.activeElement === toggle(section, 'active'));
    press('ArrowDown', 'active');
    press('ArrowUp', 'pending');
    press('ArrowUp', 'active');
    assert.deepEqual(groupIds(section), ['active', 'pending']);
    assert.deepEqual(calls.moves, [['pending', 'active'], ['active', 'pending']], 'nothing past either end');
    // Without both modifiers, the arrows do nothing here.
    toggle(section, 'active').dispatchEvent({ type: 'keydown', key: 'ArrowDown', altKey: true });
    assert.deepEqual(calls.moves.length, 2);
    assert.deepEqual(calls.groups, []);
  });

  it('describes the keys on each group\'s header button, and lists them in the shortcuts drawer', () => {
    const { section } = render();
    for (const id of ['active', 'pending']) {
      assert.equal(toggle(section, id).getAttribute('aria-keyshortcuts'), 'Alt+Shift+ArrowUp Alt+Shift+ArrowDown');
      assert.equal(toggle(section, id).getAttribute('aria-describedby'), `workingIssuesGroupMoveHint-${id}`);
      assert.equal(section.querySelector(`#workingIssuesGroupMoveHint-${id}`).textContent, GROUP_MOVE_HINT);
    }
    assert.deepEqual(GROUP_SHORTCUTS.map((shortcut) => shortcut.keys), [[['Alt', 'Shift', '↑']], [['Alt', 'Shift', '↓']]]);
  });

  it('announces a move, and a later render doesn\'t say it again or clear it', () => {
    const { section, options } = render();
    const announcer = section.querySelector('#workingIssuesAnnouncer');
    layout(section).drag('active', 180);
    assert.equal(announcer.textContent, 'Moved My Issues to position 2 of 2.');
    renderWorkingIssues(section, { ...options, groupOrder: ['pending', 'active'] });
    assert.equal(announcer.textContent, 'Moved My Issues to position 2 of 2.');
  });

  it('puts the groups already drawn in another order in place, for a change made in another tab', () => {
    const { section } = render();
    const active = groupEl(section, 'active');
    toggle(section, 'pending').focus();
    orderWorkingIssuesGroups(section, ['pending', 'active']);
    assert.deepEqual(groupIds(section), ['pending', 'active']);
    assert.ok(groupEl(section, 'active') === active);
    assert.ok(document.activeElement === toggle(section, 'pending'));
    orderWorkingIssuesGroups(section, []);
    assert.deepEqual(groupIds(section), ['active', 'pending']);
    // Without groups (no pending options), nothing to do.
    const single = render({ pending: false }).section;
    orderWorkingIssuesGroups(single, ['pending', 'active']);
    assert.equal(single.querySelector('.working-issues-group'), null);
  });

  it('moves with the next drag after a change from another tab', () => {
    const { section, calls } = render();
    orderWorkingIssuesGroups(section, ['pending', 'active']);
    layout(section).drag('active', 20);
    assert.deepEqual(groupIds(section), ['active', 'pending']);
    assert.deepEqual(calls.moves, [['active', 'pending']]);
  });

  it('styles the handle as the only drag area, also for touch, with drag feedback', () => {
    const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
    assert.match(css, /\.working-issues-group-handle \{[^}]*cursor: grab;[^}]*touch-action: none;[^}]*user-select: none;/);
    assert.match(css, /\.working-issues-group\.is-dragging \{\s*opacity: 0\.45;/);
    // The line where it would go, in the space between the containers.
    assert.match(css, /\.working-issues-group\.is-drop-before::before,\s*\.working-issues-group\.is-drop-after::after \{[^}]*position: absolute;[^}]*height: 2px;[^}]*background-color: var\(--primary\);/);
    assert.match(css, /\.working-issues-group\.is-drop-before::before \{\s*top: -7px;/);
    assert.match(css, /\.working-issues-group\.is-drop-after::after \{\s*bottom: -7px;/);
  });
});

describe('Settings store - My Work group order', () => {
  it('reads the default order when none is saved, or a saved one isn\'t valid', () => {
    assert.deepEqual(WORKING_ISSUES_GROUP_IDS, ['active', 'pending']);
    assert.deepEqual(normalizeSettings({}).workingIssuesGroupOrderBySite, {});
    assert.deepEqual(workingIssuesGroupOrderForSite(normalizeSettings({}), SITE), ['active', 'pending']);
    assert.deepEqual(workingIssuesGroupOrderForSite(null, SITE), ['active', 'pending']);
    for (const raw of [null, 'pending', ['x'], [1, 2], {}]) assert.deepEqual(normalizeWorkingIssuesGroupOrder(raw), ['active', 'pending']);
    assert.deepEqual(normalizeWorkingIssuesGroupOrder(['pending', 'pending', 'x']), ['pending', 'active']);
    assert.deepEqual(normalizeSettings({ workingIssuesGroupOrderBySite: ['pending'] }).workingIssuesGroupOrderBySite, {});
  });

  it('saves one site\'s order, keeps every other site\'s, and reads it back per site', async () => {
    const area = createMemoryStorageArea({ workingIssuesGroupOrderBySite: { [OTHER_SITE]: ['active', 'pending'] }, showRecentlyLoggedIssues: true });
    const store = createSettingsStore(area);
    await store.saveWorkingIssuesGroupOrder(SITE, ['pending', 'active']);
    const { workingIssuesGroupOrderBySite } = await area.get(['workingIssuesGroupOrderBySite']);
    assert.deepEqual(workingIssuesGroupOrderBySite, { [OTHER_SITE]: ['active', 'pending'], [SITE]: ['pending', 'active'] });
    const settings = await store.load();
    assert.deepEqual(workingIssuesGroupOrderForSite(settings, SITE), ['pending', 'active']);
    assert.deepEqual(workingIssuesGroupOrderForSite(settings, OTHER_SITE), ['active', 'pending']);
    assert.deepEqual(workingIssuesGroupOrderForSite(settings, siteId('cloud', 'https://other.atlassian.net')), ['active', 'pending']);
    assert.equal(settings.showRecentlyLoggedIssues, true, 'other settings kept');
  });

  it('rejects an order without a site, or that isn\'t every group once, leaving storage as it was', async () => {
    const area = createMemoryStorageArea();
    const store = createSettingsStore(area);
    await assert.rejects(store.saveWorkingIssuesGroupOrder('', ['pending', 'active']), /site is required/);
    for (const ids of [['pending'], ['pending', 'pending'], ['pending', 'active', 'x'], 'pending', null]) {
      await assert.rejects(store.saveWorkingIssuesGroupOrder(SITE, ids), /isn't valid/);
    }
    assert.equal((await area.get(['workingIssuesGroupOrderBySite'])).workingIssuesGroupOrderBySite, undefined);
  });
});

describe('My Work - page keeps the group order', () => {
  const js = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
  const functionSource = (name) => {
    const start = js.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    return js.slice(start, js.indexOf('\n}\n', start));
  };

  it('passes the connected site\'s saved order, and moves only with a site', () => {
    const options = functionSource('workingIssuesOptions');
    assert.match(options, /groupOrder: workingIssuesGroupOrder\(\),/);
    assert.match(options, /onGroupMove: currentClient \? \(order\) => moveWorkingIssuesGroups\(currentClient, order\) : undefined,/);
    assert.match(functionSource('workingIssuesGroupOrder'), /workingIssuesGroupOrderForSite\(savedSettings, siteId\(currentClient\.deploymentType, currentClient\.baseUrl\)\)/);
    // The groups' expanded state stays in its own keys.
    assert.match(options, /groupsExpanded: workingIssuesGroupsExpanded,/);
  });

  it('saves a move for its site without drawing My Work again or loading anything', () => {
    const move = functionSource('moveWorkingIssuesGroups');
    assert.match(move, /settingsStore\.saveWorkingIssuesGroupOrder\(site, order\)/);
    assert.match(move, /workingIssuesGroupOrderBySite: \{ \.\.\.savedSettings\?\.workingIssuesGroupOrderBySite, \[site\]: order \}/);
    assert.doesNotMatch(move, /setWorkingIssuesState|refreshActiveIssues|viewSearch\.|renderWorkingIssues/);
  });

  it('follows a move made in another tab, in place', () => {
    assert.match(js, /platform\.watchStorage\(\(changes\) => \{\s*if \(!\('workingIssuesGroupOrderBySite' in changes\)\) return;[\s\S]*?showWorkingIssuesGroupOrder\(\);/);
    assert.match(functionSource('showWorkingIssuesGroupOrder'), /orderWorkingIssuesGroups\(section, workingIssuesGroupOrder\(\)\)/);
  });

  it('lists the keys in the shortcuts drawer', () => {
    assert.match(js, /for \(const shortcut of \[\.\.\.VIEW_TAB_SHORTCUTS, \.\.\.GROUP_SHORTCUTS\]\) shortcuts\.register\(shortcut\);/);
  });
});
