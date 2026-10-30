/**
 * The Pending tab of My Active Issues: the stopped timer sessions kept in this browser
 * (`timeTracking.pending`, see src/timer/timeTrackingStore.js), one row each, with Submit, Edit,
 * and Discard. Pure DOM rendering; the page controller submits (src/worklog/pendingSubmission.js),
 * edits, and discards.
 */

import { h, svg } from './dom.js';
import { formatDuration, formatWorklogDate } from '../worklog/worklogUtils.js';
import { isTooShort, submissionStatus } from '../timer/timeTrackingStore.js';

const ICON_STROKE = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' };
const buttonIcon = (...shapes) => svg('svg', {
  class: 'icon', ...ICON_STROKE, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
}, ...shapes);

/**
 * A pending worklog's duration: hours and minutes like the worklog cards ("1h 05m"), or seconds
 * under a minute ("45s"), so a short session never reads as nothing.
 * @param {number} seconds
 * @returns {string}
 */
export function formatPendingDuration(seconds) {
  return seconds < 60 ? `${Math.max(0, seconds)}s` : formatDuration(seconds, { padZeroMinutes: true, alwaysShowHours: true });
}

/**
 * The start time in the worklog cards' format (local "HH:MM").
 * @param {Date} date
 * @returns {string}
 */
export function formatPendingStartTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The Jira site's address from a site ID (`${deploymentType}|${baseUrl}`).
 * @param {string} site
 * @returns {string}
 */
export function siteBaseUrl(site) {
  return String(site).slice(String(site).indexOf('|') + 1);
}

function siteHost(site) {
  try {
    return new URL(siteBaseUrl(site)).host;
  } catch {
    return siteBaseUrl(site);
  }
}

/**
 * Why a pending worklog can't be submitted now, or '' when it can. Its button is then marked
 * disabled (aria-disabled, so the reason stays readable as its tooltip).
 * @param {object} entry
 * @param {string} currentSite
 * @param {string | null} status - submissionStatus()
 * @returns {string}
 */
export function submitBlockedReason(entry, currentSite, status) {
  if (status === 'submitting') return 'Being submitted to Jira…';
  if (entry.site !== currentSite) return `Tracked on ${siteHost(entry.site)}. Connect to that Jira site to submit it.`;
  if (isTooShort(entry)) return 'Jira needs at least 1 minute. Edit the duration before submitting it.';
  return '';
}

// How each submission state shows on its row: a flag, and its tooltip.
const SUBMISSION_FLAGS = {
  submitting: { label: 'Submitting…', className: 'is-busy', title: () => 'Being submitted to Jira.' },
  failed: { label: 'Not submitted', className: 'is-danger', title: (entry) => entry.submission?.message || "Jira didn't accept it. Nothing was created." },
  uncertain: {
    label: 'May be in Jira',
    className: 'is-warning',
    title: () => "Jira didn't answer, so it may already have this worklog. Submitting it again checks Jira first, so it's never added twice."
  }
};

/**
 * Builds one pending worklog row.
 * @param {object} entry - A pending worklog, as stored
 * @param {string} currentSite - The connected Jira site's ID
 * @param {number} now - For submissionStatus()
 * @returns {HTMLElement}
 */
