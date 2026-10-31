import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './support/fakeDom.js';
import { renderWeek } from '../src/ui/weekView.js';
import { h } from '../src/ui/dom.js';

const worklog = (id, issueKey) => ({
  id, issueId: `1${id}`, issueKey, issueSummary: `Work on ${issueKey}`, comment: '',
  formattedStartTime: '09:00', formattedDuration: '1h', author: { displayName: 'Dev' }, isOwn: true
});

const day = (dateKey, dayOfMonth, worklogs) => ({
  dateKey,
  date: new Date(2026, 9, dayOfMonth),
  dayName: 'Day',
  shortDayName: 'Day',
  formattedDate: `${dayOfMonth} Oct`,
  dayOfMonth,
  formattedTotal: `${worklogs.length}h 00m`,
  totalDurationSeconds: worklogs.length * 3600,
  worklogCount: worklogs.length,
  isToday: false,
  worklogs
});

// Monday with three worklogs, Tuesday with one, Wednesday with none; the next week's Monday with two.
const WEEK = { weekDays: [day('2026-10-19', 19, [worklog('1', 'KAN-1'), worklog('2', 'KAN-2'), worklog('3', 'KAN-3')]), day('2026-10-20', 20, [worklog('4', 'KAN-4')]), day('2026-10-21', 21, [])] };
const NEXT_WEEK = { weekDays: [day('2026-10-26', 26, [worklog('5', 'KAN-5'), worklog('6', 'KAN-6')])] };

/**
 * The page as options.js runs it: the selected day, and one expanded state for every day, kept in
 * `storage` (localStorage, as a Map); a new page on the same storage is the tab opened again.
 */
function createPage(storage = new Map()) {
  const container = h('div', {});
  const calls = { added: [], edited: [], deleted: [], toggled: [] };
  let dayExpanded = storage.get('jts-day-panel-expanded') === 'true';
  let week = WEEK;
  let selectedDateKey = '2026-10-19';
  const render = () => renderWeek(container, week, {
    selectedDateKey,
    onSelectDay: (dateKey) => { selectedDateKey = dateKey; render(); },
    onAddWorklog: (dateKey) => calls.added.push(dateKey),
    onEditWorklog: (id) => calls.edited.push(id),
    onLogWork: () => {},
    onDeleteWorklog: (id) => calls.deleted.push(id),
    dayExpanded,
    onToggleDay: (expanded) => {
      calls.toggled.push(expanded);
      dayExpanded = expanded;
      storage.set('jts-day-panel-expanded', String(expanded));
    }
  });
  render();
  return {
    container, calls, render, storage,
    select: (dateKey) => container.querySelector(`.day-card[data-date-key="${dateKey}"]`).click(),
    goToWeek: (next, dateKey) => { week = next; selectedDateKey = dateKey; render(); },
    panel: () => container.querySelector('.day-panel'),
    toggle: () => container.querySelector('.day-panel-toggle'),
    body: () => container.querySelector('.day-panel-body'),
    collapsed: () => container.querySelector('.day-panel').classList.contains('is-collapsed')
  };
}

