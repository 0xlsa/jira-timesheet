/**
 * Weekly view presentation: weekday cards and the selected day's worklog panel.
 * Pure DOM rendering; state and data loading stay with the page controller.
 */

import { h, svg, fragment } from './dom.js';
import { isEditableWorklog } from '../worklog/worklogEdit.js';
import { elapsedSeconds, isSameIssue, isPaused } from '../timer/timeTrackingStore.js';
import { renderPendingWorklogs, siteBaseUrl } from './pendingWorklogs.js';

// Daily duration that fills a weekday card's indicator bar (visual only).
const DAY_INDICATOR_FULL_SECONDS = 8 * 60 * 60;

const LONG_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric'
});

// The add button's accessible label ("26 October").
const DAY_LABEL_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' });

// Subtitle of the My Active Issues section, by state.
const WORKING_ISSUES_SUBTITLES = {
  loading: 'Retrieving issues from Jira…',
  ready: 'In progress and recently logged',
  error: "Couldn't retrieve issues from Jira"
};

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
 * Updates the running timer's elapsed times in a My Active Issues section (its row and the header)
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
 * @param {object} issue - A My Active Issues row's issue
 * @param {{ site: string, running: object | null }} timer
 * @returns {boolean}
 */
function isTimedIssue(issue, timer) {
  return Boolean(timer.running) &&
    isSameIssue(timer.running, { site: issue.site ?? timer.site, issueId: String(issue.issueId ?? ''), issueKey: issue.issueKey });
}

/**
 * The rows to list: Jira's issues, with the running timer's issue first when Jira didn't return it
 * (a timer started from the Log work panel on an issue that isn't in progress or logged this week),
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
 * @returns {HTMLElement}
 */
function renderIssueTimer(issue, timer) {
  const timed = isTimedIssue(issue, timer);
  const paused = timed && isPaused(timer.running);
  const inactive = Boolean(timer.busy || timer.unavailable);
  const focusKey = `${issue.site ?? timer.site}|${issue.issueKey}`;
  // The first button keeps its place through start, pause, and resume, so focus stays on it.
  const button = (action, slot) => h('button', {
    type: 'button',
    class: `working-issue-timer-btn${action === 'stop' ? ' is-running' : ''}${action === 'resume' ? ' is-paused' : ''}`,
    'data-issue-key': issue.issueKey,
    'data-timer-action': action,
    'data-focus-key': `${slot}:${focusKey}`,
    'aria-label': TIMER_ACTIONS[action].label(issue.issueKey),
    title: timer.unavailable || TIMER_ACTIONS[action].title,
    'aria-disabled': inactive ? 'true' : undefined
  }, renderTimerIcon(TIMER_ACTIONS[action].icon));

  return h('span', { class: 'working-issue-timer' },
    timed && renderElapsed(timer.running, timer.now, 'working-issue-elapsed'),
    button(!timed ? 'start' : paused ? 'resume' : 'pause', 'timer'),
    timed && button('stop', 'timer-stop'));
}

/**
 * A timer button's icon: 'play' (start or resume), 'pause', or 'stop' (a square). For the Log work
 * panel, `true` is stop and `false` play. Shared by My Active Issues and the Log work panel.
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
 * Builds one row of the My Active Issues list: issue key (a link to Jira), summary, status, the
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
 * @returns {HTMLElement}
 */
function renderWorkingIssue(issue, baseUrl, canLogWork, timer, index) {
  const otherSite = Boolean(issue.site && timer && issue.site !== timer.site);
  const issueBaseUrl = otherSite ? siteBaseUrl(issue.site) : baseUrl;
  return h('li', { class: `working-issue${timer ? ' has-timer' : ''}${issue.timerOnly ? ' is-timer-only' : ''}`, 'data-row-index': String(index) },
    h('a', { href: issueBrowseUrl(issueBaseUrl, issue.issueKey), target: '_blank', rel: 'noopener noreferrer', class: 'issue-key-badge', title: `Open ${issue.issueKey} in Jira` },
      issue.issueKey),
    h('span', { class: 'working-issue-summary', title: issue.issueSummary || '' }, issue.issueSummary),
    h('span', { class: 'working-issue-status' }, renderIssueStatusBadge(issue.issueStatus)),
    timer && renderIssueTimer(issue, timer),
    canLogWork && !otherSite && h('button', { type: 'button', class: 'working-issue-log-btn', 'data-issue-key': issue.issueKey, 'aria-label': `Log work on ${issue.issueKey}`, title: 'Log work' },
      buttonIcon(
        svg('line', { x1: '12', y1: '5', x2: '12', y2: '19' }),
        svg('line', { x1: '5', y1: '12', x2: '19', y2: '12' }))));
}

