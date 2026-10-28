process.env.TZ = 'Europe/London';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument, toHtml } from './support/fakeDom.js';
import { renderIssueStatusBadge, renderWorklogItem, renderWeek } from '../src/ui/weekView.js';
import { h } from '../src/ui/dom.js';
import { buildEmptyWeek, getWeekDays, aggregateWorklogsByWeek } from '../src/worklog/worklogUtils.js';
import { logWork, replaceWorklogInWeek } from '../src/worklog/weeklyWorklogService.js';
import { buildNewWorklog, toNewWorklogForm } from '../src/worklog/worklogEdit.js';


const worklog = (issueStatus) => ({
  issueKey: 'EKB-30755',
  issueSummary: 'Summary',
  issueStatus,
  comment: '',
  formattedStartTime: '09:00',
  formattedDuration: '1h',
  author: { displayName: 'Dev' }
});

describe('WeekView - issue status badge', () => {
  let restoreDocument;
  before(() => {
    restoreDocument = installFakeDocument();
  });
  after(() => restoreDocument());

  it('maps Jira status categories to badge classes', () => {
    assert.match(toHtml(renderIssueStatusBadge({ name: 'To Do', categoryKey: 'new' })), /status-category-new/);
    assert.match(toHtml(renderIssueStatusBadge({ name: 'In Progress', categoryKey: 'indeterminate' })), /status-category-indeterminate/);
    assert.match(toHtml(renderIssueStatusBadge({ name: 'Done', categoryKey: 'done' })), /status-category-done/);
  });

  it('renders custom or uncategorized statuses with the neutral style', () => {
    const html = toHtml(renderIssueStatusBadge({ name: 'Waiting for <Vendor>', categoryKey: 'undefined' }));
    assert.match(html, /status-category-unknown/);
    assert.match(html, /class="issue-status-name">Waiting for &lt;Vendor&gt;</);
    assert.match(html, /title="Status: Waiting for &lt;Vendor&gt;"/);
    assert.doesNotMatch(html, /<Vendor>/);
  });

  it('renders nothing when the status is missing', () => {
    assert.equal(renderIssueStatusBadge(null), null);
    assert.equal(renderIssueStatusBadge(undefined), null);
    assert.equal(renderIssueStatusBadge({ name: '  ', categoryKey: 'done' }), null);
  });

  it('places the status directly after the issue key link', () => {
    const html = toHtml(renderWorklogItem(worklog({ name: 'In Progress', categoryKey: 'indeterminate' }), 'https://jira.example.com/'));
    assert.match(html, /<div class="worklog-issue">\s*<a href="https:\/\/jira.example.com\/browse\/EKB-30755"[^>]*class="issue-key-badge"[\s\S]*?<\/a>\s*<span class="issue-status status-category-indeterminate"/);
  });

  it('keeps the worklog item intact without a status', () => {
    const html = toHtml(renderWorklogItem(worklog(null), 'https://jira.example.com'));
    assert.doesNotMatch(html, /issue-status/);
    assert.match(html, /class="issue-key-badge"/);
    assert.match(html, /class="worklog-duration-badge">1h</);
  });
});

