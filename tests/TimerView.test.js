import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument, toHtml } from './support/fakeDom.js';
import { renderWeek, renderWorkingIssues, updateWorkingIssuesTimer, formatElapsed } from '../src/ui/weekView.js';
import { siteId } from '../src/timer/timeTrackingStore.js';
import { createMemoryStorageArea, createPlatform } from '../src/compat/browser-api.js';
import { buildEmptyWeek } from '../src/worklog/worklogUtils.js';

const SITE = siteId('cloud', 'https://acme.atlassian.net');
const NOW = Date.UTC(2026, 9, 26, 10, 0, 0);

const ISSUES = [
  { issueId: '10012', issueKey: 'KAN-12', issueSummary: 'Fix the login page', issueStatus: { name: 'In Progress', categoryKey: 'indeterminate' } },
  { issueId: '10013', issueKey: 'KAN-13', issueSummary: 'Write the release notes', issueStatus: { name: 'In Review', categoryKey: 'indeterminate' } }
];
const READY = { status: 'ready', issues: ISSUES };

/** A timer running on KAN-12 since 1 hour, 2 minutes, and 3 seconds before NOW. */
const RUNNING_KAN_12 = {
  id: 'r1', site: SITE, issueId: '10012', issueKey: 'KAN-12', issueSummary: 'Fix the login page',
  startedAt: NOW - (3600 + 120 + 3) * 1000
};

function timerOptions(overrides = {}) {
  const calls = { started: [], stopped: 0 };
  return {
    calls,
    timer: {
      site: SITE,
      running: null,
      now: NOW,
      onStart: (issue) => calls.started.push(issue.issueKey),
      onStop: () => calls.stopped++,
      ...overrides
    }
  };
}

// The list, below the header (which has its own timer buttons while a timer runs).
const bodyOf = (section) => section.querySelector('.working-issues-body');
// The row's first timer button: Start, Pause, or Resume.
const timerButton = (section, issueKey) =>
  bodyOf(section).querySelectorAll('.working-issue-timer-btn').find((btn) => btn.dataset.issueKey === issueKey);
// The running issue's Stop button.
const stopButton = (section, issueKey) =>
  bodyOf(section).querySelectorAll('.working-issue-timer-btn').find((btn) => btn.dataset.issueKey === issueKey && btn.dataset.timerAction === 'stop');
// The header's timer controls, and their buttons.
const headerTimerOf = (section) => section.querySelector('.working-issues-timer');
const headerButtons = (section) => headerTimerOf(section).querySelectorAll('.working-issue-timer-btn');

describe('Timer - elapsed time format', () => {
  it('shows hours, minutes, and seconds, two digits each', () => {
    assert.equal(formatElapsed(0), '00:00:00');
    assert.equal(formatElapsed(59), '00:00:59');
    assert.equal(formatElapsed(3723), '01:02:03');
    assert.equal(formatElapsed(36000), '10:00:00');
  });

  it('keeps counting hours past 99, and never shows negative time', () => {
    assert.equal(formatElapsed(100 * 3600 + 5), '100:00:05');
    assert.equal(formatElapsed(-10), '00:00:00');
  });
});

