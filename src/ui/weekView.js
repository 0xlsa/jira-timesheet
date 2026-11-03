/**
 * Weekly view presentation: weekday cards and the selected day's worklog panel.
 * Pure DOM rendering; state and data loading stay with the page controller.
 */

import { h, svg, fragment } from './dom.js';
import { isEditableWorklog } from '../worklog/worklogEdit.js';
import { elapsedSeconds, isSameIssue, isPaused } from '../timer/timeTrackingStore.js';
import { renderPendingWorklogs, siteBaseUrl } from './pendingWorklogs.js';
import { ALL_VIEW_ID, ALL_VIEW_NAME } from '../jira/customViews.js';

// Daily duration that fills a weekday card's indicator bar (visual only).
const DAY_INDICATOR_FULL_SECONDS = 8 * 60 * 60;

const LONG_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric'
});

// The add button's accessible label ("26 October").
const DAY_LABEL_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' });

// Subtitle of the My Work section, by state.
const WORKING_ISSUES_SUBTITLES = {
  loading: 'Retrieving issues from Jira…',
  ready: 'In progress and recently logged',
  error: "Couldn't retrieve issues from Jira"
};
// Ready, with Show Recently Logged Issues turned off.
const WORKING_ISSUES_ASSIGNED_ONLY = 'In progress';

// A custom view's list while it's searched, when no issue matches it, or when its field is gone from Jira.
export const VIEW_SEARCHING = 'Searching Jira…';
export const VIEW_NO_MATCHES = 'No issues match this view.';
export const VIEW_FIELD_UNAVAILABLE = "This view's field is no longer available in Jira.";

/** The section's subtitle for a state. */
const workingIssuesSubtitle = (state) =>
  (state.status === 'ready' && state.includeRecentlyLogged === false ? WORKING_ISSUES_ASSIGNED_ONLY : WORKING_ISSUES_SUBTITLES[state.status]) || '';

// Jira status category keys with a dedicated badge color; anything else (custom or `undefined`) is neutral.
const STATUS_CATEGORY_CLASSES = {
  new: 'status-category-new',
  indeterminate: 'status-category-indeterminate',
  done: 'status-category-done'
};

const ICON_STROKE = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' };

/** Small icon in a worklog's meta row (start time, author). */
const metaIcon = (...shapes) => svg('svg', { class: 'meta-icon', ...ICON_STROKE }, ...shapes);

/** Icon inside a worklog action button. */
const buttonIcon = (...shapes) => svg('svg', {
  class: 'icon', ...ICON_STROKE, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
}, ...shapes);

/**
 * Returns the address of an issue in Jira, or '#' without an instance URL.
 * @param {string} baseUrl
 * @param {string} issueKey
 * @returns {string}
 */
function issueBrowseUrl(baseUrl, issueKey) {
  return baseUrl ? `${baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(issueKey)}` : '#';
}

/**
 * Builds the status label (colored dot + name) shown under the issue key, or null when the status is unknown.
 * @param {{ name: string, categoryKey?: string } | null | undefined} status
 * @returns {HTMLElement | null}
 */