describe('WeekView - status label styles', () => {
  const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
  const variablesIn = (selector) => {
    const block = css.slice(css.indexOf(`${selector} {`));
    return new Set([...block.slice(0, block.indexOf('}')).matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
  };

  it('shows the status name as Jira returns it, without uppercasing or single-line truncation', () => {
    const statusRules = [...css.matchAll(/\.issue-status[^{]*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
    assert.doesNotMatch(statusRules, /text-transform/);
    assert.doesNotMatch(statusRules, /text-overflow:\s*ellipsis/);
  });

  it('uses only theme variables, which the light theme overrides or inherits from :root', () => {
    const rootVars = variablesIn(':root');
    const statusRules = [...css.matchAll(/\.(?:issue-status|status-category-)[^{]*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
    const used = new Set([...statusRules.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));

    assert.ok(used.size > 0);
    for (const variable of used) {
      assert.ok(rootVars.has(variable), `${variable} is not a theme variable`);
    }
    assert.doesNotMatch(statusRules, /#[0-9a-f]{3,8}\b/i, 'status colors should come from theme variables');
  });
});

describe('WeekView - weekday cards, selected-day panel, and add button', () => {
  let restoreDocument;
  before(() => {
    restoreDocument = installFakeDocument();
  });
  after(() => restoreDocument());

  // Monday 26 October 2026
  const monday = new Date(2026, 9, 26);

  it('keeps the original layout: seven weekday cards and one panel for the selected day', () => {
    const container = h('div', {});
    renderWeek(container, buildEmptyWeek(monday, new Date(2026, 9, 28)), { selectedDateKey: '2026-10-28', onSelectDay: () => {} });

    assert.equal(container.querySelector('.week-strip').getAttribute('role'), 'tablist');
    assert.deepEqual(container.querySelectorAll('.day-card').map((c) => c.dataset.dateKey),
      ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    assert.equal(container.querySelectorAll('.day-panel').length, 1);
    assert.equal(container.querySelector('.day-panel-title').textContent, 'Wednesday, 28 October 2026');
    assert.equal(container.querySelector('.day-card.is-selected').dataset.dateKey, '2026-10-28');
  });

  it('puts a circular add button beside the selected day total, labelled with the date', () => {
    const container = h('div', {});
    renderWeek(container, buildEmptyWeek(monday), { selectedDateKey: '2026-10-27', onSelectDay: () => {}, onAddWorklog: () => {} });

    const buttons = container.querySelectorAll('.day-add-btn');
    assert.equal(buttons.length, 1);
    const [button] = buttons;
    assert.equal(button.getAttribute('type'), 'button');
    assert.equal(button.getAttribute('title'), 'Add worklog');
    assert.equal(button.getAttribute('aria-label'), 'Add worklog for Tuesday, 27 October');
    assert.equal(button.dataset.dateKey, '2026-10-27');
    assert.equal(container.querySelector('.day-panel-side').querySelector('.day-add-btn'), button);
    assert.equal(container.querySelector('.day-card').querySelector('.day-add-btn'), null, 'no button inside the day cards');
  });

  it('adds work on whichever day is selected, for every weekday and after moving to another week', () => {
    const container = h('div', {});
    const added = [];
    const render = (weekMonday, selectedDateKey) => renderWeek(container, buildEmptyWeek(weekMonday), {
      selectedDateKey, onSelectDay: () => {}, onAddWorklog: (dateKey) => added.push(dateKey)
    });

    for (const dateKey of ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']) {
      render(monday, dateKey);
      container.querySelector('.day-add-btn').click();
    }
    render(new Date(2026, 10, 2), '2026-11-04');
    container.querySelector('.day-add-btn').click();

    assert.deepEqual(added, ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-04']);
  });

  it('has no add button without a handler (week not loaded)', () => {
    const container = h('div', {});
    renderWeek(container, buildEmptyWeek(monday), { selectedDateKey: '2026-10-26', onSelectDay: () => {} });
    assert.equal(container.querySelector('.day-add-btn'), null);
  });

  it('after logging work on a day, shows it in that day\'s card and panel with the new total', async () => {
    const existing = [
      { id: '1', issueId: '301', issueKey: 'EKB-301', issueSummary: 'Fix authentication', started: '2026-10-27T09:00:00.000+0000', timeSpentSeconds: 7200 },
      { id: '2', issueId: '9', issueKey: 'KAN-9', issueSummary: 'Other day', started: '2026-10-29T09:00:00.000+0000', timeSpentSeconds: 3600 }
    ];
    let week = { user: { displayName: 'Dev' }, sourceWorklogs: existing, ...aggregateWorklogsByWeek(existing, getWeekDays(monday)) };

    // What the page does when the Log work panel opened from Tuesday's + button is saved.
    const client = { createWorklog: async (issueKey, worklog) => ({ id: '3', started: '2026-10-27T13:00:00.000+0000', timeSpentSeconds: worklog.timeSpentSeconds }) };
    const form = { ...toNewWorklogForm({ dateKey: '2026-10-27', now: new Date(2026, 9, 27, 13, 0) }), hours: '5', minutes: '30' };
    const issue = { issueId: '305', issueKey: 'EKB-305', issueSummary: 'Update documentation', issueStatus: null };
    const created = await logWork(client, issue, buildNewWorklog(form), week.user);
    week = replaceWorklogInWeek(week, created);

    const container = h('div', {});
    renderWeek(container, week, { selectedDateKey: '2026-10-27', onSelectDay: () => {}, onAddWorklog: () => {} });

    assert.equal(container.querySelector('.day-card[data-date-key="2026-10-27"]').querySelector('.day-duration').textContent, '7h 30m');
    assert.equal(container.querySelector('.day-card[data-date-key="2026-10-29"]').querySelector('.day-duration').textContent, '1h 00m');
    assert.equal(container.querySelector('.day-panel-total').textContent, '7h 30m');
    assert.deepEqual(container.querySelectorAll('.issue-key-badge').map((el) => el.textContent), ['EKB-301', 'EKB-305']);
    assert.equal(week.formattedWeekTotal, '8h 30m');
  });
});

describe('WeekView - add button styles', () => {
  const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
  const block = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `${selector} is styled`);
    return css.slice(start, css.indexOf('}', start));
  };
  const variablesIn = (selector) => new Set([...block(selector).matchAll(/(--[\w-]+):/g)].map((m) => m[1]));

  it('makes the add button a compact circle with a visible keyboard focus', () => {
    const button = block('.day-add-btn');
    assert.match(button, /border-radius:\s*50%/);
    const [, width] = button.match(/\bwidth:\s*(\d+)px/);
    const [, height] = button.match(/\bheight:\s*(\d+)px/);
    assert.equal(width, height);
    assert.ok(Number(width) >= 28 && Number(width) <= 32);
    assert.match(block('.day-add-btn:focus-visible'), /outline:\s*2px solid var\(--border-focus\)/);
    assert.match(block('.day-add-btn:hover'), /var\(--primary/);
  });

  it('keeps the original weekday card and worklog card layout rules', () => {
    assert.match(block('.week-strip'), /grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\)/);
    assert.match(block('.app-container'), /max-width:\s*820px/);
    assert.match(block('.worklog-item'), /grid-template-columns:\s*auto minmax\(0, 1fr\) auto/);
  });

  it('uses only theme variables for the add button and issue picker, in both themes', () => {
    const rootVars = variablesIn(':root');
    const lightVars = variablesIn('[data-theme="light"]');
    const rules = [...css.matchAll(/\.(?:day-add-btn|day-panel-side|issue-picker)[^{]*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
    const used = new Set([...rules.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));

    assert.ok(used.size > 5);
    for (const variable of used) {
      assert.ok(rootVars.has(variable), `${variable} is not a theme variable`);
    }
    assert.ok(['--bg-card', '--border-color', '--primary-light'].every((v) => lightVars.has(v)));
    assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'colors should come from theme variables');
  });
});