describe('Timer - My Active Issues controls', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  const renderSection = (state, options = {}) => {
    const section = document.createElement('section');
    renderWorkingIssues(section, { state, expanded: true, baseUrl: 'https://acme.atlassian.net', ...options });
    return section;
  };

  it('shows Start on every issue when no timer runs', () => {
    const { timer } = timerOptions();
    const section = renderSection(READY, { timer });

    for (const { issueKey } of ISSUES) {
      const button = timerButton(section, issueKey);
      assert.equal(button.dataset.timerAction, 'start');
      assert.equal(button.getAttribute('aria-label'), `Start a timer on ${issueKey}`);
      assert.equal(button.getAttribute('title'), 'Start timer');
      assert.equal(button.getAttribute('aria-disabled'), null);
    }
    assert.equal(section.querySelector('.working-issue-elapsed'), null);
  });

  it('shows Stop and the elapsed time only on the running issue', () => {
    const { timer } = timerOptions({ running: RUNNING_KAN_12 });
    const section = renderSection(READY, { timer });

    const stop = stopButton(section, 'KAN-12');
    assert.equal(timerButton(section, 'KAN-12').dataset.timerAction, 'pause');
    assert.ok(stop.classList.contains('is-running'));
    assert.equal(stop.getAttribute('aria-label'), 'Stop the timer on KAN-12');
    assert.equal(timerButton(section, 'KAN-13').dataset.timerAction, 'start');

    const elapsed = bodyOf(section).querySelectorAll('.working-issue-elapsed');
    assert.equal(elapsed.length, 1);
    assert.equal(elapsed[0].textContent, '01:02:03');
    assert.ok(stop.parentNode.childNodes.includes(elapsed[0]), 'in the running row');
  });

  it('puts the timer controls before the log work button', () => {
    const { timer } = timerOptions();
    const section = renderSection(READY, { timer, onLogWork: () => {} });
    const row = section.querySelector('.working-issue');
    assert.ok(row.classList.contains('has-timer'));
    assert.deepEqual(row.childNodes.map((n) => n.className),
      ['issue-key-badge', 'working-issue-summary', 'working-issue-status', 'working-issue-timer', 'working-issue-log-btn']);
  });

  it('matches the running issue by site and issue ID, not by key alone', () => {
    const otherSite = { ...RUNNING_KAN_12, site: siteId('server', 'https://jira.example.com') };
    const { timer } = timerOptions({ running: otherSite });
    const section = renderSection(READY, { timer });
    // The connected site's KAN-12 isn't the running issue; the other site's is listed on its own.
    const jiraRow = section.querySelectorAll('.working-issue').find((row) => !row.classList.contains('is-timer-only') && row.querySelector('.issue-key-badge').textContent === 'KAN-12');
    assert.equal(jiraRow.querySelector('.working-issue-timer-btn').dataset.timerAction, 'start');

    // Same site and ID under a new key (the issue moved project): still the running issue.
    const moved = { ...RUNNING_KAN_12, issueKey: 'OLD-7' };
    const section2 = renderSection(READY, timerOptions({ running: moved }));
    assert.ok(stopButton(section2, 'KAN-12'));
  });

  it('calls back with the row issue on Start, and once on Stop, without toggling the section', () => {
    const { timer, calls } = timerOptions({ running: RUNNING_KAN_12 });
    const toggles = [];
    const section = renderSection(READY, { timer, onToggle: (expanded) => toggles.push(expanded) });

    timerButton(section, 'KAN-13').click();
    stopButton(section, 'KAN-12').click();

    assert.deepEqual(calls.started, ['KAN-13']);
    assert.equal(calls.stopped, 1);
    assert.deepEqual(toggles, []);
  });

  it('marks the buttons disabled and ignores clicks while a start or stop is in progress', () => {
    const { timer, calls } = timerOptions({ busy: true });
    const section = renderSection(READY, { timer });

    const button = timerButton(section, 'KAN-12');
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    // aria-disabled, not disabled: the button keeps focus.
    assert.equal(button.getAttribute('disabled'), null);
    button.click();
    assert.deepEqual(calls.started, []);
  });

  it('explains an unavailable timer on the buttons, and still passes the click on for the page to explain', () => {
    const { timer, calls } = timerOptions({ unavailable: 'The timer is turned off.' });
    const section = renderSection(READY, { timer });

    const button = timerButton(section, 'KAN-12');
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(button.getAttribute('title'), 'The timer is turned off.');
    button.click();
    assert.deepEqual(calls.started, ['KAN-12']);
  });

  it('has no timer controls without timer options', () => {
    const section = renderSection(READY, { onLogWork: () => {} });
    assert.equal(section.querySelector('.working-issue-timer-btn'), null);
    assert.equal(section.querySelector('.working-issue.has-timer'), null);
  });

  it('gives focus back to the same issue\'s timer button when the list is rebuilt', () => {
    const section = renderSection(READY, timerOptions());
    timerButton(section, 'KAN-12').focus();

    // The start went through: the row now shows Stop.
    renderWorkingIssues(section, { state: READY, expanded: true, ...timerOptions({ running: RUNNING_KAN_12 }) });

    // The same place now holds Pause, and keeps focus.
    const pause = timerButton(section, 'KAN-12');
    assert.equal(pause.dataset.timerAction, 'pause');
    assert.equal(document.activeElement, pause);
  });
});