function renderPendingWorklog(entry, currentSite, now) {
  const started = new Date(entry.startedAt);
  const startTime = formatPendingStartTime(started);
  const baseUrl = siteBaseUrl(entry.site).replace(/\/+$/, '');
  const otherSite = entry.site !== currentSite;
  const short = isTooShort(entry);
  const status = submissionStatus(entry, now);
  const flag = SUBMISSION_FLAGS[status];
  const blocked = submitBlockedReason(entry, currentSite, status);
  // Edit waits for a submission's outcome, and isn't offered once Jira may have the worklog.
  const editBlocked = status === 'submitting' || status === 'uncertain'
    ? (status === 'submitting' ? 'Being submitted to Jira…' : 'Jira may already have it. Submit it again to check, or discard it.')
    : '';

  return h('li', {
    class: `pending-worklog${short ? ' is-too-short' : ''}${otherSite ? ' is-other-site' : ''}${status ? ` is-${status}` : ''}`,
    'data-pending-id': entry.id
  },
    h('a', { href: `${baseUrl}/browse/${encodeURIComponent(entry.issueKey)}`, target: '_blank', rel: 'noopener noreferrer', class: 'issue-key-badge', title: `Open ${entry.issueKey} in Jira` },
      entry.issueKey),
    h('div', { class: 'pending-worklog-main' },
      h('span', { class: 'pending-worklog-summary', title: entry.issueSummary || '' }, entry.issueSummary || 'No summary available'),
      h('span', { class: 'pending-worklog-meta' },
        h('span', { class: 'pending-worklog-when' }, `${formatWorklogDate(started)}, ${startTime}`),
        short && h('span', { class: 'pending-flag is-warning', title: 'Jira needs at least 1 minute. Edit the duration before submitting it.' }, 'Under 1 minute'),
        otherSite && h('span', { class: 'pending-flag', title: `Tracked on ${siteHost(entry.site)}. It can only be submitted there.` },
          `Other site · ${siteHost(entry.site)}`),
        flag && h('span', { class: `pending-flag ${flag.className}`, title: flag.title(entry) }, flag.label))),
    h('span', { class: 'pending-worklog-duration' }, formatPendingDuration(entry.timeSpentSeconds)),
    h('div', { class: 'worklog-actions' },
      h('button', {
        type: 'button', class: 'pending-submit-btn', 'data-pending-id': entry.id, 'data-focus-key': `submit:${entry.id}`,
        'aria-label': `Submit pending worklog for ${entry.issueKey}, started ${startTime}, to Jira`,
        title: blocked || (status === 'uncertain' ? 'Check Jira and submit' : 'Submit to Jira'),
        'aria-disabled': blocked ? 'true' : undefined
      }, buttonIcon(
        svg('line', { x1: '22', y1: '2', x2: '11', y2: '13' }),
        svg('polygon', { points: '22 2 15 22 11 13 2 9 22 2' }))),
      h('button', {
        type: 'button', class: 'pending-edit-btn', 'data-pending-id': entry.id, 'data-focus-key': `edit:${entry.id}`,
        'aria-label': `Edit pending worklog for ${entry.issueKey}, started ${startTime}`, title: editBlocked || 'Edit pending worklog',
        'aria-disabled': editBlocked ? 'true' : undefined
      }, buttonIcon(
        svg('path', { d: 'M12 20h9' }),
        svg('path', { d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' }))),
      h('button', {
        type: 'button', class: 'pending-discard-btn', 'data-pending-id': entry.id, 'data-focus-key': `discard:${entry.id}`,
        'aria-label': `Discard pending worklog for ${entry.issueKey}, started ${startTime}`, title: 'Discard pending worklog'
      }, buttonIcon(
        svg('polyline', { points: '3 6 5 6 21 6' }),
        svg('path', { d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }),
        svg('path', { d: 'M10 11v6' }),
        svg('path', { d: 'M14 11v6' }),
        svg('path', { d: 'M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' })))));
}

/**
 * Builds the Pending tab's contents: every pending worklog, each on its own row (sessions are never
 * merged), most recently stopped first; or a short note when there are none.
 *
 * @param {object} options
 * @param {Array<object>} options.entries - `timeTracking.pending`, in stored order
 * @param {string} options.site - The connected Jira site's ID; others are marked, never hidden
 * @param {number} [options.now=Date.now()] - For a submission left running too long (submissionStatus())
 * @param {(id: string) => void} options.onEdit
 * @param {(id: string) => void} options.onDiscard
 * @param {(id: string) => void} [options.onSubmit] - Also called for a disabled Submit, for the page to say why
 * @returns {HTMLElement}
 */
export function renderPendingWorklogs({ entries, site, now = Date.now(), onEdit, onDiscard, onSubmit }) {
  if (entries.length === 0) {
    return h('p', { class: 'working-issues-empty' },
      'No pending worklogs. When you stop a timer, its time waits here until you submit or discard it.');
  }

  const list = h('ul', { class: 'pending-worklogs' }, [...entries].reverse().map((entry) => renderPendingWorklog(entry, site, now)));
  list.addEventListener('click', (event) => {
    const button = event.target.closest('.pending-submit-btn, .pending-edit-btn, .pending-discard-btn');
    if (!button) return;
    // The click is the button's alone, not the row's or the section's.
    event.stopPropagation();
    if (button.classList.contains('pending-submit-btn')) onSubmit?.(button.dataset.pendingId);
    else if (button.classList.contains('pending-edit-btn')) onEdit(button.dataset.pendingId);
    else onDiscard(button.dataset.pendingId);
  });
  return list;
}

// The confirmation's wording for discarding a pending worklog (openDeleteWorklogDialog()).
export const DISCARD_PENDING_WORDING = {
  title: 'Discard pending worklog?',
  text: "This removes the tracked time from this browser. It was never sent to Jira, and it can't be recovered.",
  confirm: 'Discard',
  busy: 'Discarding…'
};
