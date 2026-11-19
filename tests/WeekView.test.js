process.env.TZ = 'Europe/London';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument, toHtml } from './support/fakeDom.js';
import { commentParagraphs, renderIssueStatusBadge, renderWorklogItem, renderWeek } from '../src/ui/weekView.js';
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
    assert.deepEqual(container.querySelector('.worklog-list').querySelectorAll('.issue-key-badge').map((el) => el.textContent), ['EKB-301', 'EKB-305']);
    assert.equal(week.formattedWeekTotal, '8h 30m');
  });
});

describe('WeekView - the selected day\'s worklogs in one container', () => {
  let restoreDocument;
  before(() => {
    restoreDocument = installFakeDocument();
  });
  after(() => restoreDocument());

  // Monday 2 November 2026; Wednesday the 4th has several short worklogs, Thursday the 5th one
  // with a long multiline comment, Friday the 6th a single one.
  const monday = new Date(2026, 10, 2);
  const LONG_COMMENT = [
    'Investigated the failing sync job with the customer.',
    '',
    'Paragraph two: the dial plan import stops at the first duplicate, so the remaining rows are never read. '.repeat(4).trim(),
    '- Checked the logs',
    '- Reproduced it locally'
  ].join('\n');
  const IN_PROGRESS = { name: 'In Progress', categoryKey: 'indeterminate' };
  const RAW = [
    { id: '11', issueId: '1', issueKey: 'EKB-1', issueSummary: 'Stand-up', issueStatus: IN_PROGRESS, started: '2026-11-04T09:00:00.000+0000', timeSpentSeconds: 900, comment: 'Daily', author: { displayName: 'Dev One' } },
    { id: '12', issueId: '2', issueKey: 'EKB-2', issueSummary: 'Code review', issueStatus: { name: 'Done', categoryKey: 'done' }, started: '2026-11-04T10:00:00.000+0000', timeSpentSeconds: 2700, author: { displayName: 'Dev One' } },
    { id: '13', issueId: '3', issueKey: 'KAN-3', issueSummary: 'Release notes', issueStatus: null, started: '2026-11-04T14:30:00.000+0000', timeSpentSeconds: 1800, author: { displayName: 'Dev One' } },
    { id: '21', issueId: '4', issueKey: 'EKB-4', issueSummary: 'Sync job', issueStatus: IN_PROGRESS, started: '2026-11-05T09:00:00.000+0000', timeSpentSeconds: 9000, comment: LONG_COMMENT, author: { displayName: 'Dev Two' } },
    { id: '22', issueId: '5', issueKey: 'EKB-5', issueSummary: 'Short follow-up', issueStatus: IN_PROGRESS, started: '2026-11-05T13:00:00.000+0000', timeSpentSeconds: 600, author: { displayName: 'Dev Two' } },
    { id: '31', issueId: '6', issueKey: 'EKB-6', issueSummary: 'Planning', issueStatus: IN_PROGRESS, started: '2026-11-06T09:00:00.000+0000', timeSpentSeconds: 3600, author: { displayName: 'Dev One' } }
  ];
  const week = { user: { displayName: 'Dev One' }, sourceWorklogs: RAW, ...aggregateWorklogsByWeek(RAW, getWeekDays(monday)) };

  function show(selectedDateKey, options = {}) {
    const container = h('div', {});
    const calls = { edited: [], logged: [], deleted: [], added: [] };
    renderWeek(container, week, {
      selectedDateKey, dayExpanded: true, onSelectDay: () => {},
      onAddWorklog: (key) => calls.added.push(key),
      onEditWorklog: (id) => calls.edited.push(id),
      onLogWork: (id) => calls.logged.push(id),
      onDeleteWorklog: (id) => calls.deleted.push(id),
      ...options
    });
    const panel = container.querySelector('.day-panel');
    return { container, panel, calls, items: panel.querySelectorAll('.worklog-item') };
  }

  it('lists several short worklogs in one shared container, each with all its details', () => {
    const { panel, items } = show('2026-11-04');
    const lists = panel.querySelectorAll('.worklog-list');
    assert.equal(lists.length, 1);
    assert.ok(lists[0].parentNode === panel.querySelector('#selectedDayWorklogs'), 'the container is the Worklogs tab\'s');
    assert.ok(lists[0].parentNode.parentNode === panel.querySelector('.day-panel-body'), 'in the panel body');
    assert.equal(items.length, 3);
    assert.ok(items.every((item) => item.parentNode === lists[0]), 'every worklog is a row of the one container');

    assert.deepEqual(items.map((i) => i.querySelector('.issue-key-badge').textContent), ['EKB-1', 'EKB-2', 'KAN-3']);
    assert.deepEqual(items.map((i) => i.querySelector('.issue-status-name')?.textContent ?? null), ['In Progress', 'Done', null]);
    assert.deepEqual(items.map((i) => i.querySelector('.issue-summary').textContent), ['Stand-up', 'Code review', 'Release notes']);
    assert.deepEqual(items.map((i) => i.querySelector('.worklog-duration-badge').textContent), ['0h 15m', '0h 45m', '0h 30m']);
    const day = week.weekDays.find((d) => d.dateKey === '2026-11-04');
    assert.deepEqual(items.map((i) => i.querySelector('.worklog-time').textContent), day.worklogs.map((wl) => `Started ${wl.formattedStartTime}`));
    assert.ok(items.every((i) => i.querySelector('.worklog-author').textContent === 'Dev One'));
    assert.equal(items[0].querySelector('.worklog-comment').textContent, 'Daily');

    // The heading, count, and total are unchanged.
    assert.equal(panel.querySelector('.day-panel-title').textContent, 'Wednesday, 4 November 2026');
    assert.equal(panel.querySelector('.day-panel-meta').textContent, '3 worklogs • 1h 30m total');
    assert.equal(panel.querySelector('.day-panel-total').textContent, '1h 30m');
    assert.ok(panel.querySelector('.day-panel-side').querySelector('.day-add-btn'));
  });

  it('keeps a long multiline comment whole, beside a short worklog', () => {
    const { panel, items } = show('2026-11-05');
    assert.equal(items.length, 2);
    // Its paragraphs (split at the blank line), each with its own lines and list lines as written.
    const paragraphs = items[0].querySelector('.worklog-comment').querySelectorAll('.worklog-comment-paragraph');
    assert.deepEqual(paragraphs.map((p) => p.localName), ['p', 'p']);
    assert.deepEqual(paragraphs.map((p) => p.textContent), LONG_COMMENT.split('\n\n'));
    assert.equal(paragraphs.map((p) => p.textContent).join('\n\n'), LONG_COMMENT, 'nothing left out');
    assert.equal(items[1].querySelector('.worklog-comment'), null);
    assert.equal(panel.querySelector('.day-panel-meta').textContent, '2 worklogs • 2h 40m total');
  });

  it('puts the start time and author below the summary, then the comment, in reading order too', () => {
    const { items } = show('2026-11-05');
    const parts = (item) => item.querySelector('.worklog-body').children.map((el) => el.className);
    assert.deepEqual(parts(items[0]), ['issue-summary', 'worklog-meta-row', 'worklog-comment']);
    assert.deepEqual(parts(items[1]), ['issue-summary', 'worklog-meta-row'], 'nothing below the metadata without a comment');
    assert.match(items[0].querySelector('.worklog-meta-row').textContent, /^Started .+Dev Two$/);
    // The short comment too.
    assert.deepEqual(parts(show('2026-11-04').items[0]), ['issue-summary', 'worklog-meta-row', 'worklog-comment']);
  });

  it('shows a single worklog in the same container', () => {
    const { panel, items } = show('2026-11-06');
    assert.equal(panel.querySelectorAll('.worklog-list').length, 1);
    assert.equal(items.length, 1);
    assert.equal(panel.querySelector('.day-panel-meta').textContent, '1 worklog • 1h 00m total');
  });

  it('keeps the add, log work, edit, and delete actions, and marks the worklog being edited', () => {
    const { panel, items, calls } = show('2026-11-04', { editingWorklogId: '12' });
    assert.ok(items.every((i) => i.querySelector('.worklog-side').querySelector('.worklog-actions')), 'the actions stay in the side column');
    items[1].querySelector('.worklog-log-btn').click();
    items[1].querySelector('.worklog-edit-btn').click();
    items[2].querySelector('.worklog-delete-btn').click();
    panel.querySelector('.day-add-btn').click();
    assert.deepEqual(calls, { edited: ['12'], logged: ['12'], deleted: ['13'], added: ['2026-11-04'] });
    assert.deepEqual(items.map((i) => i.classList.contains('is-editing')), [false, true, false]);
  });
});