describe('Timer - elapsed time updates', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  it('updates the row and header times in place, from the stored start, without rebuilding the list', () => {
    const section = document.createElement('section');
    renderWorkingIssues(section, { state: READY, expanded: true, ...timerOptions({ running: RUNNING_KAN_12 }) });
    const list = section.querySelector('.working-issues-list');
    const rows = section.querySelectorAll('.working-issue');
    const stop = timerButton(section, 'KAN-12');

    updateWorkingIssuesTimer(section, NOW + 57_000);

    assert.equal(bodyOf(section).querySelector('.working-issue-elapsed').textContent, '01:03:00');
    assert.equal(headerTimerOf(section).querySelector('.working-issue-elapsed').textContent, '01:03:00');
    assert.equal(section.querySelector('.working-issues-list'), list);
    assert.deepEqual(section.querySelectorAll('.working-issue'), rows);
    assert.equal(timerButton(section, 'KAN-12'), stop);
  });

  it('does nothing when no timer is shown', () => {
    const section = document.createElement('section');
    renderWorkingIssues(section, { state: READY, expanded: true, ...timerOptions() });
    updateWorkingIssuesTimer(section, NOW);
    assert.equal(section.querySelector('[data-timer-started-at]'), null);
  });
});

describe('Timer - header controls', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  const summaryOf = (section) => section.querySelector('.working-issues-timer-summary');
  function render(running, { expanded = false, state = READY, ...extra } = {}) {
    const calls = [];
    const toggles = [];
    const section = document.createElement('section');
    const options = (r = running, more = {}) => ({
      state, expanded, onToggle: (value) => toggles.push(value),
      ...timerOptions({ running: r, onPause: () => calls.push('pause'), onResume: () => calls.push('resume'), onStop: () => calls.push('stop'), ...extra, ...more })
    });
    renderWorkingIssues(section, options());
    return { section, calls, toggles, rerender: (r, more) => renderWorkingIssues(section, options(r, more)) };
  }

  it('shows the elapsed time, Pause, and Stop at the top right while running, collapsed', () => {
    const { section } = render(RUNNING_KAN_12);
    assert.ok(section.classList.contains('is-collapsed'));
    const controls = headerTimerOf(section);
    assert.ok(!controls.classList.contains('hidden'));
    assert.deepEqual(controls.childNodes.map((n) => n.className),
      ['sr-only', 'working-issue-elapsed', 'working-issue-timer-btn', 'working-issue-timer-btn is-running']);
    assert.equal(controls.textContent, 'Timer running on KAN-12: 01:02:03');
    assert.deepEqual(headerButtons(section).map((b) => [b.dataset.timerAction, b.getAttribute('aria-label')]),
      [['pause', 'Pause the timer on KAN-12'], ['stop', 'Stop the timer on KAN-12']]);
  });

  it('sits beside the header button, not in it, with the timed issue on a line under both', () => {
    const { section } = render(RUNNING_KAN_12);
    const header = section.querySelector('.working-issues-header');
    assert.deepEqual(header.childNodes.map((n) => n.className),
      ['working-issues-heading', 'working-issues-timer', 'working-issues-timer-summary']);
    assert.equal(section.querySelector('.working-issues-toggle').querySelector('button'), null, 'no button in the button');
    assert.equal(header.parentNode, section);
    assert.ok(section.classList.contains('has-timer'));
  });

  it('shows Resume and Stop while paused, with the time standing still', () => {
    const { section } = render({ ...RUNNING_KAN_12, accumulatedMs: 300_000, resumedAt: null });
    assert.deepEqual(headerButtons(section).map((b) => b.dataset.timerAction), ['resume', 'stop']);
    const elapsed = headerTimerOf(section).querySelector('.working-issue-elapsed');
    assert.equal(elapsed.textContent, '00:05:00');
    assert.ok(elapsed.classList.contains('is-paused'));
    assert.equal(headerTimerOf(section).textContent, 'Timer paused on KAN-12: 00:05:00');
    updateWorkingIssuesTimer(section, NOW + 60_000);
    assert.equal(elapsed.textContent, '00:05:00');
  });

  it('keeps the running time current, collapsed', () => {
    const { section } = render(RUNNING_KAN_12);
    updateWorkingIssuesTimer(section, NOW + 1000);
    assert.equal(headerTimerOf(section).querySelector('.working-issue-elapsed').textContent, '01:02:04');
  });

  it('shows the timed issue as "KEY: summary" under the header, and just the key without a summary', () => {
    const { section, rerender } = render(RUNNING_KAN_12);
    assert.ok(!summaryOf(section).classList.contains('hidden'));
    assert.equal(summaryOf(section).textContent, 'KAN-12: Fix the login page');
    assert.equal(summaryOf(section).getAttribute('title'), 'KAN-12: Fix the login page', 'in full when truncated');
    rerender({ ...RUNNING_KAN_12, issueId: '20001', issueKey: 'OPS-4', issueSummary: '' });
    assert.equal(summaryOf(section).textContent, 'OPS-4');
  });

  it('follows the timer to another issue, and is hidden without one', () => {
    const { section, rerender } = render(RUNNING_KAN_12);
    rerender({ ...RUNNING_KAN_12, issueId: '10013', issueKey: 'KAN-13', issueSummary: 'Write the release notes' });
    assert.equal(summaryOf(section).textContent, 'KAN-13: Write the release notes');
    assert.deepEqual(headerButtons(section).map((b) => b.dataset.issueKey), ['KAN-13', 'KAN-13']);

    rerender(null);
    assert.ok(headerTimerOf(section).classList.contains('hidden'));
    assert.equal(headerTimerOf(section).childNodes.length, 0);
    assert.ok(summaryOf(section).classList.contains('hidden'));
    assert.equal(summaryOf(section).textContent, '');
    assert.ok(!section.classList.contains('has-timer'));

    const plain = document.createElement('section');
    renderWorkingIssues(plain, { state: READY, expanded: false });
    assert.ok(headerTimerOf(plain).classList.contains('hidden'));
    assert.ok(summaryOf(plain).classList.contains('hidden'));
  });

  it('shows a timed issue that isn\'t in the list, and one while the issues load', () => {
    const elsewhere = { ...RUNNING_KAN_12, issueId: '20001', issueKey: 'OPS-4', issueSummary: 'Rotate keys' };
    const { section } = render(elsewhere, { state: { status: 'loading' } });
    assert.deepEqual(headerButtons(section).map((b) => b.dataset.issueKey), ['OPS-4', 'OPS-4']);
    assert.equal(summaryOf(section).textContent, 'OPS-4: Rotate keys');
  });

  it('calls the page\'s Pause, Resume, and Stop, without expanding or collapsing the section', () => {
    const running = render(RUNNING_KAN_12);
    headerButtons(running.section)[0].click();
    headerButtons(running.section)[1].click();
    const paused = render({ ...RUNNING_KAN_12, resumedAt: null, accumulatedMs: 1000 }, { expanded: true });
    headerButtons(paused.section)[0].click();
    assert.deepEqual(running.calls, ['pause', 'stop']);
    assert.deepEqual(paused.calls, ['resume']);
    assert.deepEqual([...running.toggles, ...paused.toggles], []);
    assert.ok(running.section.classList.contains('is-collapsed'));
    assert.ok(!paused.section.classList.contains('is-collapsed'));
  });

  it('ignores clicks while busy, and passes them on when unavailable, as the rows do', () => {
    const busy = render(RUNNING_KAN_12, { busy: true });
    assert.deepEqual(headerButtons(busy.section).map((b) => b.getAttribute('aria-disabled')), ['true', 'true']);
    headerButtons(busy.section)[1].click();
    assert.deepEqual(busy.calls, []);

    const off = render(RUNNING_KAN_12, { unavailable: 'The timer is turned off.' });
    assert.equal(headerButtons(off.section)[0].getAttribute('title'), 'The timer is turned off.');
    headerButtons(off.section)[1].click();
    assert.deepEqual(off.calls, ['stop']);
  });

  it('toggles from a click elsewhere in the header, but not from the time between the buttons', () => {
    const { section, toggles } = render(RUNNING_KAN_12);
    headerTimerOf(section).querySelector('.working-issue-elapsed').dispatchEvent({ type: 'click', bubbles: true });
    assert.deepEqual(toggles, []);
    summaryOf(section).dispatchEvent({ type: 'click', bubbles: true });
    assert.deepEqual(toggles, [true]);
    assert.ok(!section.classList.contains('is-collapsed'));
  });

  it('keeps focus from Pause to Resume, and gives it to the header button when the timer stops', () => {
    const { section, rerender } = render(RUNNING_KAN_12);
    headerButtons(section)[0].focus();
    rerender({ ...RUNNING_KAN_12, resumedAt: null, accumulatedMs: 1000 });
    assert.equal(document.activeElement, headerButtons(section)[0]);
    assert.equal(document.activeElement.dataset.timerAction, 'resume');

    headerButtons(section)[1].focus();
    rerender(null);
    assert.equal(document.activeElement, section.querySelector('.working-issues-toggle'));
  });

  it('comes with the section in the weekly view', () => {
    const container = document.createElement('div');
    renderWeek(container, buildEmptyWeek(new Date(2026, 9, 26)), {
      selectedDateKey: '2026-10-26', onSelectDay: () => {},
      workingIssues: { state: READY, expanded: false, ...timerOptions({ running: RUNNING_KAN_12 }) }
    });
    const controls = container.querySelector('#workingIssues').querySelector('.working-issues-timer');
    assert.ok(!controls.classList.contains('hidden'));
  });

  it('is laid out with a grid: controls at the top right, and the timed issue truncating just below them', () => {
    const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
    const rule = (selector) => css.match(new RegExp(`\\n${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`))[1];
    assert.match(rule('.working-issues-header'), /display: grid;\s*grid-template-columns: minmax\(0, 1fr\) auto;/);
    assert.match(css, /\.working-issues\.has-timer \.working-issues-header \{\s*grid-template-columns: minmax\(0, max-content\) minmax\(max-content, 1fr\);/);
    assert.match(rule('.working-issues-timer'), /grid-column: 2;\s*grid-row: 1;/);
    const summary = rule('.working-issues-timer-summary');
    for (const declaration of ['grid-column: 2;', 'grid-row: 2;', 'width: 0;', 'min-width: 100%;', 'overflow: hidden;', 'text-align: right;', 'text-overflow: ellipsis;', 'white-space: nowrap;']) {
      assert.ok(summary.includes(declaration), declaration);
    }
    assert.doesNotMatch(css, /working-issues-timer[^{]*\{[^}]*position: absolute/);
  });
});

describe('browser-api - storage changes', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('reports set and remove on the in-memory area, with old and new values, after the change', async () => {
    const area = createMemoryStorageArea({ a: 1 });
    const seen = [];
    const readsInListener = [];
    area.onChanged.addListener((changes) => {
      seen.push(changes);
      // The change is already in place when listeners hear of it.
      area.get('a').then((value) => readsInListener.push(value));
    });

    await area.set({ a: 2, b: 3 });
    await settle();
    await area.remove(['a', 'missing']);
    await settle();

    assert.deepEqual(seen, [
      { a: { oldValue: 1, newValue: 2 }, b: { newValue: 3 } },
      { a: { oldValue: 2 } }
    ]);
    assert.deepEqual(readsInListener, [{ a: 2 }, {}]);
  });

  it('stops reporting to a removed listener', async () => {
    const area = createMemoryStorageArea();
    let calls = 0;
    const listener = () => calls++;
    area.onChanged.addListener(listener);
    area.onChanged.removeListener(listener);
    await area.set({ a: 1 });
    await settle();
    assert.equal(calls, 0);
  });

  it('watches the browser\'s storage.onChanged for local changes only, and can stop', () => {
    const listeners = new Set();
    const api = {
      storage: {
        local: createMemoryStorageArea(),
        onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) }
      }
    };
    const platform = createPlatform(api, {});
    const seen = [];

    const stop = platform.watchStorage((changes) => seen.push(changes));
    for (const fn of listeners) {
      fn({ timeTracking: { newValue: 1 } }, 'local');
      fn({ timeTracking: { newValue: 2 } }, 'sync');
      fn({ timeTracking: { newValue: 3 } }, 'session');
    }
    stop();

    assert.deepEqual(seen, [{ timeTracking: { newValue: 1 } }]);
    assert.equal(listeners.size, 0);
  });

  it('watches the in-memory area outside an extension', async () => {
    const platform = createPlatform(null, {});
    const seen = [];
    const stop = platform.watchStorage((changes) => seen.push(Object.keys(changes)));

    await platform.storage.set({ timeTracking: {} });
    await settle();
    stop();
    await platform.storage.set({ timeTracking: { version: 1 } });
    await settle();

    assert.deepEqual(seen, [['timeTracking']]);
  });
});

