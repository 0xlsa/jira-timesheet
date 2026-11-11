import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './support/fakeDom.js';
import { formatWeekSpan, renderWeek } from '../src/ui/weekView.js';
import { h } from '../src/ui/dom.js';
import { aggregateWorklogsByWeek, buildEmptyWeek, getWeekDays } from '../src/worklog/worklogUtils.js';
import { removeWorklogFromWeek, replaceWorklogInWeek } from '../src/worklog/weeklyWorklogService.js';

const HOUR = 3600;
const MINUTE = 60;
const MONDAY = new Date(2026, 9, 26);
const NEXT_MONDAY = new Date(2026, 10, 2);
const at = (date, time) => `${date}T${time}:00`;
const wl = (id, issueKey, started, seconds, extra = {}) => ({ id, issueId: `9${id}`, issueKey, issueSummary: `About ${issueKey}`, started, timeSpentSeconds: seconds, ...extra });

// Mon Oct 26 to Sun Nov 1, 2026: EKB-1 on three days, EKB-2 on two, a worklog without a key, and
// nothing on Wednesday or the weekend. The worklog on Mon Nov 2 is the next week's.
const SOURCE = [
  wl('1', 'EKB-1', at('2026-10-26', '09:00'), 3 * HOUR),
  wl('2', 'EKB-2', at('2026-10-26', '13:00'), HOUR),
  wl('3', 'EKB-1', at('2026-10-27', '09:00'), 2 * HOUR),
  wl('4', 'EKB-3', at('2026-10-27', '14:00'), 30 * MINUTE),
  wl('5', 'EKB-2', at('2026-10-29', '10:00'), HOUR + 30 * MINUTE),
  wl('6', 'EKB-1', at('2026-10-30', '09:00'), HOUR),
  wl('7', '', at('2026-10-30', '11:00'), 30 * MINUTE, { issueId: '77', issueSummary: 'An issue without its key' }),
  wl('8', 'EKB-1', at('2026-11-02', '09:00'), 5 * HOUR)
];
const weekOf = (monday, source) => ({ sourceWorklogs: source, ...aggregateWorklogsByWeek(source, getWeekDays(monday)) });

/** The page as options.js runs it: the week, the selected day, its tab, and the view. */
function createPage({ monday = MONDAY, source = SOURCE } = {}) {
  const container = h('div', {});
  const calls = { views: [] };
  let week = weekOf(monday, source);
  let selectedDateKey = '2026-10-28';
  let dayTab = 'worklogs';
  let view = 'daily';
  const render = () => renderWeek(container, week, {
    selectedDateKey,
    baseUrl: 'https://acme.atlassian.net',
    onSelectDay: (dateKey) => { selectedDateKey = dateKey; render(); },
    onAddWorklog: () => {},
    onEditWorklog: () => {},
    onDeleteWorklog: () => {},
    dayExpanded: true,
    dayTab,
    onSelectDayTab: (tab) => { dayTab = tab; },
    view,
    onSelectView: (next) => { calls.views.push(next); view = next; },
    workingIssues: { state: { status: 'ready', issues: [] }, expanded: true }
  });
  render();
  const q = (selector) => container.querySelector(selector);
  const weekly = () => q('#weeklySummaryView');
  return {
    container, calls, q, render, weekly,
    update: (next) => { week = next(week); render(); },
    goToWeek: (nextMonday, nextSource = source) => { week = weekOf(nextMonday, nextSource); render(); },
    viewTab: (id) => q(`#viewTab-${id}`),
    daily: () => q('#dailyView'),
    stats: () => weekly().querySelectorAll('.week-summary-stat').map((el) => [el.querySelector('dt').textContent, el.querySelector('dd').textContent]),
    rows: () => weekly().querySelectorAll('.day-summary-item').map((item) => [
      item.querySelector('.issue-key-badge').textContent,
      item.querySelector('.day-summary-duration').textContent,
      item.querySelector('.day-summary-share').textContent
    ]),
    days: () => weekly().querySelectorAll('.week-daily-row').map((row) => [
      row.querySelector('.week-daily-day').textContent,
      row.querySelector('.week-daily-date').textContent,
      row.querySelector('.week-daily-total').textContent,
      row.querySelector('.week-daily-fill')?.getAttribute('style') ?? null,
      row.classList.contains('is-empty')
    ])
  };
}

const shown = (el) => !el.classList.contains('hidden');