/**
 * Fills the header's running-timer indicator: the issue and its elapsed time, or nothing (hidden)
 * when no timer runs. It's in the header, so it shows while the section is collapsed too.
 * @param {HTMLElement} indicator
 * @param {object} [timer]
 */
function renderHeaderTimer(indicator, timer) {
  const running = timer?.running;
  indicator.classList.toggle('hidden', !running);
  if (!running) {
    indicator.replaceChildren();
    indicator.removeAttribute('title');
    return;
  }
  const paused = isPaused(running);
  const state = paused ? 'paused' : 'running';
  indicator.classList.toggle('is-paused', paused);
  indicator.setAttribute('title', `Timer ${state} on ${running.issueKey}${running.issueSummary ? `: ${running.issueSummary}` : ''}`);
  // fragment() leaves out the Paused label while running (replaceChildren() would show `false`).
  indicator.replaceChildren(fragment(
    h('span', { class: 'working-issues-timer-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'sr-only' }, `Timer ${state} on `),
    h('span', { class: 'working-issues-timer-key' }, running.issueKey),
    h('span', { class: 'sr-only' }, ', '),
    renderElapsed(running, timer.now, 'working-issues-timer-elapsed'),
    paused && h('span', { class: 'working-issues-timer-state' }, 'Paused')));
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
 * Renders the My Active Issues section: a header button that expands and collapses it (count and
 * subtitle included), and below it the issues, or why there are none to show. The first call
 * builds the header; later calls on the same section update it in place, so the header button
 * keeps focus when the issues arrive.
 *
 * @param {HTMLElement} section
 * @param {object} options
 * @param {{ status: 'loading' | 'ready' | 'error', issues?: Array<object>, message?: string }} options.state -
 *   `issues` when ready (JiraClient.getActiveIssues(): each with `inProgress` and `loggedThisWeek`),
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
 * @param {object} [options.pending] - The pending worklogs; with them, the expanded section has Active Issues
 *   and Pending tabs (the header, collapsed or not, stays the same)
 * @param {Array<object>} options.pending.entries - `timeTracking.pending`, as stored
 * @param {string} options.pending.site - The connected Jira site's ID
 * @param {'active' | 'pending'} options.pending.tab - The tab to show
 * @param {(tab: 'active' | 'pending') => void} [options.pending.onTabChange] - Called after the user switches tabs
 * @param {(id: string) => void} options.pending.onEdit - Called with a pending worklog's ID from its Edit button
 * @param {(id: string) => void} options.pending.onDiscard - Called with a pending worklog's ID from its Discard button
 * @param {(id: string) => void} [options.pending.onSubmit] - Called with a pending worklog's ID from its Submit button
 * @param {number} [options.pending.now] - For a submission left running too long
 */
export function renderWorkingIssues(section, { state, expanded, baseUrl = '', onToggle, onRetry, onLogWork, timer, pending }) {
  let toggle = section.querySelector('.working-issues-toggle');
  if (!toggle) {
    toggle = h('button', { type: 'button', class: 'working-issues-toggle', 'aria-controls': 'workingIssuesBody' },
      svg('svg', { class: 'working-issues-chevron', ...ICON_STROKE, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
        svg('polyline', { points: '6 9 12 15 18 9' })),
      h('span', { class: 'working-issues-titles' },
        h('span', { class: 'working-issues-title' }, 'My Active Issues'),
        h('span', { class: 'working-issues-subtitle' }),
        h('span', { class: 'working-issues-pending-count hidden' })),
      h('span', { class: 'working-issues-timer hidden' }),
      h('span', { class: 'working-issues-indicator' }));
    toggle.addEventListener('click', () => {
      const isExpanded = toggle.getAttribute('aria-expanded') !== 'true';
      setWorkingIssuesExpanded(section, isExpanded);
      onToggle?.(isExpanded);
    });
    section.replaceChildren(
      h('h3', { class: 'working-issues-heading' }, toggle),
      h('div', { id: 'workingIssuesBody', class: 'working-issues-body' }));
  }

  // One row per issue, and the badge counts the rows.
  const issues = state.status === 'ready' ? uniqueIssues(state.issues || []) : [];
  section.className = `working-issues is-${state.status}`;

  // When ready, the subtitle leads with how many issues are listed ("9 issues · In progress and …").
  const subtitle = WORKING_ISSUES_SUBTITLES[state.status] || '';
  toggle.querySelector('.working-issues-subtitle').textContent = state.status === 'ready'
    ? `${issues.length} ${issues.length === 1 ? 'issue' : 'issues'} · ${subtitle}`
    : subtitle;
  toggle.querySelector('.working-issues-indicator').replaceChildren(fragment(
    state.status === 'loading' && h('span', { class: 'working-issues-spinner', 'aria-hidden': 'true' })));
  renderHeaderTimer(toggle.querySelector('.working-issues-timer'), timer);
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
  const list = rows.length > 0 && h('ul', { class: 'working-issues-list' },
    rows.map((issue, index) => renderWorkingIssue(issue, baseUrl, Boolean(onLogWork), timer, index)));
  if (list && (onLogWork || timer)) {
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
      // An unavailable timer still answers the click (the page explains why); a busy one doesn't.
      else if (timer.busy) return;
      else if (timerBtn.dataset.timerAction === 'stop') timer.onStop();
      else if (timerBtn.dataset.timerAction === 'pause') timer.onPause?.();
      else if (timerBtn.dataset.timerAction === 'resume') timer.onResume?.();
      else timer.onStart(issue);
    });
  }

  // Rebuilding the body replaces the button that had focus (Start becomes Stop, a tab re-renders):
  // give focus to the new one with the same focus key.
  const focusKey = section.ownerDocument?.activeElement?.closest?.('[data-focus-key]')?.dataset.focusKey;

  const errorMessage = state.status === 'error' && h('div', { class: 'working-issues-message', role: 'status' },
    h('p', {}, state.message || WORKING_ISSUES_SUBTITLES[state.status]),
    retryButton);

  const body = section.querySelector('.working-issues-body');
  if (pending) {
    // The tab counts what its list shows, from the start: 0 until Jira's issues are in.
    body.replaceChildren(renderWorkingIssuesTabs(pending, rows.length,
      fragment(
        list,
        errorMessage,
        state.status === 'loading' && h('p', { class: 'working-issues-empty' }, WORKING_ISSUES_SUBTITLES.loading),
        state.status === 'ready' && !list && h('p', { class: 'working-issues-empty' }, 'No issues in progress or logged this week.'))));
  } else {
    body.replaceChildren(fragment(list, errorMessage));
  }
  // Nothing to show below the header (loading, or no issues, without tabs).
  body.classList.toggle('is-empty', body.childNodes.length === 0);

  setWorkingIssuesExpanded(section, expanded);

  if (focusKey) {
    const all = [...body.querySelectorAll('[data-focus-key]')];
    // A pending worklog that's gone (discarded) leaves focus on the Pending tab.
    const target = all.find((el) => el.dataset.focusKey === focusKey) ||
      // Stop leaves the issue's other timer button (now Start); a submitted or discarded pending
      // worklog leaves the Pending tab.
      (focusKey.startsWith('timer-stop:') ? all.find((el) => el.dataset.focusKey === `timer:${focusKey.slice('timer-stop:'.length)}`) : null) ||
      (/^(edit|discard|submit):/.test(focusKey) ? all.find((el) => el.dataset.focusKey === 'tab:pending') : null);
    target?.focus();
  }
}

/**
 * "1 pending worklog", "2 pending worklogs": sessions, not issues.
 * @param {number} count
 * @returns {string}
 */
export function formatPendingCount(count) {
  return `${count} pending ${count === 1 ? 'worklog' : 'worklogs'}`;
}

const TABS = [
  { id: 'active', label: 'Active Issues' },
  { id: 'pending', label: 'Pending' }
];

// The tabs are the app's buttons: the selected one primary, the other secondary.
const TAB_SELECTED_CLASS = 'btn-primary';
const TAB_UNSELECTED_CLASS = 'btn-secondary';

/**
 * Builds the Active Issues and Pending tabs and their panels. Switching tabs only shows the other
 * panel; it never changes the timer or a pending worklog.
 *
 * Each tab counts what its panel lists: "Active Issues (5)" its rows (Jira's issues, and the
 * running timer's issue when Jira doesn't list it); "Pending (2)" the pending worklogs, one per
 * stopped session, so two sessions on one issue count twice.
 *
 * @param {object} pending - renderWorkingIssues()'s `pending` options
 * @param {number} activeCount - Rows in the Active Issues list (0 while Jira's issues load or
 *   failed, unless the running timer's issue is listed)
 * @param {DocumentFragment} activeContent - The Active Issues panel's contents
 * @returns {DocumentFragment}
 */
function renderWorkingIssuesTabs(pending, activeCount, activeContent) {
  const selected = pending.tab === 'pending' ? 'pending' : 'active';
  const counts = { active: activeCount, pending: pending.entries.length };
  const tabButtons = TABS.map(({ id, label }) => h('button', {
    type: 'button',
    role: 'tab',
    id: `workingIssuesTab-${id}`,
    class: `btn working-issues-tab ${id === selected ? TAB_SELECTED_CLASS : TAB_UNSELECTED_CLASS}`,
    'data-tab': id,
    'data-focus-key': `tab:${id}`,
    'aria-controls': `workingIssuesPanel-${id}`,
    'aria-selected': String(id === selected),
    tabindex: id === selected ? '0' : '-1'
  }, `${label} (${counts[id]})`));

  const panels = TABS.map(({ id }) => h('div', {
    role: 'tabpanel',
    id: `workingIssuesPanel-${id}`,
    class: `working-issues-panel${id === selected ? '' : ' hidden'}`,
    'aria-labelledby': `workingIssuesTab-${id}`
  }, id === 'active' ? activeContent : renderPendingWorklogs({
    entries: pending.entries, site: pending.site, now: pending.now,
    onEdit: pending.onEdit, onDiscard: pending.onDiscard, onSubmit: pending.onSubmit
  })));

  const tablist = h('div', { class: 'working-issues-tabs', role: 'tablist', 'aria-label': 'My Active Issues' }, tabButtons);

  const select = (id, { focus = false } = {}) => {
    for (const tab of tabButtons) {
      const isSelected = tab.dataset.tab === id;
      tab.setAttribute('aria-selected', String(isSelected));
      tab.setAttribute('tabindex', isSelected ? '0' : '-1');
      tab.classList.toggle(TAB_SELECTED_CLASS, isSelected);
      tab.classList.toggle(TAB_UNSELECTED_CLASS, !isSelected);
      if (isSelected && focus) tab.focus();
    }
    for (const panel of panels) panel.classList.toggle('hidden', panel.id !== `workingIssuesPanel-${id}`);
    pending.onTabChange?.(id);
  };

  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab) return;
    event.stopPropagation();
    select(tab.dataset.tab);
  });
  // Arrow keys, Home, and End move between the tabs (WAI-ARIA tabs pattern).
  tablist.addEventListener('keydown', (event) => {
    const index = tabButtons.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabButtons.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(tabButtons[(next + tabButtons.length) % tabButtons.length].dataset.tab, { focus: true });
  });

  return fragment(tablist, panels);
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
 * Renders the 7 weekday cards, the My Active Issues section, and the selected day's worklog panel
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
 *   My Active Issues section without it. The section has the ID `workingIssues`.
 * @param {Map<string, { icon: string, label: string }>} [options.holidays] - Public holiday shown
 *   beside a weekday's name, by date key (src/holidays/publicHolidays.js); display only
 */
