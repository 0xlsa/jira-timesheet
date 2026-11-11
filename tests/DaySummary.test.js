import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './support/fakeDom.js';
import { renderWeek } from '../src/ui/weekView.js';
import { h } from '../src/ui/dom.js';
import { aggregateWorklogsByWeek, getWeekDays } from '../src/worklog/worklogUtils.js';
import { removeWorklogFromWeek, replaceWorklogInWeek } from '../src/worklog/weeklyWorklogService.js';
import { summarizeByIssue, wholePercentages } from '../src/worklog/timeDistribution.js';

const MINUTE = 60;
const HOUR = 3600;
const wl = (id, issueKey, seconds, extra = {}) => ({ id, issueId: `9${id}`, issueKey, issueSummary: `About ${issueKey}`, timeSpentSeconds: seconds, ...extra });

describe('Summary - time by issue', () => {
  it('groups by issue, most time first, with whole percentages that add up to 100', () => {
    // EKB-31139 in two worklogs (3h + 1h 30m).
    const { issues, totalSeconds } = summarizeByIssue([
      wl('1', 'EKB-31139', 3 * HOUR, { issueSummary: 'Bind Consul only to the overlay network' }),
      wl('2', 'EKB-30668', 45 * MINUTE),
      wl('3', 'EKB-30767', 3 * HOUR + 10 * MINUTE),
      wl('4', 'EKB-31086', HOUR + 45 * MINUTE),
      wl('5', 'EKB-31139', HOUR + 30 * MINUTE, { issueSummary: 'Bind Consul only to the overlay network' })
    ]);
    assert.deepEqual(issues.map((i) => [i.issueKey, i.formattedDuration, i.percent]), [
      ['EKB-31139', '4h 30m', 44],
      ['EKB-30767', '3h 10m', 31],
      ['EKB-31086', '1h 45m', 17],
      ['EKB-30668', '0h 45m', 8]
    ]);
    assert.equal(issues[0].issueSummary, 'Bind Consul only to the overlay network');
    assert.equal(totalSeconds, 10 * HOUR + 10 * MINUTE);
  });

  it('rounds consistently: the leftover points go to the largest remainders, the earlier first on a tie', () => {
    assert.deepEqual(wholePercentages([1, 1, 1]), [34, 33, 33]);
    assert.deepEqual(wholePercentages([2, 1]), [67, 33]);
    assert.deepEqual(wholePercentages([1, 1, 1, 1, 1, 1, 1]), [15, 15, 14, 14, 14, 14, 14]);
    assert.deepEqual(wholePercentages([0, 5]), [0, 100]);
    assert.deepEqual(wholePercentages([0, 0]), [0, 0]);
    for (const amounts of [[7, 3, 1], [1, 2, 3, 4, 5, 6, 7, 8, 9], [3600, 60, 60, 60]]) {
      assert.equal(wholePercentages(amounts).reduce((a, b) => a + b, 0), 100, amounts.join());
    }
  });

  it('keeps issues with the same time in the order they were logged', () => {
    const { issues } = summarizeByIssue([wl('1', 'B-1', HOUR), wl('2', 'A-1', HOUR), wl('3', 'C-1', HOUR)]);
    assert.deepEqual(issues.map((i) => [i.issueKey, i.percent]), [['B-1', 34], ['A-1', 33], ['C-1', 33]]);
  });

  it('gives a single issue 100%', () => {
    const { issues } = summarizeByIssue([wl('1', 'KAN-1', HOUR), wl('2', 'KAN-1', 30 * MINUTE)]);
    assert.deepEqual(issues.map((i) => [i.issueKey, i.formattedDuration, i.percent]), [['KAN-1', '1h 30m', 100]]);
  });

  it('handles empty days, missing issue details, and invalid durations', () => {
    assert.deepEqual(summarizeByIssue([]), { issues: [], totalSeconds: 0 });
    assert.deepEqual(summarizeByIssue(undefined), { issues: [], totalSeconds: 0 });
    const { issues, totalSeconds } = summarizeByIssue([
      null,
      wl('1', '', HOUR, { issueId: '77', issueSummary: 'No summary available' }),
      wl('2', '', 30 * MINUTE, { issueId: '77', issueSummary: 'Known by its ID' }),
      wl('3', undefined, 15 * MINUTE, { issueId: '', issueSummary: '' }),
      wl('4', 'KAN-2', Number.NaN),
      wl('5', 'KAN-2', -600),
      wl('6', 'KAN-2', '1800'),
      wl('7', 'KAN-3', undefined)
    ]);
    assert.deepEqual(issues.map((i) => [i.id, i.issueKey, i.issueSummary, i.seconds, i.percent]), [
      ['id:77', '', 'Known by its ID', 90 * MINUTE, 67],
      ['KAN-2', 'KAN-2', 'About KAN-2', 30 * MINUTE, 22],
      ['', '', 'No summary available', 15 * MINUTE, 11],
      ['KAN-3', 'KAN-3', 'About KAN-3', 0, 0]
    ]);
    assert.equal(totalSeconds, 135 * MINUTE);
  });
});