describe('Week views - Daily and Weekly Summary', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  it('opens on Daily, with the weekday cards, the day panel, and its own tabs in it', () => {
    const page = createPage();
    // One card for the control and both views; My Work below it.
    assert.deepEqual(page.container.childNodes.map((el) => el.id || el.className), ['week-views', 'workingIssues']);
    assert.deepEqual(page.q('.week-views').childNodes.map((el) => el.id || el.className), ['view-tabs', 'dailyView', 'weeklySummaryView']);
    assert.equal(page.q('.view-tabs').getAttribute('role'), 'tablist');
    assert.deepEqual(page.container.querySelectorAll('.view-tab').map((t) => [t.textContent, t.getAttribute('aria-selected'), t.getAttribute('aria-controls')]),
      [['Daily', 'true', 'dailyView'], ['Weekly Summary', 'false', 'weeklySummaryView']]);
    assert.ok(shown(page.daily()));
    assert.ok(!shown(page.weekly()));
    assert.equal(page.daily().querySelectorAll('.day-card').length, 7);
    assert.ok(page.daily().querySelector('.day-panel'));
    assert.ok(page.daily().querySelector('#dayTab-worklogs') && page.daily().querySelector('#dayTab-summary'), 'Worklogs and Summary stay in Daily');
    assert.equal(page.weekly().querySelector('.day-card'), null, 'no weekday cards in the Weekly Summary');
  });

  it('switches views in place and remembers the choice', () => {
    const page = createPage();
    const panel = page.q('.day-panel');
    page.viewTab('weekly').click();
    assert.deepEqual(page.calls.views, ['weekly']);
    assert.ok(shown(page.weekly()));
    assert.ok(!shown(page.daily()));
    assert.ok(shown(page.q('#workingIssues')), 'My Work stays below either view');
    assert.ok(page.q('.day-panel') === panel, 'Daily is kept as it was');
    page.viewTab('daily').dispatchEvent({ type: 'keydown', key: 'ArrowLeft' });
    assert.ok(shown(page.daily()));
    assert.deepEqual(page.calls.views, ['weekly', 'daily']);
  });

  it('shows the week\'s dates, total time, worklogs, and distinct issues, from that week only', () => {
    const page = createPage();
    assert.equal(page.weekly().querySelector('.week-summary-title').textContent, 'Week: 26 October – 1 November 2026');
    assert.deepEqual(page.stats(), [['Total time', '9h 30m'], ['Worklogs', '7'], ['Jira issues', '4']]);
    assert.ok(page.weekly().querySelector('.week-summary-stat-value').classList.contains('is-time'));
  });

  it('adds up each issue\'s time across the week, with shares that add up to 100%', () => {
    const page = createPage();
    assert.deepEqual(page.rows(), [
      ['EKB-1', '6h 00m', '63%'],
      ['EKB-2', '2h 30m', '27%'],
      ['EKB-3', '0h 30m', '5%'],
      ['No issue key', '0h 30m', '5%']
    ]);
    // The same bar and rows as the selected day's Summary.
    const bar = page.weekly().querySelector('.day-summary-bar');
    assert.deepEqual(bar.querySelectorAll('.day-summary-segment').map((s) => s.getAttribute('style')), ['flex-grow: 21600', 'flex-grow: 9000', 'flex-grow: 1800', 'flex-grow: 1800']);
    assert.deepEqual(page.weekly().querySelectorAll('.week-summary-heading').map((el) => el.textContent), ['Time distribution', 'Daily totals']);
  });

  it('shows all seven days\' totals on one scale, the days without time set apart', () => {
    const page = createPage();
    assert.deepEqual(page.days(), [
      ['Mon', '26 Oct', '4h 00m', 'width: 100.0%', false],
      ['Tue', '27 Oct', '2h 30m', 'width: 62.5%', false],
      ['Wed', '28 Oct', '0h 00m', null, true],
      ['Thu', '29 Oct', '1h 30m', 'width: 37.5%', false],
      ['Fri', '30 Oct', '1h 30m', 'width: 37.5%', false],
      ['Sat', '31 Oct', '0h 00m', null, true],
      ['Sun', '1 Nov', '0h 00m', null, true]
    ]);
  });

  it('handles an empty week', () => {
    const container = h('div', {});
    renderWeek(container, buildEmptyWeek(MONDAY), { selectedDateKey: '2026-10-26', onSelectDay: () => {}, view: 'weekly' });
    const weekly = container.querySelector('#weeklySummaryView');
    assert.ok(shown(weekly));
    assert.deepEqual(weekly.querySelectorAll('.week-summary-stat').map((el) => el.querySelector('dd').textContent), ['0h 00m', '0', '0']);
    assert.ok(weekly.querySelector('.week-summary-stat-value').classList.contains('is-zero'));
    assert.equal(weekly.querySelector('.empty-day-placeholder').textContent, 'No time logged this week.');
    assert.equal(weekly.querySelector('.day-summary-bar'), null);
    const rows = weekly.querySelectorAll('.week-daily-row');
    assert.equal(rows.length, 7);
    assert.ok(rows.every((row) => row.classList.contains('is-empty') && !row.querySelector('.week-daily-fill')));
  });

  it('stays on the Weekly Summary in another week, and shows that week', () => {
    const page = createPage();
    page.viewTab('weekly').click();
    page.goToWeek(NEXT_MONDAY);
    assert.ok(shown(page.weekly()));
    assert.equal(page.weekly().querySelector('.week-summary-title').textContent, 'Week: 2–8 November 2026');
    assert.deepEqual(page.stats(), [['Total time', '5h 00m'], ['Worklogs', '1'], ['Jira issues', '1']]);
    assert.deepEqual(page.rows(), [['EKB-1', '5h 00m', '100%']]);
    // Daily shows the same week.
    assert.equal(page.daily().querySelector('.day-card').getAttribute('data-date-key'), '2026-11-02');
  });

  it('returns to the same day and tab in Daily', () => {
    const page = createPage();
    page.q('.day-card[data-date-key="2026-10-27"]').click();
    page.q('#dayTab-summary').click();
    page.viewTab('weekly').click();
    page.render();
    page.viewTab('daily').click();
    assert.ok(page.q('.day-card[data-date-key="2026-10-27"]').classList.contains('is-selected'));
    assert.ok(page.q('#dayTab-summary').classList.contains('is-selected'));
    assert.ok(shown(page.q('#selectedDaySummary')));
  });

  it('follows worklogs created, edited, and deleted', () => {
    const page = createPage();
    page.viewTab('weekly').click();
    page.update((week) => replaceWorklogInWeek(week, wl('9', 'EKB-4', at('2026-10-28', '09:00'), 2 * HOUR + 30 * MINUTE)));
    assert.deepEqual(page.stats(), [['Total time', '12h 00m'], ['Worklogs', '8'], ['Jira issues', '5']]);
    assert.equal(page.days()[2][2], '2h 30m');
    // EKB-1's 3h on Monday becomes 1h.
    page.update((week) => replaceWorklogInWeek(week, { ...SOURCE[0], timeSpentSeconds: HOUR }));
    assert.deepEqual(page.rows(), [
      ['EKB-1', '4h 00m', '40%'], ['EKB-2', '2h 30m', '25%'], ['EKB-4', '2h 30m', '25%'], ['EKB-3', '0h 30m', '5%'], ['No issue key', '0h 30m', '5%']
    ]);
    assert.deepEqual(page.stats()[0], ['Total time', '10h 00m']);
    page.update((week) => removeWorklogFromWeek(week, '4'));
    assert.deepEqual(page.stats(), [['Total time', '9h 30m'], ['Worklogs', '7'], ['Jira issues', '4']]);
    assert.ok(!page.rows().some((row) => row[0] === 'EKB-3'));
    assert.equal(page.rows().map((row) => Number.parseInt(row[2], 10)).reduce((a, b) => a + b, 0), 100);
  });

  it('writes the week\'s dates in the day panel\'s style', () => {
    assert.equal(formatWeekSpan(new Date(2026, 10, 9), new Date(2026, 10, 15)), '9–15 November 2026');
    assert.equal(formatWeekSpan(new Date(2026, 9, 26), new Date(2026, 10, 1)), '26 October – 1 November 2026');
    assert.equal(formatWeekSpan(new Date(2026, 11, 28), new Date(2027, 0, 3)), '28 December 2026 – 3 January 2027');
  });
});