export function renderIssueStatusBadge(status) {
  const name = typeof status?.name === 'string' ? status.name.trim() : '';
  if (!name) return null;

  const categoryClass = STATUS_CATEGORY_CLASSES[status.categoryKey] || 'status-category-unknown';
  return h('span', { class: `issue-status ${categoryClass}`, title: `Status: ${name}` },
    h('span', { class: 'issue-status-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'issue-status-name' }, name));
}

/**
 * Builds the contents of a single worklog entry in the selected-day panel.
 * @param {object} wl
 * @param {string} baseUrl
 * @param {object} [options]
 * @param {boolean} [options.editable=false] - Show the edit (pencil) button
 * @param {boolean} [options.canLogWork=false] - Show the log work (plus) button for the worklog's issue
 * @param {boolean} [options.deletable=false] - Show the delete (trash) button
 * @returns {DocumentFragment}
 */
export function renderWorklogItem(wl, baseUrl, { editable = false, canLogWork = false, deletable = false } = {}) {
  const issueUrl = issueBrowseUrl(baseUrl, wl.issueKey);
  const issueKey = wl.issueKey || '';
  const worklogId = String(wl.id);

  return fragment(
    h('div', { class: 'worklog-issue' },
      h('a', { href: issueUrl, target: '_blank', rel: 'noopener noreferrer', class: 'issue-key-badge', title: `Open ${issueKey} in Jira` },
        wl.issueKey || 'ISSUE'),
      renderIssueStatusBadge(wl.issueStatus)),
    h('div', { class: 'worklog-body' },
      h('span', { class: 'issue-summary', title: wl.issueSummary || '' }, wl.issueSummary),
      wl.comment && h('div', { class: 'worklog-comment' }, wl.comment),
      h('div', { class: 'worklog-meta-row' },
        h('span', { class: 'worklog-time' },
          metaIcon(
            svg('circle', { cx: '12', cy: '12', r: '10' }),
            svg('polyline', { points: '12 6 12 12 16 14' })),
          `Started ${wl.formattedStartTime}`),
        wl.author?.displayName && h('span', { class: 'worklog-author' },
          metaIcon(
            svg('path', { d: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2' }),
            svg('circle', { cx: '12', cy: '7', r: '4' })),
          wl.author.displayName))),
    h('div', { class: 'worklog-side' },
      h('span', { class: 'worklog-duration-badge' }, wl.formattedDuration),
      (canLogWork || editable || deletable) && h('div', { class: 'worklog-actions' },
        canLogWork && h('button', { type: 'button', class: 'worklog-log-btn', 'data-worklog-id': worklogId, 'aria-label': `Log work on ${issueKey}`, title: 'Log work' },
          buttonIcon(
            svg('line', { x1: '12', y1: '5', x2: '12', y2: '19' }),
            svg('line', { x1: '5', y1: '12', x2: '19', y2: '12' }))),
        editable && h('button', { type: 'button', class: 'worklog-edit-btn', 'data-worklog-id': worklogId, 'aria-label': `Edit worklog for ${issueKey}, started ${wl.formattedStartTime}`, title: 'Edit worklog' },
          buttonIcon(
            svg('path', { d: 'M12 20h9' }),
            svg('path', { d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' }))),
        deletable && h('button', { type: 'button', class: 'worklog-delete-btn', 'data-worklog-id': worklogId, 'aria-label': `Delete worklog for ${issueKey}, started ${wl.formattedStartTime}`, title: 'Delete worklog' },
          buttonIcon(
            svg('polyline', { points: '3 6 5 6 21 6' }),
            svg('path', { d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }),
            svg('path', { d: 'M10 11v6' }),
            svg('path', { d: 'M14 11v6' }),
            svg('path', { d: 'M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' })))))
  );
}

/**
 * Formats a running timer's elapsed time as HH:MM:SS (hours keep growing past 99).
 * @param {number} seconds - Whole seconds
 * @returns {string} e.g. "01:05:09"
 */
export function formatElapsed(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/**
 * Builds an elapsed time that updateWorkingIssuesTimer() keeps current: it holds the timer's start,
 * so the time shown is always worked out from it.
 * @param {{ startedAt: number }} running
 * @param {number} now - Epoch milliseconds
 * @param {string} className
 * @returns {HTMLElement}
 */
function renderElapsed(running, now, className) {
  const paused = isPaused(running);
  // A running timer's time is kept current from what it has banked and when it last resumed; a
  // paused one stands still.
  return h('span', {
    class: `${className}${paused ? ' is-paused' : ''}`,
    'data-timer-resumed-at': paused ? undefined : String(running.resumedAt ?? running.startedAt),
    'data-timer-accumulated-ms': paused ? undefined : String(running.accumulatedMs ?? 0)
  }, formatElapsed(elapsedSeconds(running, now)));
}

/**
 * Updates the running timer's elapsed times in a My Work section (its row and the header)
 * without rebuilding anything else, so focus and the list stay as they are. A paused timer's time
 * isn't updated: it doesn't change.
 * @param {HTMLElement} section
 * @param {number} now - Epoch milliseconds
 */
export function updateWorkingIssuesTimer(section, now) {
  for (const el of section.querySelectorAll('[data-timer-resumed-at]')) {
    el.textContent = formatElapsed(elapsedSeconds({
      resumedAt: Number(el.dataset.timerResumedAt),
      accumulatedMs: Number(el.dataset.timerAccumulatedMs) || 0
    }, now));
  }
}

/**
 * True when the row's issue is the one the timer is running on (same site and issue).
 * @param {object} issue - A My Work row's issue
 * @param {{ site: string, running: object | null }} timer
 * @returns {boolean}
 */
function isTimedIssue(issue, timer) {
  return Boolean(timer.running) &&
    isSameIssue(timer.running, { site: issue.site ?? timer.site, issueId: String(issue.issueId ?? ''), issueKey: issue.issueKey });
}

/**
 * The rows to list: Jira's issues, with the running timer's issue first when Jira didn't return it
 * (a timer started from the Log work panel on an issue that isn't in progress or recently logged),
 * so it can always be stopped from the list. It's built from the timer's own record (site, issue
 * ID, key, and summary; no status), with no Jira request, and is never listed twice: Jira's row is
 * the same issue when it has the same site and issue ID (key without an ID).
 *
 * @param {Array<object>} issues - Jira's issues, one per key
 * @param {object} [timer] - renderWorkingIssues()'s `timer` options
 * @returns {Array<object>} Rows; the added one has `site` (its own Jira site) and `timerOnly`
 */
function withRunningIssue(issues, timer) {
  const running = timer?.running;
  if (!running || issues.some((issue) => isTimedIssue(issue, timer))) return issues;
  return [{
    issueId: running.issueId,
    issueKey: running.issueKey,
    issueSummary: running.issueSummary,
    issueStatus: null,
    site: running.site,
    timerOnly: true
  }, ...issues];
}

/**
 * Builds a row's timer controls: Start, or the elapsed time and Stop on the issue the timer is
 * running on. While a start or stop is in progress (or the timer is unavailable), the button is
 * marked disabled with aria-disabled rather than `disabled`, so it keeps focus.
 * @param {object} issue
 * @param {{ site: string, running: object | null, busy?: boolean, unavailable?: string, now: number }} timer
 * @returns {HTMLElement}
 */
// The timer buttons: what each does, its label, and its icon.
const TIMER_ACTIONS = {
  start: { label: (key) => `Start a timer on ${key}`, title: 'Start timer', icon: 'play' },
  pause: { label: (key) => `Pause the timer on ${key}`, title: 'Pause timer', icon: 'pause' },
  resume: { label: (key) => `Resume the timer on ${key}`, title: 'Resume timer', icon: 'play' },
  stop: { label: (key) => `Stop the timer on ${key}`, title: 'Stop timer', icon: 'stop' }
};

/**
 * Builds a row's timer controls: Start; or, on the issue the timer is on, its elapsed time with
 * Pause (Resume while paused) and Stop. While a change is in progress (or the timer is
 * unavailable), the buttons are marked disabled with aria-disabled rather than `disabled`, so they
 * keep focus.
 * @param {object} issue
 * @param {{ site: string, running: object | null, busy?: boolean, unavailable?: string, now: number }} timer
 * @param {string} [scope] - Prefixes the buttons' focus keys (renderWorkingIssue())
 * @returns {HTMLElement}
 */
function renderIssueTimer(issue, timer, scope = '') {
  const timed = isTimedIssue(issue, timer);
  const paused = timed && isPaused(timer.running);
  const focusKey = `${issue.site ?? timer.site}|${issue.issueKey}`;
  // The first button keeps its place through start, pause, and resume, so focus stays on it.
  return h('span', { class: 'working-issue-timer' },
    timed && renderElapsed(timer.running, timer.now, 'working-issue-elapsed'),
    renderTimerButton(!timed ? 'start' : paused ? 'resume' : 'pause', issue.issueKey, timer, `${scope}timer:${focusKey}`),
    timed && renderTimerButton('stop', issue.issueKey, timer, `${scope}timer-stop:${focusKey}`));
}

/**
 * Builds one timer button, for a My Work row or the header. While a change is in progress
 * (or the timer is unavailable), it's marked disabled with aria-disabled, so it keeps focus.
 * @param {'start' | 'pause' | 'resume' | 'stop'} action
 * @param {string} issueKey
 * @param {{ busy?: boolean, unavailable?: string }} timer
 * @param {string} focusKey
 * @returns {HTMLElement}
 */
function renderTimerButton(action, issueKey, timer, focusKey) {
  return h('button', {
    type: 'button',
    class: `working-issue-timer-btn${action === 'stop' ? ' is-running' : ''}${action === 'resume' ? ' is-paused' : ''}`,
    'data-issue-key': issueKey,
    'data-timer-action': action,
    'data-focus-key': focusKey,
    'aria-label': TIMER_ACTIONS[action].label(issueKey),
    title: timer.unavailable || TIMER_ACTIONS[action].title,
    'aria-disabled': timer.busy || timer.unavailable ? 'true' : undefined
  }, renderTimerIcon(TIMER_ACTIONS[action].icon));
}

/**
 * Runs a timer button's action with the page's timer handlers, from a row or the header. An
 * unavailable timer still answers the click (the page explains why); a busy one doesn't.
 * @param {object} timer - renderWorkingIssues()'s `timer` options
 * @param {string} action - The button's data-timer-action
 * @param {object} [issue] - The row's issue, for Start
 */
function runTimerAction(timer, action, issue) {
  if (timer.busy) return;
  if (action === 'stop') timer.onStop();
  else if (action === 'pause') timer.onPause?.();
  else if (action === 'resume') timer.onResume?.();
  else timer.onStart(issue);
}

/**
 * A timer button's icon: 'play' (start or resume), 'pause', or 'stop' (a square). For the Log work
 * panel, `true` is stop and `false` play. Shared by My Work and the Log work panel.
 * @param {'play' | 'pause' | 'stop' | boolean} kind
 * @returns {SVGElement}
 */
export function renderTimerIcon(kind) {
  if (kind === true || kind === 'stop') return buttonIcon(svg('rect', { x: '6', y: '6', width: '12', height: '12', rx: '1' }));
  if (kind === 'pause') {
    return buttonIcon(
      svg('rect', { x: '6', y: '5', width: '4', height: '14', rx: '1' }),
      svg('rect', { x: '14', y: '5', width: '4', height: '14', rx: '1' }));
  }
  return buttonIcon(svg('polygon', { points: '7 4 20 12 7 20 7 4' }));
}

/**
 * Builds one row of the My Work list: issue key (a link to Jira), summary, status, the
 * timer controls (when given), and the log work (plus) button.
 *
 * A row for the running timer's issue on another Jira site (see withRunningIssue()) links to that
 * site and has no log work button, since work is logged on the connected site.
 *
 * @param {object} issue - From JiraClient.getActiveIssues(), or the running timer's issue
 * @param {string} baseUrl
 * @param {boolean} canLogWork - Show the log work button
 * @param {object} [timer] - Timer options from renderWorkingIssues(); no timer controls without them
 * @param {number} index - The row's position, which its buttons report (keys can repeat across sites)
 * @param {string} [scope] - Prefixes the timer buttons' focus keys: '' for Active, 'view-row:'
 *   for a view's rows, so the same issue in both lists keeps focus where it was
 * @returns {HTMLElement}
 */
function renderWorkingIssue(issue, baseUrl, canLogWork, timer, index, scope = '') {
  const otherSite = Boolean(issue.site && timer && issue.site !== timer.site);
  const issueBaseUrl = otherSite ? siteBaseUrl(issue.site) : baseUrl;
  return h('li', { class: `working-issue${timer ? ' has-timer' : ''}${issue.timerOnly ? ' is-timer-only' : ''}`, 'data-row-index': String(index) },
    h('a', { href: issueBrowseUrl(issueBaseUrl, issue.issueKey), target: '_blank', rel: 'noopener noreferrer', class: 'issue-key-badge', title: `Open ${issue.issueKey} in Jira` },
      issue.issueKey),
    h('span', { class: 'working-issue-summary', title: issue.issueSummary || '' }, issue.issueSummary),
    h('span', { class: 'working-issue-status' }, renderIssueStatusBadge(issue.issueStatus)),
    timer && renderIssueTimer(issue, timer, scope),
    canLogWork && !otherSite && h('button', { type: 'button', class: 'working-issue-log-btn', 'data-issue-key': issue.issueKey, 'aria-label': `Log work on ${issue.issueKey}`, title: 'Log work' },
      buttonIcon(
        svg('line', { x1: '12', y1: '5', x2: '12', y2: '19' }),
        svg('line', { x1: '5', y1: '12', x2: '19', y2: '12' }))));
}

/**
 * Fills the header's timer controls: the elapsed time with Pause (Resume while paused) and Stop,
 * the same buttons and handlers as the timed issue's row; or nothing (hidden) when no timer runs.
 * They're beside the header button, not in it, so they work while the section is collapsed and a
 * click on one doesn't expand or collapse it.
 * @param {HTMLElement} controls
 * @param {object} [timer]
 */
function renderHeaderTimer(controls, timer) {
  const running = timer?.running;
  controls.classList.toggle('hidden', !running);
  if (!running) {
    controls.replaceChildren();
    return;
  }
  const paused = isPaused(running);
  const focusKey = `${running.site}|${running.issueKey}`;
  const buttons = [
    renderTimerButton(paused ? 'resume' : 'pause', running.issueKey, timer, `header-timer:${focusKey}`),
    renderTimerButton('stop', running.issueKey, timer, `header-timer-stop:${focusKey}`)
  ];
  for (const button of buttons) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      runTimerAction(timer, button.dataset.timerAction);
    });
  }
  controls.replaceChildren(
    h('span', { class: 'sr-only' }, `Timer ${paused ? 'paused' : 'running'} on ${running.issueKey}: `),
    renderElapsed(running, timer.now, 'working-issue-elapsed'),
    ...buttons);
}

/**
 * Fills the line under the header with the timed issue, running or paused ("KAN-12: Fix the login
 * page"), or hides it.
 * @param {HTMLElement} line
 * @param {object} [timer]
 */
function renderHeaderTimerSummary(line, timer) {
  const running = timer?.running;
  const text = running ? (running.issueSummary ? `${running.issueKey}: ${running.issueSummary}` : running.issueKey) : '';
  line.classList.toggle('hidden', !text);
  line.textContent = text;
  if (text) line.setAttribute('title', text);
  else line.removeAttribute('title');
}

/**
 * Keeps the first of each issue, by key: a row is its issue key, which its + button looks it up by.
 * @param {Array<{ issueKey: string }>} issues
 * @returns {Array<object>}
 */
function uniqueIssues(issues) {
  const seen = new Set();
  return issues.filter((issue) => !seen.has(issue.issueKey) && seen.add(issue.issueKey));
}

/**
 * Renders the My Work section: a header button that expands and collapses it (count and
 * subtitle included), and below it the My Issues group (with its views) and the Pending Worklogs
 * group. The first call builds the header; later calls on the same section update it in place, so
 * the header button keeps focus when the issues arrive.
 *
 * @param {HTMLElement} section
 * @param {object} options
 * @param {{ status: 'loading' | 'ready' | 'error', issues?: Array<object>, message?: string, includeRecentlyLogged?: boolean }} options.state -
 *   Active Issues: `issues` when ready (JiraClient.getActiveIssues(): each with `inProgress` and
 *   `loggedInRange`), and whether recently logged issues were included (Show Recently Logged Issues);
 *   `message` for an error
 * @param {boolean} options.expanded
 * @param {string} [options.baseUrl] - Jira instance URL used for issue links
 * @param {(expanded: boolean) => void} [options.onToggle] - Called after the header expands or collapses the section
 * @param {() => void} [options.onRetry] - Called when the error's Retry button is clicked; no Retry button without it
 * @param {(issue: object) => void} [options.onLogWork] - Called with an issue when its log work button is clicked;
 *   no log work buttons without it
 * @param {object} [options.timer] - The timer, from the page's timer controller; no timer controls without it
 * @param {string} options.timer.site - The Jira site the rows' issues belong to, from siteId()
 * @param {object | null} options.timer.running - The running timer, as stored
 * @param {number} options.timer.now - Epoch milliseconds, for the elapsed times
 * @param {boolean} [options.timer.busy] - A start or stop is in progress
 * @param {string} [options.timer.unavailable] - Why the timer can't be used, when it can't
 * @param {(issue: object) => void} options.timer.onStart - Called with a row's issue when its Start button is clicked
 * @param {() => void} options.timer.onStop - Called when the running issue's Stop button is clicked
 * @param {() => void} [options.timer.onPause] - Called when the running issue's Pause button is clicked
 * @param {() => void} [options.timer.onResume] - Called when the paused issue's Resume button is clicked
 * @param {object} [options.pending] - The pending worklogs; with them, the expanded section has a My
 *   Issues group and a Pending Worklogs group, one below the other (the header, collapsed or not, stays the same)
 * @param {Array<object>} options.pending.entries - `timeTracking.pending`, as stored
 * @param {string} options.pending.site - The connected Jira site's ID
 * @param {(id: string) => void} options.pending.onEdit - Called with a pending worklog's ID from its Edit button
 * @param {(id: string) => void} options.pending.onDiscard - Called with a pending worklog's ID from its Discard button
 * @param {(id: string) => void} [options.pending.onSubmit] - Called with a pending worklog's ID from its Submit button
 * @param {number} [options.pending.now] - For a submission left running too long
 * @param {{ active?: boolean, pending?: boolean }} [options.groupsExpanded] - Whether each group is
 *   expanded; each is unless `false`
 * @param {(group: 'active' | 'pending', expanded: boolean) => void} [options.onGroupToggle] - Called
 *   after a group's header expands or collapses that group (never the other)
 * @param {object} [options.recentlyLogged] - The Show Recently Logged Issues switch, Active's own:
 *   below the view tabs while Active is selected (so only with the groups); no switch without it
 * @param {boolean} options.recentlyLogged.checked - Whether it's on
 * @param {(checked: boolean) => void} options.recentlyLogged.onChange - Called when the user flips it
 * @param {object} [options.views] - Custom views (src/jira/customViews.js): tabs at the top of My Issues,
 *   Active (the built-in view) first, then the custom views, with the selected custom view's edit
 *   button and + for a new view; no tabs without it. The one list below shows the selected view:
 *   Active's issues (with the running timer's issue when Jira doesn't list it), or a custom view's
 *   own Jira search, whose rows have the same timer and log work buttons and no timer-only row.
 * @param {Array<{ id: string, name: string, description: string, unavailable: boolean,
 *   result: { status: 'loading' | 'ready' | 'error', issues: Array<object>, total: number | null, hasMore: boolean, message: string } | null }>} options.views.items -
 *   The custom views: `description` says what they search ("Reporter is Me"), `unavailable` when the
 *   field is gone from Jira, and `result` their search's, null until searched
 * @param {string} options.views.selectedId - ALL_VIEW_ID or a custom view's ID (an unknown one shows Active)
 * @param {boolean} options.views.canCreate - Offer + (fewer than two views)
 * @param {(id: string) => void} options.views.onSelect - Called with a tab's view ID when it's chosen
 * @param {() => void} options.views.onCreate - Called from +
 * @param {(id: string) => void} options.views.onEdit - Called with the selected view's ID from its edit button
 * @param {(id: string) => void} options.views.onRefresh - Called with the selected view's ID from its
 *   error's Retry
 */
export function renderWorkingIssues(section, { state, expanded, baseUrl = '', onToggle, onRetry, onLogWork, timer, pending, groupsExpanded = {}, onGroupToggle, recentlyLogged, views }) {
  let toggle = section.querySelector('.working-issues-toggle');
  if (!toggle) {
    toggle = h('button', { type: 'button', class: 'working-issues-toggle', 'aria-controls': 'workingIssuesBody' },
      svg('svg', { class: 'working-issues-chevron', ...ICON_STROKE, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
        svg('polyline', { points: '6 9 12 15 18 9' })),
      h('span', { class: 'working-issues-titles' },
        h('span', { class: 'working-issues-title' }, 'My Work'),
        h('span', { class: 'working-issues-subtitle' }),
        h('span', { class: 'working-issues-pending-count hidden' })),
      h('span', { class: 'working-issues-indicator' }));
    toggle.addEventListener('click', () => {
      const isExpanded = toggle.getAttribute('aria-expanded') !== 'true';
      setWorkingIssuesExpanded(section, isExpanded);
      onToggle?.(isExpanded);
    });
    // The timer controls (top right) and the timed issue (under the titles) are beside the header
    // button: buttons can't go in a button. A click elsewhere in the header, other than on the
    // timer controls, still toggles.
    const header = h('div', { class: 'working-issues-header' },
      h('h3', { class: 'working-issues-heading' }, toggle),
      h('span', { class: 'working-issues-timer hidden' }),
      h('span', { class: 'working-issues-timer-summary hidden' }));
    header.addEventListener('click', (event) => {
      if (!event.target.closest('button, .working-issues-timer')) toggle.click();
    });
    section.replaceChildren(header, h('div', { id: 'workingIssuesBody', class: 'working-issues-body' }));
  }

  // Rebuilding the header's timer controls or the body replaces the button that had focus (Pause
  // becomes Resume, Start becomes Stop, a group re-renders): give focus to the new one with the same
  // focus key.
  const focusKey = section.ownerDocument?.activeElement?.closest?.('[data-focus-key]')?.dataset.focusKey;

  // One row per issue, and the badge counts the rows.
  const issues = state.status === 'ready' ? uniqueIssues(state.issues || []) : [];
  section.className = `working-issues is-${state.status}`;

  // When ready, the subtitle leads with how many issues are listed ("9 issues · In progress and …").
  const subtitle = workingIssuesSubtitle(state);
  toggle.querySelector('.working-issues-subtitle').textContent = state.status === 'ready'
    ? `${issues.length} ${issues.length === 1 ? 'issue' : 'issues'} · ${subtitle}`
    : subtitle;
  toggle.querySelector('.working-issues-indicator').replaceChildren(fragment(
    state.status === 'loading' && h('span', { class: 'working-issues-spinner', 'aria-hidden': 'true' })));
  renderHeaderTimer(section.querySelector('.working-issues-timer'), timer);
  renderHeaderTimerSummary(section.querySelector('.working-issues-timer-summary'), timer);
  section.classList.toggle('has-timer', Boolean(timer?.running));
  // The pending worklogs, on their own line under the subtitle, so they show while collapsed too.
  const pendingCount = toggle.querySelector('.working-issues-pending-count');
  pendingCount.classList.toggle('hidden', !pending);
  pendingCount.textContent = pending ? formatPendingCount(pending.entries.length) : '';

  const retryButton = state.status === 'error' && onRetry
    ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm working-issues-retry' }, 'Retry')
    : null;
  retryButton?.addEventListener('click', () => {
    // The button goes away with the error; keep focus in the section.
    toggle.focus();
    onRetry();
  });

  // The running timer's issue is listed even when Jira's list doesn't include it.
  const rows = withRunningIssue(issues, timer);
  const list = renderIssueList(rows, { baseUrl, onLogWork, timer });

  const errorMessage = state.status === 'error' && h('div', { class: 'working-issues-message', role: 'status' },
    h('p', {}, state.message || workingIssuesSubtitle(state)),
    retryButton);

  // Active's contents: the Show recently logged switch (Active's alone), then its issues, or why
  // there are none.
  const activeContent = fragment(
    recentlyLogged && renderRecentlyLoggedSwitch(recentlyLogged),
    list,
    errorMessage,
    state.status === 'loading' && h('p', { class: 'working-issues-empty' }, WORKING_ISSUES_SUBTITLES.loading),
    state.status === 'ready' && !list && h('p', { class: 'working-issues-empty' },
      state.includeRecentlyLogged === false ? 'No issues in progress.' : 'No issues in progress or logged in the last 14 days.'));

  const body = section.querySelector('.working-issues-body');
  if (pending || views) {
    // The selected custom view, or null for Active. The one list below the tabs shows it, and the
    // header counts it: Active's rows from the start (0 until Jira's issues are in), a custom view's
    // once it has been searched.
    const selectedView = views?.items.find((view) => view.id === views.selectedId) ?? null;
    const searching = selectedView ? !selectedView.unavailable && selectedView.result?.status !== 'ready' && selectedView.result?.status !== 'error'
      : state.status === 'loading';
    body.replaceChildren(renderWorkingIssuesGroups(pending,
      selectedView ? viewCountLabel(selectedView) : String(rows.length),
      views ? fragment(
        renderViewTabs(views, selectedView, state.status === 'ready' ? rows.length : null),
        h('div', {
          id: 'workingIssuesViewPanel', class: 'working-issues-view-panel', role: 'tabpanel',
          'aria-labelledby': `workingIssuesViewTab-${selectedView?.id ?? ALL_VIEW_ID}`, 'aria-busy': searching ? 'true' : undefined
        }, selectedView ? renderViewResults(selectedView, views, { baseUrl, onLogWork, timer }) : activeContent)) : activeContent,
      { groupsExpanded, onGroupToggle }));
  } else {
    body.replaceChildren(fragment(list, errorMessage));
  }
  // Nothing to show below the header (loading, or no issues, without the groups).
  body.classList.toggle('is-empty', body.childNodes.length === 0);

  setWorkingIssuesExpanded(section, expanded);

  if (focusKey) {
    const all = [...section.querySelectorAll('[data-focus-key]')];
    const target = all.find((el) => el.dataset.focusKey === focusKey) ||
      // Stop leaves the issue's other timer button (now Start), in the same list; a submitted or
      // discarded pending worklog leaves the Pending Worklogs group's header.
      (/^(view-row:)?timer-stop:/.test(focusKey) ? all.find((el) => el.dataset.focusKey === focusKey.replace('timer-stop:', 'timer:')) : null) ||
      (/^(edit|discard|submit):/.test(focusKey) ? all.find((el) => el.dataset.focusKey === 'group:pending') : null) ||
      // A view's button that's gone (Retry once it worked, Edit view once the field is back, a row of
      // results searched again): the selected view's tab.
      (focusKey.startsWith('view-') ? all.find((el) => el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') === 'true') : null) ||
      // The header's controls go when the timer stops: back to the header button.
      (focusKey.startsWith('header-timer') ? toggle : null);
    target?.focus();
  }
}

/**
 * Builds a list of issue rows (Active's, or a custom view's) and handles its timer and log work
 * buttons; null without rows.
 * @param {Array<object>} rows
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {(issue: object) => void} [options.onLogWork]
 * @param {object} [options.timer]
 * @param {string} [options.scope] - The rows' focus key scope (renderWorkingIssue())
 * @returns {HTMLElement | null}
 */
function renderIssueList(rows, { baseUrl, onLogWork, timer, scope = '' }) {
  if (rows.length === 0) return null;
  const list = h('ul', { class: 'working-issues-list' },
    rows.map((issue, index) => renderWorkingIssue(issue, baseUrl, Boolean(onLogWork), timer, index, scope)));
  if (onLogWork || timer) {
    list.addEventListener('click', (event) => {
      const logBtn = onLogWork && event.target.closest('.working-issue-log-btn');
      const timerBtn = timer && event.target.closest('.working-issue-timer-btn');
      const button = logBtn || timerBtn;
      if (!button) return;
      // The click is the button's alone, not the row's or the section's.
      event.stopPropagation();
      const issue = rows[Number(button.closest('.working-issue')?.dataset.rowIndex)];
      if (!issue) return;
      if (logBtn) onLogWork(issue);
      else runTimerAction(timer, timerBtn.dataset.timerAction, issue);
    });
  }
  return list;
}

/**
 * A custom view's count for its tab, once its search has answered: "6", or "20+" when more issues
 * match than it lists; none while it's searched, after a failure, or while its field is unavailable.
 * @param {{ unavailable: boolean, result: object | null }} view
 * @returns {string | null}
 */
function viewCountLabel(view) {
  const result = view.result;
  if (view.unavailable || result?.status !== 'ready') return null;
  return result.hasMore ? `${result.issues.length}+` : String(result.issues.length);
}

const COUNT_FORMAT = new Intl.NumberFormat('en-US');

/**
 * Builds the view tabs, side by side: Active first, then the custom views, each with its count (Active
 * once its issues are in, a custom view once searched), then the selected custom view's edit button
 * and + for a new view. A tablist (WAI-ARIA tabs): the selected tab is the one in the tab order, and
 * the arrow keys, Home, and End choose another. Choosing a tab reports it through `views.onSelect`;
 * the page renders the result.
 *
 * @param {object} views - renderWorkingIssues()'s `views`
 * @param {object | null} selectedView - The selected custom view; null for Active
 * @param {number | null} activeCount - Active's rows, null until Jira's issues are in
 * @returns {HTMLElement}
 */
function renderViewTabs(views, selectedView, activeCount) {
  const tabs = [
    { id: ALL_VIEW_ID, name: ALL_VIEW_NAME, unavailable: false, count: activeCount === null ? null : String(activeCount) },
    ...views.items.map((view) => ({ ...view, count: viewCountLabel(view) }))
  ];
  const selectedId = selectedView?.id ?? ALL_VIEW_ID;
  const buttons = tabs.map((view) => {
    const selected = view.id === selectedId;
    return h('button', {
      type: 'button',
      role: 'tab',
      id: `workingIssuesViewTab-${view.id}`,
      class: `working-issues-view-tab${selected ? ' is-selected' : ''}${view.unavailable ? ' is-unavailable' : ''}`,
      'data-view': view.id,
      'data-focus-key': `view:${view.id}`,
      'aria-controls': 'workingIssuesViewPanel',
      'aria-selected': String(selected),
      tabindex: selected ? '0' : '-1',
      title: view.unavailable ? VIEW_FIELD_UNAVAILABLE : view.description
    },
      h('span', { class: 'working-issues-view-tab-name' }, view.name),
      view.count !== null && h('span', { class: 'working-issues-view-tab-count' }, ` (${view.count})`),
      view.unavailable && h('span', { class: 'sr-only' }, ', field unavailable'));
  });

  const tablist = h('div', { class: 'working-issues-view-tabs', role: 'tablist', 'aria-label': 'Views of My Issues' }, buttons);
  const select = (id) => {
    if (id !== selectedId) views.onSelect(id);
  };
  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab) return;
    event.stopPropagation();
    select(tab.dataset.view);
  });
  // Arrow keys, Home, and End move to another tab and choose it (WAI-ARIA tabs pattern). Focus moves
  // first, so it's on the new tab once the section is drawn again.
  tablist.addEventListener('keydown', (event) => {
    const index = buttons.findIndex((tab) => tab.dataset.view === selectedId);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: buttons.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const target = buttons[(next + buttons.length) % buttons.length];
    target.focus();
    select(target.dataset.view);
  });

  const editButton = selectedView ? h('button', {
    type: 'button', class: 'working-issues-view-btn', 'data-action': 'edit-view', 'data-focus-key': 'view-edit',
    'aria-label': `Edit the ${selectedView.name} view`, title: 'Edit view'
  }, buttonIcon(
    svg('path', { d: 'M12 20h9' }),
    svg('path', { d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' }))) : null;
  const addButton = views.canCreate ? h('button', {
    type: 'button', class: 'working-issues-view-btn', 'data-action': 'add-view', 'data-focus-key': 'view-add',
    'aria-label': 'New custom view', title: 'New view'
  }, buttonIcon(
    svg('line', { x1: '12', y1: '5', x2: '12', y2: '19' }),
    svg('line', { x1: '5', y1: '12', x2: '19', y2: '12' }))) : null;
  editButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    views.onEdit(selectedView.id);
  });
  addButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    views.onCreate();
  });

  return h('div', { class: 'working-issues-viewbar' }, tablist, editButton, addButton);
}

/**
 * The selected custom view's contents in the list: what it searches ("Jira search: Reporter is Me"),
 * then its own search's issues (the first CUSTOM_VIEW_RESULT_LIMIT), saying when more match, or why
 * there are none: still searching, nothing matches, Jira failed (with Retry), or its field is gone
 * (with Edit view).
 *
 * @param {object} view - One of renderWorkingIssues()'s `views.items`
 * @param {object} views - renderWorkingIssues()'s `views`
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {(issue: object) => void} [options.onLogWork]
 * @param {object} [options.timer]
 * @returns {DocumentFragment}
 */
function renderViewResults(view, views, { baseUrl, onLogWork, timer }) {
  const result = view.result;
  let content;
  if (view.unavailable) {
    // A view whose field is gone says so, with Edit to choose another; it never falls back to Active.
    const editViewButton = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-focus-key': 'view-edit-unavailable' }, 'Edit view');
    editViewButton.addEventListener('click', (event) => {
      event.stopPropagation();
      views.onEdit(view.id);
    });
    content = h('div', { class: 'working-issues-message', role: 'status' }, h('p', {}, VIEW_FIELD_UNAVAILABLE), editViewButton);
  } else if (result?.status === 'error') {
    const retryViewButton = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-focus-key': 'view-retry' }, 'Retry');
    retryViewButton.addEventListener('click', (event) => {
      event.stopPropagation();
      views.onRefresh(view.id);
    });
    content = h('div', { class: 'working-issues-message', role: 'status' }, h('p', {}, result.message), retryViewButton);
  } else if (result?.status === 'ready') {
    const list = renderIssueList(result.issues, { baseUrl, onLogWork, timer, scope: 'view-row:' });
    // More match than the view lists: say so, with Jira's count where it gives one.
    const shown = COUNT_FORMAT.format(result.issues.length);
    content = fragment(
      list,
      !list && h('p', { class: 'working-issues-empty' }, VIEW_NO_MATCHES),
      result.hasMore && h('p', { class: 'working-issues-view-more' }, result.total !== null
        ? `Showing the first ${shown} of ${COUNT_FORMAT.format(result.total)} matching issues.`
        : `Showing the first ${shown} matching issues.`));
  } else {
    content = h('p', { class: 'working-issues-empty' }, VIEW_SEARCHING);
  }
  // Where the issues come from: the view's own Jira search, not Active's.
  return fragment(
    h('p', { class: 'working-issues-view-query' },
      h('span', { class: 'working-issues-view-query-label' }, 'Jira search:'), ` ${view.description}`),
    content);
}

/**
 * "1 pending worklog", "2 pending worklogs": sessions, not issues.
 * @param {number} count
 * @returns {string}
 */
export function formatPendingCount(count) {
  return `${count} pending ${count === 1 ? 'worklog' : 'worklogs'}`;
}

const GROUPS = [
  { id: 'active', label: 'My Issues' },
  { id: 'pending', label: 'Pending Worklogs' }
];

/**
 * Builds the My Issues and Pending Worklogs groups, one below the other (Pending Worklogs with the
 * pending worklogs). Each has a header button that expands and collapses that group only; both can
 * be open, or closed, at once. The headers, with their counts, show either way. Expanding or
 * collapsing never changes the timer or a pending worklog.
 *
 * Each header counts what its group lists: "My Issues (5)" the selected view's issues (Active's
 * rows include the running timer's issue when Jira doesn't list it; a custom view's "20+" when more
 * match); "Pending Worklogs (2)" the pending worklogs, one per stopped session, so two sessions on
 * one issue count twice.
 *
 * @param {object | undefined} pending - renderWorkingIssues()'s `pending` options
 * @param {string | null} activeCount - What the My Issues list shows; none while a custom view is searched
 * @param {DocumentFragment} activeContent - The My Issues group's contents
 * @param {object} options
 * @param {{ active?: boolean, pending?: boolean }} options.groupsExpanded - Each group is expanded unless `false`
 * @param {(group: 'active' | 'pending', expanded: boolean) => void} [options.onGroupToggle]
 * @returns {DocumentFragment}
 */
function renderWorkingIssuesGroups(pending, activeCount, activeContent, { groupsExpanded, onGroupToggle }) {
  return fragment(GROUPS.filter(({ id }) => id === 'active' || pending).map(({ id, label }) => {
    const count = id === 'active' ? activeCount : String(pending.entries.length);
    const toggle = h('button', {
      type: 'button',
      id: `workingIssuesGroupToggle-${id}`,
      class: 'working-issues-group-toggle',
      'aria-controls': `workingIssuesGroup-${id}`,
      'data-group': id,
      'data-focus-key': `group:${id}`
    },
      svg('svg', { class: 'working-issues-group-chevron', ...ICON_STROKE, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
        svg('polyline', { points: '6 9 12 15 18 9' })),
      h('span', { class: 'working-issues-group-title' }, count === null ? label : `${label} (${count})`));
    const groupBody = h('div', { id: `workingIssuesGroup-${id}`, class: 'working-issues-group-body' },
      id === 'active' ? activeContent : renderPendingWorklogs({
        entries: pending.entries, site: pending.site, now: pending.now,
        onEdit: pending.onEdit, onDiscard: pending.onDiscard, onSubmit: pending.onSubmit
      }));
    const header = h('div', { class: 'working-issues-group-header' }, h('h4', { class: 'working-issues-group-heading' }, toggle));
    const group = h('div', { class: `working-issues-group is-${id}`, 'data-group': id }, header, groupBody);

    const setExpanded = (isExpanded) => {
      toggle.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      group.classList.toggle('is-collapsed', !isExpanded);
      groupBody.classList.toggle('hidden', !isExpanded);
    };
    setExpanded(groupsExpanded[id] !== false);

    header.addEventListener('click', (event) => {
      // The click is this group's alone, not the section's.
      event.stopPropagation();
      const isExpanded = toggle.getAttribute('aria-expanded') !== 'true';
      setExpanded(isExpanded);
      onGroupToggle?.(id, isExpanded);
    });
    return group;
  }));
}

const RECENTLY_LOGGED_HINT = "Also show issues where you've logged work in the last 14 days, even if they're not currently assigned to you.";

/**
 * The Show Recently Logged Issues switch, Active's own, below the view tabs: the Settings switch's look, smaller, with
 * its label on the left. Keeps focus across re-renders (its focus key), and reports a flip through
 * `onChange`.
 *
 * @param {{ checked: boolean, onChange: (checked: boolean) => void }} recentlyLogged
 */
function renderRecentlyLoggedSwitch({ checked, onChange }) {
  const input = h('input', {
    type: 'checkbox',
    id: 'recentlyLoggedSwitch',
    class: 'switch-input',
    role: 'switch',
    'aria-describedby': 'recentlyLoggedHint',
    'data-focus-key': 'recently-logged'
  });
  input.checked = Boolean(checked);
  input.addEventListener('change', (event) => {
    event.stopPropagation();
    onChange(input.checked);
  });
  // The checkbox stays just before the drawn switch: `.switch-input:checked + .switch` styles it.
  return h('label', { class: 'switch-row working-issues-recent', for: 'recentlyLoggedSwitch', title: RECENTLY_LOGGED_HINT },
    h('span', {}, 'Show recently logged'),
    input,
    h('span', { class: 'switch', 'aria-hidden': 'true' }),
    h('span', { id: 'recentlyLoggedHint', class: 'sr-only' }, RECENTLY_LOGGED_HINT));
}

/**
 * @param {HTMLElement} section
 * @param {boolean} expanded
 */
function setWorkingIssuesExpanded(section, expanded) {
  section.querySelector('.working-issues-toggle').setAttribute('aria-expanded', expanded ? 'true' : 'false');
  section.classList.toggle('is-collapsed', !expanded);
  section.querySelector('.working-issues-body').classList.toggle('hidden', !expanded);
}

/**
 * Shows a weekday card's public holiday (or none): one icon on the right of the card's top row,
 * with the holiday's name as its tooltip and in the card's tooltip. (The Today badge is on the
 * day number's row, so the two never meet.)
 *
 * @param {HTMLElement} dayCard
 * @param {{ dayName: string, formattedDate: string, isToday: boolean }} day
 * @param {{ icon: string, label: string } | undefined} holiday
 */
function showHoliday(dayCard, day, holiday) {
  dayCard.title = holiday ? `${day.dayName}, ${day.formattedDate} · ${holiday.label}` : `${day.dayName}, ${day.formattedDate}`;
  dayCard.querySelector('.day-card-end')?.replaceChildren(...[
    holiday && h('span', { class: 'day-holiday', role: 'img', 'aria-label': `Public holiday: ${holiday.label}`, title: holiday.label }, holiday.icon)
  ].filter(Boolean));
}

/**
 * Updates the public holidays on the weekday cards already rendered, in place (focus and the
 * selected day's panel are untouched).
 *
 * @param {HTMLElement} container - As passed to renderWeek()
 * @param {{ weekDays: Array<object> }} week
 * @param {Map<string, { icon: string, label: string }>} holidays
 */
export function updateHolidays(container, week, holidays) {
  for (const day of week.weekDays || []) {
    const dayCard = container.querySelector(`.day-card[data-date-key="${day.dateKey}"]`);
    if (dayCard) showHoliday(dayCard, day, holidays.get(day.dateKey));
  }
}

/**
 * Renders the 7 weekday cards, the selected day's worklog panel, and the My Work section
 * into `container`. Daily totals and weekly totals are never modified by changing the selection.
 *
 * @param {HTMLElement} container
 * @param {{ weekDays: Array<object> }} week - Aggregated week from aggregateWorklogsByWeek()
 * @param {object} options
 * @param {string} options.selectedDateKey - Selected day; falls back to Monday when not in this week
 * @param {string} [options.baseUrl] - Jira instance URL used for issue links
 * @param {(dateKey: string) => void} options.onSelectDay - Called when a weekday card is clicked
 * @param {(dateKey: string) => void} [options.onAddWorklog] - Called with the selected day when its panel's add
 *   button is clicked; no add button without it
 * @param {(worklogId: string) => void} [options.onEditWorklog] - Called when a worklog's edit button is clicked; no edit buttons without it
 * @param {(worklogId: string) => void} [options.onLogWork] - Called when a worklog's log work button is clicked; no log work buttons without it
 * @param {(worklogId: string) => void} [options.onDeleteWorklog] - Called when a worklog's delete button is clicked; no delete buttons without it
 * @param {string} [options.editingWorklogId] - Worklog currently open in the editor, highlighted in the list
 * @param {object} [options.workingIssues] - Options for renderWorkingIssues() (without `baseUrl`); no
 *   My Work section without it. The section has the ID `workingIssues`.
 * @param {Map<string, { icon: string, label: string }>} [options.holidays] - Public holiday shown
 *   beside a weekday's name, by date key (src/holidays/publicHolidays.js); display only
 * @param {boolean} [options.dayExpanded] - Whether the selected day's panel shows its worklogs;
 *   collapsed otherwise. One state for every day.
 * @param {(expanded: boolean) => void} [options.onToggleDay] - Called after the selected day's
 *   panel header expands or collapses it
 */
export function renderWeek(container, week, { selectedDateKey, baseUrl = '', onSelectDay, onAddWorklog, onEditWorklog, onLogWork, onDeleteWorklog, editingWorklogId, workingIssues, holidays, dayExpanded = false, onToggleDay }) {
  container.replaceChildren();

  const weekDays = week.weekDays || [];
  const selectedDay = weekDays.find((d) => d.dateKey === selectedDateKey) || weekDays[0];
  if (!selectedDay) return;

  // 1. Weekday cards strip
  const strip = document.createElement('div');
  strip.className = 'week-strip';
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', 'Days of the week');

  weekDays.forEach((day) => {
    const isSelected = day === selectedDay;
    const fillPercent = Math.min(100, (day.totalDurationSeconds / DAY_INDICATOR_FULL_SECONDS) * 100);

    const dayCard = document.createElement('button');
    dayCard.type = 'button';
    const isWeekend = day.date.getDay() === 0 || day.date.getDay() === 6;
    dayCard.className = `day-card ${day.isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''} ${day.totalDurationSeconds > 0 ? 'has-time' : ''} ${isWeekend ? 'is-weekend' : ''}`;
    dayCard.dataset.dateKey = day.dateKey;
    dayCard.setAttribute('role', 'tab');
    dayCard.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    dayCard.setAttribute('aria-controls', 'selectedDayPanel');
    dayCard.append(
      h('span', { class: 'day-card-top' },
        h('span', { class: 'day-name' }, day.shortDayName),
        // The holiday icon, on the right (filled by showHoliday()).
        h('span', { class: 'day-card-end' })),
      // The day number, with the Today badge on the right of its row.
      h('span', { class: 'day-date-row' },
        h('span', { class: 'day-date' }, String(day.dayOfMonth)),
        day.isToday && h('span', { class: 'badge-today' }, 'Today')),
      h('span', { class: 'day-duration' }, day.formattedTotal),
      h('span', { class: 'day-count' }, `${day.worklogCount} ${day.worklogCount === 1 ? 'worklog' : 'worklogs'}`),
      h('span', { class: 'day-indicator', 'aria-hidden': 'true' },
        h('span', { class: 'day-indicator-fill', style: `width: ${fillPercent.toFixed(1)}%` }))
    );

    showHoliday(dayCard, day, holidays?.get(day.dateKey));

    dayCard.addEventListener('click', () => onSelectDay(day.dateKey));
    strip.appendChild(dayCard);
  });

  container.appendChild(strip);

  // 2. Selected-day worklogs panel
  const panel = document.createElement('section');
  panel.id = 'selectedDayPanel';
  panel.className = 'day-panel';
  panel.setAttribute('role', 'tabpanel');

  const countLabel = `${selectedDay.worklogCount} ${selectedDay.worklogCount === 1 ? 'worklog' : 'worklogs'}`;
  const addButton = onAddWorklog && h('button', {
    type: 'button', class: 'day-add-btn', 'data-date-key': selectedDay.dateKey, title: 'Add worklog',
    'aria-label': `Add worklog for ${selectedDay.dayName}, ${DAY_LABEL_FORMAT.format(selectedDay.date)}`
  },
  buttonIcon(
    svg('line', { x1: '12', y1: '5', x2: '12', y2: '19' }),
    svg('line', { x1: '5', y1: '12', x2: '19', y2: '12' })));
  addButton?.addEventListener('click', () => onAddWorklog(selectedDay.dateKey));

  // The header button expands and collapses the day's worklogs, as My Work's does; the
  // add button is beside it, not in it (buttons can't go in a button), so it never toggles.
  const toggle = h('button', { type: 'button', class: 'day-panel-toggle', 'aria-controls': 'selectedDayBody' },
    svg('svg', { class: 'day-panel-chevron', ...ICON_STROKE, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
      svg('polyline', { points: '6 9 12 15 18 9' })),
    h('span', { class: 'day-panel-titles' },
      h('span', { class: 'day-panel-title' }, `${selectedDay.dayName}, ${LONG_DATE_FORMAT.format(selectedDay.date)}`),
      h('span', { class: 'day-panel-meta' }, `${countLabel} \u2022 ${selectedDay.formattedTotal} total`)));
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    setDayPanelExpanded(panel, expanded);
    onToggleDay?.(expanded);
  });
  const header = h('div', { class: 'day-panel-header' },
    h('h3', { class: 'day-panel-heading' }, toggle),
    h('div', { class: 'day-panel-side' },
      h('span', { class: `day-panel-total ${selectedDay.totalDurationSeconds > 0 ? 'has-time' : ''}` }, selectedDay.formattedTotal),
      addButton));
  // A click elsewhere in the header (the day's total) toggles too; the add button doesn't.
  header.addEventListener('click', (event) => {
    if (!event.target.closest('button')) toggle.click();
  });
  const body = h('div', { id: 'selectedDayBody', class: 'day-panel-body' });
  panel.append(header, body);

  if (selectedDay.worklogs.length > 0) {
    const listEl = document.createElement('div');
    listEl.className = 'worklog-list';

    selectedDay.worklogs.forEach((wl) => {
      const itemEl = document.createElement('div');
      itemEl.className = `worklog-item ${editingWorklogId && String(wl.id) === editingWorklogId ? 'is-editing' : ''}`;
      itemEl.append(renderWorklogItem(wl, baseUrl, {
        editable: Boolean(onEditWorklog) && isEditableWorklog(wl),
        canLogWork: Boolean(onLogWork) && Boolean(wl.issueId || wl.issueKey),
        deletable: Boolean(onDeleteWorklog) && isEditableWorklog(wl)
      }));
      listEl.appendChild(itemEl);
    });

    if (onEditWorklog || onLogWork || onDeleteWorklog) {
      listEl.addEventListener('click', (event) => {
        const editBtn = event.target.closest('.worklog-edit-btn');
        if (editBtn) onEditWorklog?.(editBtn.dataset.worklogId);
        const logBtn = event.target.closest('.worklog-log-btn');
        if (logBtn) onLogWork?.(logBtn.dataset.worklogId);
        const deleteBtn = event.target.closest('.worklog-delete-btn');
        if (deleteBtn) onDeleteWorklog?.(deleteBtn.dataset.worklogId);
      });
    }

    body.appendChild(listEl);
  } else {
    const emptyPlaceholder = document.createElement('div');
    emptyPlaceholder.className = 'empty-day-placeholder';
    emptyPlaceholder.textContent = 'No worklogs logged for this day.';
    body.appendChild(emptyPlaceholder);
  }

  setDayPanelExpanded(panel, dayExpanded);
  container.appendChild(panel);

  // 3. My Work, below the selected day's worklogs: the user's issues in progress or with
  // work logged recently
  if (workingIssues) {
    const section = h('section', { id: 'workingIssues', class: 'working-issues', 'aria-label': 'My Work' });
    renderWorkingIssues(section, { ...workingIssues, baseUrl });
    container.appendChild(section);
  }
}

/**
 * Shows or hides the selected day's worklogs, keeping its header (date, count, and total).
 * @param {HTMLElement} panel
 * @param {boolean} expanded
 */
function setDayPanelExpanded(panel, expanded) {
  panel.querySelector('.day-panel-toggle').setAttribute('aria-expanded', expanded ? 'true' : 'false');
  panel.classList.toggle('is-collapsed', !expanded);
  panel.querySelector('.day-panel-body').classList.toggle('hidden', !expanded);
}