// A week from Jira worklogs, as the page keeps it (week.sourceWorklogs), Mon Oct 26 to Sun Nov 1.
const MONDAY = new Date(2026, 9, 26);
const at = (date, time) => `${date}T${time}:00`;
const SOURCE = [
  { id: '1', issueId: '31139', issueKey: 'EKB-31139', issueSummary: 'Bind Consul only to the overlay network', started: at('2026-10-27', '08:00'), timeSpentSeconds: 3 * HOUR },
  { id: '2', issueId: '30767', issueKey: 'EKB-30767', issueSummary: 'Meetings and internal calls', started: at('2026-10-27', '11:00'), timeSpentSeconds: 3 * HOUR + 10 * MINUTE },
  { id: '3', issueId: '31086', issueKey: 'EKB-31086', issueSummary: 'CVE-2026-98432 - Linux kernel remote root compromise for TCP connection with multipath', started: at('2026-10-27', '14:10'), timeSpentSeconds: HOUR + 45 * MINUTE },
  { id: '4', issueId: '31139', issueKey: 'EKB-31139', issueSummary: 'Bind Consul only to the overlay network', started: at('2026-10-27', '15:55'), timeSpentSeconds: HOUR + 30 * MINUTE },
  { id: '5', issueId: '30668', issueKey: 'EKB-30668', issueSummary: 'Upgrade from 25.5.0 to feature branches fails on service after reboot', started: at('2026-10-27', '17:25'), timeSpentSeconds: 45 * MINUTE },
  { id: '6', issueId: '9', issueKey: 'KAN-9', issueSummary: 'Only one issue today', started: at('2026-10-28', '09:00'), timeSpentSeconds: HOUR },
  { id: '7', issueId: '9', issueKey: 'KAN-9', issueSummary: 'Only one issue today', started: at('2026-10-28', '13:00'), timeSpentSeconds: 2 * HOUR }
];
const weekOf = (source) => ({ sourceWorklogs: source, ...aggregateWorklogsByWeek(source, getWeekDays(MONDAY)) });

/** The page as options.js runs it: the selected day and its tab, kept while it's open. */
function createPage() {
  const container = h('div', {});
  const calls = { tabs: [] };
  let week = weekOf(SOURCE);
  let selectedDateKey = '2026-10-27';
  let dayTab = 'worklogs';
  const render = () => renderWeek(container, week, {
    selectedDateKey,
    baseUrl: 'https://acme.atlassian.net',
    onSelectDay: (dateKey) => { selectedDateKey = dateKey; render(); },
    onAddWorklog: () => {},
    onEditWorklog: () => {},
    onDeleteWorklog: () => {},
    dayExpanded: true,
    dayTab,
    onSelectDayTab: (tab) => { calls.tabs.push(tab); dayTab = tab; }
  });
  render();
  const q = (selector) => container.querySelector(selector);
  return {
    container, calls, q,
    update: (next) => { week = next(week); render(); },
    select: (dateKey) => q(`.day-card[data-date-key="${dateKey}"]`).click(),
    tabs: () => container.querySelectorAll('.day-tab'),
    tab: (id) => q(`#dayTab-${id}`),
    worklogsPanel: () => q('#selectedDayWorklogs'),
    summaryPanel: () => q('#selectedDaySummary'),
    rows: () => q('#selectedDaySummary').querySelectorAll('.day-summary-item').map((item) => [
      item.querySelector('.issue-key-badge').textContent,
      item.querySelector('.day-summary-title').textContent,
      item.querySelector('.day-summary-duration').textContent,
      item.querySelector('.day-summary-share').textContent
    ])
  };
}