describe('Day panel - collapsing the selected day', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  it('has a header button with a chevron, the date, and its count; the total and add button beside it', () => {
    const page = createPage();
    const header = page.container.querySelector('.day-panel-header');
    assert.deepEqual(header.childNodes.map((n) => n.className), ['day-panel-heading', 'day-panel-side']);
    const toggle = page.toggle();
    assert.equal(toggle.parentNode.localName, 'h3');
    assert.deepEqual(toggle.childNodes.map((n) => n.getAttribute('class')), ['day-panel-chevron', 'day-panel-titles']);
    assert.equal(toggle.querySelector('.day-panel-title').textContent, 'Day, 19 October 2026');
    assert.equal(toggle.querySelector('.day-panel-meta').textContent, '3 worklogs \u2022 3h 00m total');
    assert.equal(toggle.querySelector('button'), null, 'no button in the button');
    assert.equal(toggle.getAttribute('aria-controls'), 'selectedDayBody');
    assert.equal(page.body().id, 'selectedDayBody');
    assert.equal(header.querySelector('.day-panel-total').textContent, '3h 00m');
    assert.ok(header.querySelector('.day-panel-side').querySelector('.day-add-btn'));
  });

  it('starts collapsed, with the worklogs hidden', () => {
    const page = createPage();
    assert.equal(page.toggle().getAttribute('aria-expanded'), 'false');
    assert.ok(page.collapsed());
    assert.ok(page.body().classList.contains('hidden'));
    assert.equal(page.body().querySelectorAll('.worklog-item').length, 3);
  });

  it('expands and collapses from the header button, keeping the header, count, and total', () => {
    const page = createPage();
    const list = page.body().querySelector('.worklog-list');
    page.toggle().click();
    assert.equal(page.toggle().getAttribute('aria-expanded'), 'true');
    assert.ok(!page.collapsed());
    assert.ok(!page.body().classList.contains('hidden'));
    page.toggle().click();
    assert.equal(page.toggle().getAttribute('aria-expanded'), 'false');
    assert.ok(page.collapsed());
    assert.ok(page.body().classList.contains('hidden'));
    assert.equal(page.container.querySelector('.day-panel-meta').textContent, '3 worklogs \u2022 3h 00m total');
    assert.equal(page.container.querySelector('.day-panel-total').textContent, '3h 00m');
    assert.equal(page.container.querySelector('.day-card[data-date-key="2026-10-19"]').querySelector('.day-duration').textContent, '3h 00m');

    page.toggle().click();
    assert.ok(!page.collapsed());
    assert.equal(page.body().querySelector('.worklog-list'), list, 'the same worklogs, in place');
    assert.deepEqual(page.calls.toggled, [true, false, true]);
  });

  it('toggles from a click on the total, but never from the add button, collapsed or not', () => {
    const page = createPage();
    page.container.querySelector('.day-panel-total').click();
    assert.ok(!page.collapsed());

    page.container.querySelector('.day-add-btn').click();
    assert.ok(!page.collapsed(), 'still expanded');
    page.toggle().click();
    page.container.querySelector('.day-add-btn').click();
    assert.ok(page.collapsed(), 'still collapsed');
    assert.deepEqual(page.calls.added, ['2026-10-19', '2026-10-19']);
    assert.equal(page.calls.toggled.length, 2);
  });

  it('keeps edit and delete working, without toggling', () => {
    const page = createPage();
    page.toggle().click();
    page.calls.toggled.length = 0;
    page.body().querySelector('.worklog-edit-btn').click();
    page.body().querySelector('.worklog-delete-btn').click();
    assert.deepEqual(page.calls.edited, ['1']);
    assert.deepEqual(page.calls.deleted, ['1']);
    assert.deepEqual(page.calls.toggled, []);
  });

  it('has one state for every day: expanding or collapsing one does it for all', () => {
    const page = createPage();
    page.toggle().click(); // expanded on Monday
    page.select('2026-10-20');
    assert.ok(!page.collapsed(), 'Tuesday expanded too');
    assert.equal(page.body().querySelectorAll('.worklog-item').length, 1);
    page.select('2026-10-21');
    assert.ok(!page.collapsed(), 'a day with no worklogs too');
    assert.equal(page.container.querySelector('.day-panel-meta').textContent, '0 worklogs \u2022 0h 00m total');

    page.toggle().click(); // collapsed on Wednesday
    page.select('2026-10-19');
    assert.ok(page.collapsed(), 'Monday collapsed too');
    page.select('2026-10-20');
    assert.ok(page.collapsed());
  });

  it('keeps the state through a re-render (an edit or delete reloads the week)', () => {
    const page = createPage();
    page.toggle().click();
    page.render();
    assert.ok(!page.collapsed());
    assert.equal(page.toggle().getAttribute('aria-expanded'), 'true');
  });

  it('keeps the state in other weeks', () => {
    const page = createPage();
    page.toggle().click();
    page.goToWeek(NEXT_WEEK, '2026-10-26');
    assert.ok(!page.collapsed());
    assert.equal(page.body().querySelectorAll('.worklog-item').length, 2);
    page.toggle().click();
    page.goToWeek(WEEK, '2026-10-19');
    assert.ok(page.collapsed());
  });

  it('remembers the state when the tab is opened again', () => {
    const first = createPage();
    first.toggle().click();
    assert.equal(first.storage.get('jts-day-panel-expanded'), 'true');
    const reopened = createPage(first.storage);
    assert.ok(!reopened.collapsed());
    reopened.toggle().click();
    assert.equal(reopened.storage.get('jts-day-panel-expanded'), 'false');
    assert.ok(createPage(reopened.storage).collapsed());
  });

  it('starts collapsed and still expands without the page keeping the state', () => {
    const container = h('div', {});
    renderWeek(container, WEEK, { selectedDateKey: '2026-10-20', onSelectDay: () => {} });
    assert.ok(container.querySelector('.day-panel').classList.contains('is-collapsed'));
    container.querySelector('.day-panel-toggle').click();
    assert.ok(!container.querySelector('.day-panel').classList.contains('is-collapsed'));
  });
});

describe('Day panel - page and styles', () => {
  const options = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');

  it('keeps one state for every day in localStorage, as My Active Issues does: collapsed until expanded', () => {
    assert.match(options, /\nlet isDayPanelExpanded = localStorage\.getItem\('jts-day-panel-expanded'\) === 'true';\n/);
    const start = options.indexOf('function renderDays(');
    const fn = options.slice(start, options.indexOf('\n}\n', start));
    assert.match(fn, /dayExpanded: isDayPanelExpanded,\s*onToggleDay: \(expanded\) => \{\s*isDayPanelExpanded = expanded;\s*localStorage\.setItem\('jts-day-panel-expanded', String\(expanded\)\);/);
  });

  it('shares My Active Issues\' chevron, turned while collapsed', () => {
    assert.match(css, /\.working-issues-chevron,\n\.day-panel-chevron \{\s*flex-shrink: 0;\s*width: 16px;\s*height: 16px;/);
    assert.match(css, /\.working-issues\.is-collapsed \.working-issues-chevron,\n\.day-panel\.is-collapsed \.day-panel-chevron \{\s*transform: rotate\(-90deg\);/);
  });

  it('adds no padding of its own to the header', () => {
    const rule = css.match(/\n\.day-panel-toggle \{([^}]*)\}/)[1];
    assert.match(rule, /padding: 0;/);
    assert.match(rule, /align-items: center;/);
  });
});