describe('Week views - styles', () => {
  const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
  const rule = (selector) => css.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';

  it('draws one card around the control and both views, with a line above the selected day', () => {
    assert.match(rule('.week-views'), /border: 1px solid var\(--border-color\);/);
    assert.match(rule('.week-views'), /border-radius: var\(--radius-lg\);/);
    for (const selector of ['.day-panel', '.week-summary']) {
      assert.doesNotMatch(rule(selector), /background|box-shadow|border-radius|border:/, `${selector} has no card of its own`);
    }
    assert.match(rule('.day-panel'), /border-top: 1px solid var\(--border-color\);/);
  });

  it('makes Daily and Weekly Summary exactly half the width each', () => {
    assert.match(rule('.view-tabs'), /display: flex;/);
    assert.doesNotMatch(rule('.view-tabs'), /gap/);
    assert.match(rule('.view-tab'), /flex: 1 1 0;/);
    assert.match(rule('.view-tab'), /min-width: 0;/);
  });

  it('lines up the daily totals and sets the empty days apart', () => {
    assert.match(rule('.week-daily-row'), /grid-template-columns: subgrid;/);
    assert.match(rule('.week-daily-total'), /text-align: right;/);
    assert.match(css, /\.week-daily-row\.is-empty \.week-daily-total \{[^}]*color: var\(--text-muted\);/);
  });
});