describe('WeekView - day worklog container styles', () => {
  const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
  // Every top-level rule for exactly this selector (not in a media query), joined.
  const block = (selector) => {
    const matches = [...css.matchAll(new RegExp(`\\n${selector.replace(/[.+*?^$()[\]{}|\\]/g, '\\$&')} \\{([^}]*)\\}`, 'g'))];
    assert.ok(matches.length > 0, `${selector} is styled`);
    return matches.map((m) => m[1]).join('\n');
  };
  const value = (rules, property) => rules.match(new RegExp(`(?:^|\\n)\\s*${property}:\\s*([^;]+);`))?.[1];

  it('draws one container like a Pending Worklogs group: its border, radius, background, and sides', () => {
    const list = block('.worklog-list');
    const group = block('.working-issues-group');
    for (const property of ['border', 'border-radius', 'background-color']) {
      assert.equal(value(list, property), value(group, property), property);
    }
    assert.equal(value(list, 'padding'), '0 14px');
    assert.equal(value(block('.working-issues-group-body'), 'padding'), '0 14px 4px', 'the groups\' 14px sides');
    assert.equal(value(list, 'gap'), undefined, 'no space between the rows');
  });

  it('gives each worklog no border or background of its own, and a subtle line between two, as pending worklogs', () => {
    const item = block('.worklog-item');
    for (const property of ['border', 'border-radius', 'background-color', 'background', 'box-shadow', 'height', 'max-height', 'overflow']) {
      assert.equal(value(item, property), undefined, property);
    }
    assert.equal(value(block('.worklog-item + .worklog-item'), 'border-top'), value(block('.pending-worklog'), 'border-bottom'));
    assert.equal(value(block('.pending-worklog'), 'border-bottom'), '1px solid var(--border-subtle)');
    assert.doesNotMatch(css, /\.worklog-item:hover/, 'no card hover left');
  });

  it('lets a comment grow its row: whole, with its line breaks', () => {
    const comment = block('.worklog-comment');
    assert.equal(value(comment, 'white-space'), 'pre-wrap');
    assert.equal(value(comment, 'line-height'), '1.45');
    assert.equal(value(comment, 'font-size'), '13px');
    for (const property of ['overflow', 'max-height', '-webkit-line-clamp', 'line-clamp', 'text-overflow']) {
      assert.equal(value(comment, property), undefined, property);
    }
    for (const property of ['overflow', 'max-height', 'display']) {
      assert.equal(value(block('.worklog-comment-paragraph'), property), undefined, property);
    }
  });

  it('keeps rows compact: 8px above and below, a smaller gap between paragraphs, and a narrower issue column', () => {
    assert.equal(value(block('.worklog-item'), 'padding'), '8px 0');
    assert.equal(value(block('.worklog-item'), 'column-gap'), '12px');
    assert.equal(value(block('.worklog-comment-paragraph'), 'margin'), '0');
    assert.equal(value(block('.worklog-comment-paragraph + .worklog-comment-paragraph'), 'margin-top'), '6px');
    assert.equal(value(block('.worklog-issue'), 'min-width'), '100px');
  });

  it('places the metadata on the second row and the comment on the third, 6px below it', () => {
    assert.equal(value(block('.issue-summary'), 'grid-row'), '1');
    assert.equal(value(block('.worklog-meta-row'), 'grid-row'), '2');
    assert.equal(value(block('.worklog-comment'), 'grid-row'), '3');
    assert.equal(value(block('.worklog-comment'), 'margin-top'), '6px');
    // Narrow windows: the summary below the key and duration, then the metadata, then the comment.
    assert.match(css, /\n  \.worklog-meta-row \{\s*grid-column: 1 \/ -1;\s*grid-row: 3;\s*\}\s*\n  \.worklog-comment \{\s*grid-column: 1 \/ -1;\s*grid-row: 4;/);
  });
});

describe('WeekView - comment paragraphs', () => {
  it('splits at blank lines, keeping each paragraph\'s lines, list lines, and indentation', () => {
    assert.deepEqual(commentParagraphs('One line'), ['One line']);
    assert.deepEqual(commentParagraphs('First\nstill first\n\nSecond'), ['First\nstill first', 'Second']);
    assert.deepEqual(commentParagraphs('Steps:\n\n- one\n- two\n\n\n  Indented after'), ['Steps:', '- one\n- two', '  Indented after']);
  });

  it('treats whitespace-only lines and Windows line breaks as breaks, and drops nothing else', () => {
    assert.deepEqual(commentParagraphs('A\r\n\r\nB\r\nb'), ['A', 'B\nb']);
    assert.deepEqual(commentParagraphs('A\n   \t\nB'), ['A', 'B']);
    assert.deepEqual(commentParagraphs(''), []);
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