const shown = (el) => !el.classList.contains('hidden');

describe('Day panel - Worklogs and Summary tabs', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  it('puts the two tabs below the header, Worklogs selected, each with its count', () => {
    const page = createPage();
    const body = page.q('.day-panel-body');
    assert.deepEqual(body.children.map((el) => el.id || el.className), ['day-tabs', 'selectedDayWorklogs', 'selectedDaySummary']);
    assert.equal(page.q('.day-tabs').getAttribute('role'), 'tablist');
    assert.deepEqual(page.tabs().map((t) => t.textContent), ['Worklogs (5)', 'Summary (4)']);
    assert.deepEqual(page.tabs().map((t) => [t.getAttribute('aria-selected'), t.getAttribute('tabindex'), t.getAttribute('aria-controls')]),
      [['true', '0', 'selectedDayWorklogs'], ['false', '-1', 'selectedDaySummary']]);
    assert.ok(shown(page.worklogsPanel()));
    assert.ok(!shown(page.summaryPanel()));
    // The header is outside the tabs, and the total is in it only.
    assert.equal(page.q('.day-panel-header').parentNode, page.q('.day-panel'));
    assert.equal(page.container.querySelectorAll('.day-panel-total').length, 1);
    assert.equal(page.summaryPanel().textContent.includes('10h 10m'), false);
  });

  it('shows the worklogs one by one in the Worklogs tab, as before', () => {
    const page = createPage();
    const items = page.worklogsPanel().querySelectorAll('.worklog-item');
    assert.deepEqual(items.map((item) => item.querySelector('.issue-key-badge').textContent), ['EKB-31139', 'EKB-30767', 'EKB-31086', 'EKB-31139', 'EKB-30668']);
    assert.ok(items.every((item) => item.querySelector('.worklog-edit-btn') && item.querySelector('.worklog-delete-btn')));
  });

  it('switches tabs in place, without drawing the page again, and remembers the choice', () => {
    const page = createPage();
    const list = page.q('.worklog-list');
    page.tab('summary').click();
    assert.deepEqual(page.calls.tabs, ['summary']);
    assert.ok(shown(page.summaryPanel()));
    assert.ok(!shown(page.worklogsPanel()));
    assert.deepEqual(page.tabs().map((t) => t.getAttribute('aria-selected')), ['false', 'true']);
    assert.ok(page.tab('summary').classList.contains('is-selected'));
    assert.ok(page.q('.worklog-list') === list, 'the worklogs are the same elements');
    // Choosing the selected tab again changes nothing.
    page.tab('summary').click();
    assert.deepEqual(page.calls.tabs, ['summary']);
    page.tab('worklogs').click();
    assert.deepEqual(page.calls.tabs, ['summary', 'worklogs']);
    assert.ok(shown(page.worklogsPanel()));
  });

  it('moves between tabs with the arrow keys, Home, and End, but not with a modifier', () => {
    const page = createPage();
    const key = (k, extra = {}) => page.tab('worklogs').dispatchEvent({ type: 'keydown', key: k, ...extra });
    key('ArrowRight');
    assert.ok(shown(page.summaryPanel()));
    assert.ok(page.container.ownerDocument.activeElement === page.tab('summary'), 'focus follows');
    key('ArrowRight');
    assert.ok(shown(page.worklogsPanel()), 'wraps around');
    key('End');
    assert.ok(shown(page.summaryPanel()));
    key('Home');
    assert.ok(shown(page.worklogsPanel()));
    key('ArrowRight', { ctrlKey: true });
    key('ArrowLeft', { metaKey: true });
    assert.ok(shown(page.worklogsPanel()), 'Ctrl/⌘+arrows are the day shortcuts');
  });

  it('sums each issue\'s worklogs in the Summary, with its key, title, time, and share', () => {
    const page = createPage();
    page.tab('summary').click();
    assert.deepEqual(page.rows(), [
      ['EKB-31139', 'Bind Consul only to the overlay network', '4h 30m', '44%'],
      ['EKB-30767', 'Meetings and internal calls', '3h 10m', '31%'],
      ['EKB-31086', 'CVE-2026-98432 - Linux kernel remote root compromise for TCP connection with multipath', '1h 45m', '17%'],
      ['EKB-30668', 'Upgrade from 25.5.0 to feature branches fails on service after reboot', '0h 45m', '8%']
    ]);
    // The full title stays in reach, in the tooltip too.
    const titles = page.summaryPanel().querySelectorAll('.day-summary-title');
    assert.ok(titles.every((t) => t.getAttribute('title') === t.textContent));
    // The bar: one part per issue, as wide as its time, in the list's colors.
    const bar = page.summaryPanel().querySelector('.day-summary-bar');
    assert.equal(bar.getAttribute('role'), 'img');
    assert.equal(bar.getAttribute('aria-label'), 'Time by issue: EKB-31139 44%, EKB-30767 31%, EKB-31086 17%, EKB-30668 8%');
    const segments = bar.querySelectorAll('.day-summary-segment');
    assert.deepEqual(segments.map((s) => s.getAttribute('style')), ['flex-grow: 16200', 'flex-grow: 11400', 'flex-grow: 6300', 'flex-grow: 2700']);
    assert.deepEqual(segments.map((s) => s.getAttribute('title')), ['EKB-31139 · 4h 30m · 44%', 'EKB-30767 · 3h 10m · 31%', 'EKB-31086 · 1h 45m · 17%', 'EKB-30668 · 0h 45m · 8%']);
    const tones = (selector) => page.summaryPanel().querySelectorAll(selector).map((el) => el.className.split(' ').find((c) => c.startsWith('is-tone-')));
    assert.deepEqual(tones('.day-summary-segment'), ['is-tone-1', 'is-tone-2', 'is-tone-3', 'is-tone-4']);
    assert.deepEqual(tones('.day-summary-swatch'), tones('.day-summary-segment'));
    assert.equal(page.summaryPanel().querySelector('.day-summary-item').querySelector('.issue-key-badge').getAttribute('href'), 'https://acme.atlassian.net/browse/EKB-31139');
  });

  it('keeps the selected tab when another day is selected, and shows 100% for a single issue', () => {
    const page = createPage();
    page.tab('summary').click();
    page.select('2026-10-28');
    assert.ok(page.tab('summary').classList.contains('is-selected'));
    assert.ok(shown(page.summaryPanel()));
    assert.deepEqual(page.tabs().map((t) => t.textContent), ['Worklogs (2)', 'Summary (1)']);
    assert.deepEqual(page.rows(), [['KAN-9', 'Only one issue today', '3h 00m', '100%']]);
    assert.equal(page.summaryPanel().querySelectorAll('.day-summary-segment').length, 1);
  });

  it('shows an empty state in both tabs on a day without worklogs', () => {
    const page = createPage();
    page.select('2026-10-29');
    assert.deepEqual(page.tabs().map((t) => t.textContent), ['Worklogs (0)', 'Summary (0)']);
    assert.equal(page.worklogsPanel().querySelector('.empty-day-placeholder').textContent, 'No worklogs logged for this day.');
    assert.equal(page.summaryPanel().querySelector('.empty-day-placeholder').textContent, 'No time logged for this day.');
    assert.equal(page.summaryPanel().querySelector('.day-summary-bar'), null);
  });

  it('follows worklogs created, edited, and deleted', () => {
    const page = createPage();
    page.tab('summary').click();
    // Created: 2h 50m more on EKB-30668 makes it 3h 35m.
    page.update((week) => replaceWorklogInWeek(week, { ...SOURCE[4], id: '8', started: at('2026-10-27', '18:10'), timeSpentSeconds: 2 * HOUR + 50 * MINUTE }));
    assert.ok(shown(page.summaryPanel()), 'still on Summary');
    assert.deepEqual(page.rows().map((r) => [r[0], r[2], r[3]]), [
      ['EKB-31139', '4h 30m', '35%'], ['EKB-30668', '3h 35m', '28%'], ['EKB-30767', '3h 10m', '24%'], ['EKB-31086', '1h 45m', '13%']
    ]);
    assert.equal(page.q('.day-panel-total').textContent, '13h 00m');
    // Edited: EKB-31139's 3h becomes 1h.
    page.update((week) => replaceWorklogInWeek(week, { ...SOURCE[0], timeSpentSeconds: HOUR }));
    assert.deepEqual(page.rows().map((r) => [r[0], r[2], r[3]]), [
      ['EKB-30668', '3h 35m', '32%'], ['EKB-30767', '3h 10m', '29%'], ['EKB-31139', '2h 30m', '23%'], ['EKB-31086', '1h 45m', '16%']
    ]);
    // Deleted: EKB-31086 is gone from the Summary and its count.
    page.update((week) => removeWorklogFromWeek(week, '3'));
    assert.deepEqual(page.rows().map((r) => r[0]), ['EKB-30668', 'EKB-30767', 'EKB-31139']);
    assert.deepEqual(page.tabs().map((t) => t.textContent), ['Worklogs (5)', 'Summary (3)']);
    assert.equal(page.rows().map((r) => Number.parseInt(r[3], 10)).reduce((a, b) => a + b, 0), 100);
  });

  it('gives issues past the eighth a neutral grey rather than repeat a color', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), issueId: String(i + 1), issueKey: `KAN-${i + 1}`, issueSummary: `Task ${i + 1}`, started: at('2026-10-30', `${String(8 + i).padStart(2, '0')}:00`), timeSpentSeconds: (20 - i) * MINUTE }));
    const container = h('div', {});
    renderWeek(container, weekOf(many), { selectedDateKey: '2026-10-30', onSelectDay: () => {}, dayExpanded: true, dayTab: 'summary' });
    const tones = container.querySelector('#selectedDaySummary').querySelectorAll('.day-summary-swatch').map((el) => el.className.split(' ').find((c) => c.startsWith('is-tone-')));
    assert.deepEqual(tones, ['is-tone-1', 'is-tone-2', 'is-tone-3', 'is-tone-4', 'is-tone-5', 'is-tone-6', 'is-tone-7', 'is-tone-8', 'is-tone-other', 'is-tone-other']);
  });

  it('opens on Worklogs without a selected tab, or with one it doesn\'t know', () => {
    for (const dayTab of [undefined, 'other']) {
      const container = h('div', {});
      renderWeek(container, weekOf(SOURCE), { selectedDateKey: '2026-10-27', onSelectDay: () => {}, dayExpanded: true, dayTab });
      assert.ok(container.querySelector('#dayTab-worklogs').classList.contains('is-selected'), String(dayTab));
      assert.ok(container.querySelector('#selectedDaySummary').classList.contains('hidden'));
    }
  });
});