describe('Timer - running issue missing from the list', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  // Started from the Log work panel: not in progress, not logged this week, so Jira doesn't list it.
  const RUNNING_KAN_10 = { id: 'r2', site: SITE, issueId: '10010', issueKey: 'KAN-10', issueSummary: 'Update the onboarding guide', startedAt: NOW - 203_000 };
  const rowsOf = (section) => section.querySelectorAll('.working-issue');
  const keysOf = (section) => rowsOf(section).map((row) => row.querySelector('.issue-key-badge').textContent);

  it('lists the running issue first, from the timer\'s record, with Stop and its elapsed time', () => {
    const section = document.createElement('section');
    renderWorkingIssues(section, { state: READY, expanded: true, baseUrl: 'https://acme.atlassian.net', onLogWork: () => {}, ...timerOptions({ running: RUNNING_KAN_10 }) });

    assert.deepEqual(keysOf(section), ['KAN-10', 'KAN-12', 'KAN-13']);
    const row = rowsOf(section)[0];
    assert.ok(row.classList.contains('is-timer-only'));
    assert.equal(row.querySelector('.working-issue-summary').textContent, 'Update the onboarding guide');
    assert.equal(row.querySelector('.issue-key-badge').getAttribute('href'), 'https://acme.atlassian.net/browse/KAN-10');
    assert.ok(row.querySelector('.working-issue-timer-btn[data-timer-action="stop"]'));
    assert.equal(row.querySelector('.working-issue-elapsed').textContent, '00:03:23');
    assert.ok(row.querySelector('.working-issue-log-btn'), 'work can be logged on it, on the same site');
    // Jira's own count is unchanged: the added row isn't one of its issues.
    assert.equal(section.querySelector('.working-issues-subtitle').textContent, '2 issues · In progress and recently logged');

    updateWorkingIssuesTimer(section, NOW + 10_000);
    assert.equal(row.querySelector('.working-issue-elapsed').textContent, '00:03:33');
  });

  it('doesn\'t list the running issue twice when Jira lists it', () => {
    const section = document.createElement('section');
    renderWorkingIssues(section, { state: READY, expanded: true, ...timerOptions({ running: RUNNING_KAN_12 }) });
    assert.deepEqual(keysOf(section), ['KAN-12', 'KAN-13']);
    assert.equal(section.querySelector('.is-timer-only'), null);
  });

  it('matches by issue ID: a key change (moved issue) isn\'t a second row', () => {
    const section = document.createElement('section');
    renderWorkingIssues(section, { state: READY, expanded: true, ...timerOptions({ running: { ...RUNNING_KAN_12, issueKey: 'OLD-7' } }) });
    assert.deepEqual(keysOf(section), ['KAN-12', 'KAN-13']);
  });

  it('lists the same key from another Jira site separately, linked to that site, without Log work', () => {
    const otherSite = { ...RUNNING_KAN_12, site: siteId('server', 'https://jira.example.com') };
    const { timer, calls } = timerOptions({ running: otherSite });
    const section = document.createElement('section');
    renderWorkingIssues(section, { state: READY, expanded: true, onLogWork: () => {}, timer });

    assert.deepEqual(keysOf(section), ['KAN-12', 'KAN-12', 'KAN-13']);
    const [running, listed] = rowsOf(section);
    assert.equal(running.querySelector('.issue-key-badge').getAttribute('href'), 'https://jira.example.com/browse/KAN-12');
    assert.equal(running.querySelector('.working-issue-log-btn'), null);
    assert.ok(running.querySelector('.working-issue-timer-btn[data-timer-action="stop"]'));
    assert.equal(listed.querySelector('.working-issue-timer-btn').dataset.timerAction, 'start');

    // Each button acts on its own row, though the keys match.
    listed.querySelector('.working-issue-timer-btn').click();
    running.querySelector('.working-issue-timer-btn[data-timer-action="stop"]').click();
    assert.deepEqual(calls.started, ['KAN-12']);
    assert.equal(calls.stopped, 1);
  });

  it('shows what it has when the summary is missing (and never a status)', () => {
    const section = document.createElement('section');
    renderWorkingIssues(section, { state: READY, expanded: true, ...timerOptions({ running: { ...RUNNING_KAN_10, issueSummary: '' } }) });
    const row = rowsOf(section)[0];
    assert.equal(row.querySelector('.issue-key-badge').textContent, 'KAN-10');
    assert.equal(row.querySelector('.working-issue-summary').textContent, '');
    assert.equal(row.querySelector('.issue-status'), null);
  });

  it('lists it while Jira\'s issues load or fail, and not without a timer', () => {
    for (const state of [{ status: 'loading' }, { status: 'error', message: 'Server error' }]) {
      const section = document.createElement('section');
      renderWorkingIssues(section, { state, expanded: true, ...timerOptions({ running: RUNNING_KAN_10 }) });
      assert.deepEqual(keysOf(section), ['KAN-10']);
    }
    const plain = document.createElement('section');
    renderWorkingIssues(plain, { state: READY, expanded: true });
    assert.deepEqual(keysOf(plain), ['KAN-12', 'KAN-13']);
  });
});