export function renderWeek(container, week, { selectedDateKey, baseUrl = '', onSelectDay, onAddWorklog, onEditWorklog, onLogWork, onDeleteWorklog, editingWorklogId, workingIssues, holidays }) {
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

  // 2. My Active Issues: the user's issues in progress or with work logged this week
  if (workingIssues) {
    const section = h('section', { id: 'workingIssues', class: 'working-issues', 'aria-label': 'My Active Issues' });
    renderWorkingIssues(section, { ...workingIssues, baseUrl });
    container.appendChild(section);
  }

  // 3. Selected-day worklogs panel
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

  panel.append(
    h('div', { class: 'day-panel-header' },
      h('div', {},
        h('h3', { class: 'day-panel-title' }, `${selectedDay.dayName}, ${LONG_DATE_FORMAT.format(selectedDay.date)}`),
        h('span', { class: 'day-panel-meta' }, `${countLabel} \u2022 ${selectedDay.formattedTotal} total`)),
      h('div', { class: 'day-panel-side' },
        h('span', { class: `day-panel-total ${selectedDay.totalDurationSeconds > 0 ? 'has-time' : ''}` }, selectedDay.formattedTotal),
        addButton))
  );

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

    panel.appendChild(listEl);
  } else {
    const emptyPlaceholder = document.createElement('div');
    emptyPlaceholder.className = 'empty-day-placeholder';
    emptyPlaceholder.textContent = 'No worklogs logged for this day.';
    panel.appendChild(emptyPlaceholder);
  }

  container.appendChild(panel);
}