describe('Day panel tabs - styles', () => {
  const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
  const rule = (selector) => css.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';

  it('makes the two tabs exactly half the width each, on a subtle line', () => {
    assert.match(rule('.day-tabs'), /display: flex;/);
    assert.match(rule('.day-tabs'), /border-bottom: 1px solid var\(--border-color\);/);
    assert.match(rule('.day-tab'), /flex: 1 1 0;/);
    assert.match(rule('.day-tab'), /min-width: 0;/);
    assert.doesNotMatch(rule('.day-tabs'), /gap/);
    assert.match(rule('.day-tab.is-selected'), /border-bottom-color: currentColor;/);
  });

  it('lists one issue per row, across the full width, with lines between and the numbers on the right', () => {
    assert.match(rule('.day-summary-list'), /grid-template-columns: auto auto minmax\(0, 1fr\) auto auto;/);
    assert.match(rule('.day-summary-item'), /grid-column: 1 \/ -1;/);
    assert.match(rule('.day-summary-item'), /grid-template-columns: subgrid;/);
    assert.match(rule('.day-summary-item + .day-summary-item'), /border-top: 1px solid var\(--border-subtle\);/);
    assert.match(rule('.day-summary-title'), /text-overflow: ellipsis;/);
    assert.match(rule('.day-summary-duration'), /text-align: right;/);
    assert.match(rule('.day-summary-share'), /text-align: right;/);
  });

  it('defines every Summary color in both themes', () => {
    const [dark, light] = [css.match(/:root \{([^}]*)\}/)[1], css.match(/\[data-theme="light"\] \{([^}]*)\}/)[1]];
    for (const name of ['1', '2', '3', '4', '5', '6', '7', '8', 'other']) {
      assert.match(dark, new RegExp(`--summary-${name}: #[0-9a-f]{6};`), `dark ${name}`);
      assert.match(light, new RegExp(`--summary-${name}: #[0-9a-f]{6};`), `light ${name}`);
    }
  });
});