describe('Timer - pause and resume controls', () => {
  let restoreDocument;
  before(() => { restoreDocument = installFakeDocument(); });
  after(() => restoreDocument());

  // Running for 5 minutes banked before a pause, and 2 more since resuming.
  const RUNNING = { ...RUNNING_KAN_12, accumulatedMs: 300_000, resumedAt: NOW - 120_000 };
  const PAUSED = { ...RUNNING_KAN_12, accumulatedMs: 300_000, resumedAt: null };
  const controls = (section, key) => bodyOf(section).querySelectorAll('.working-issue-timer-btn').filter((b) => b.dataset.issueKey === key);

  function render(running, extra = {}) {
    const calls = [];
    const section = document.createElement('section');
    renderWorkingIssues(section, {
      state: READY, expanded: true,
      ...timerOptions({ running, onPause: () => calls.push('pause'), onResume: () => calls.push('resume'), onStop: () => calls.push('stop'), ...extra })
    });
    return { section, calls };
  }

  it('shows Pause and Stop on the running issue, with labels and tooltips', () => {
    const { section } = render(RUNNING);
    const [pause, stop] = controls(section, 'KAN-12');
    assert.deepEqual([pause.dataset.timerAction, stop.dataset.timerAction], ['pause', 'stop']);
    assert.deepEqual([pause.getAttribute('aria-label'), pause.getAttribute('title')], ['Pause the timer on KAN-12', 'Pause timer']);
    assert.deepEqual([stop.getAttribute('aria-label'), stop.getAttribute('title')], ['Stop the timer on KAN-12', 'Stop timer']);
    assert.match(toHtml(pause), /<rect x="6" y="5" width="4" height="14" rx="1"><\/rect><rect x="14" y="5"/);
    assert.equal(bodyOf(section).querySelector('.working-issue-elapsed').textContent, '00:07:00');
    // Other issues: Start only.
    assert.deepEqual(controls(section, 'KAN-13').map((b) => b.dataset.timerAction), ['start']);
  });

  it('shows Resume and Stop while paused, with the time standing still', () => {
    const { section } = render(PAUSED);
    const [resume, stop] = controls(section, 'KAN-12');
    assert.deepEqual([resume.dataset.timerAction, stop.dataset.timerAction], ['resume', 'stop']);
    assert.deepEqual([resume.getAttribute('aria-label'), resume.getAttribute('title')], ['Resume the timer on KAN-12', 'Resume timer']);
    assert.match(toHtml(resume), /<polygon points="7 4 20 12 7 20 7 4">/);

    const elapsed = bodyOf(section).querySelector('.working-issue-elapsed');
    assert.equal(elapsed.textContent, '00:05:00');
    assert.ok(elapsed.classList.contains('is-paused'));
    updateWorkingIssuesTimer(section, NOW + 3_600_000);
    assert.equal(elapsed.textContent, '00:05:00', 'a paused time doesn\'t move');
  });

  it('keeps a running time current from what it banked and when it resumed', () => {
    const { section } = render(RUNNING);
    updateWorkingIssuesTimer(section, NOW + 30_000);
    assert.equal(bodyOf(section).querySelector('.working-issue-elapsed').textContent, '00:07:30');
    assert.equal(headerTimerOf(section).querySelector('.working-issue-elapsed').textContent, '00:07:30');
  });

  it('calls Pause, Resume, and Stop', () => {
    const running = render(RUNNING);
    controls(running.section, 'KAN-12')[0].click();
    controls(running.section, 'KAN-12')[1].click();
    const paused = render(PAUSED);
    controls(paused.section, 'KAN-12')[0].click();
    assert.deepEqual(running.calls, ['pause', 'stop']);
    assert.deepEqual(paused.calls, ['resume']);
  });

  it('keeps focus in place from Pause to Resume, and moves it from Stop to Start', () => {
    const section = document.createElement('section');
    const opts = (running) => ({ state: READY, expanded: true, ...timerOptions({ running }) });
    renderWorkingIssues(section, opts(RUNNING));
    controls(section, 'KAN-12')[0].focus();
    renderWorkingIssues(section, opts(PAUSED));
    assert.equal(document.activeElement.dataset.timerAction, 'resume');

    controls(section, 'KAN-12')[1].focus();
    renderWorkingIssues(section, opts(null));
    assert.equal(document.activeElement.dataset.timerAction, 'start');
    assert.equal(document.activeElement.dataset.issueKey, 'KAN-12');
  });

  it('marks its play buttons (Start, Resume) for the solid blue style, and Pause and Stop not', () => {
    const running = render(RUNNING).section;
    const paused = render(PAUSED).section;
    const actions = (section) => bodyOf(section).querySelectorAll('.working-issue-timer-btn').map((b) => b.dataset.timerAction);
    assert.deepEqual(actions(running), ['pause', 'stop', 'start']);
    assert.deepEqual(actions(paused), ['resume', 'stop', 'start']);
    const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
    assert.match(css, /\.working-issue-timer-btn\[data-timer-action="start"\],\n\.working-issue-timer-btn\[data-timer-action="resume"\] \{\s*color: #ffffff;\s*background-color: var\(--primary\);/);
    assert.doesNotMatch(css, /data-timer-action="(pause|stop)"/);
  });

  it('lists a paused issue Jira doesn\'t list, with Resume and Stop', () => {
    const elsewhere = { ...PAUSED, issueId: '10099', issueKey: 'KAN-99' };
    const { section } = render(elsewhere);
    const row = section.querySelector('.is-timer-only');
    assert.equal(row.querySelector('.issue-key-badge').textContent, 'KAN-99');
    assert.deepEqual(row.querySelectorAll('.working-issue-timer-btn').map((b) => b.dataset.timerAction), ['resume', 'stop']);
  });
});
