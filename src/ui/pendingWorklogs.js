/**
 * The Pending Worklogs group of My Work: the stopped timer sessions kept in this browser
 * (`timeTracking.pending`, see src/timer/timeTrackingStore.js), one row each, with Submit, Edit,
 * and Discard, and a ⋯ menu to file it under Pending or On Hold. Tabs above the rows show
 * one classification at a time (src/worklog/pendingClassification.js), and Select turns on
 * selection mode: a checkbox on each row, Select all and Deselect all, and a bar that moves the
 * selected worklogs at once. Pure DOM rendering; the page controller keeps the selection, and
 * submits (src/worklog/pendingSubmission.js), edits, discards, and classifies.
 */

import { fragment, h, svg } from './dom.js';
import { formatDuration, formatWorklogDate } from '../worklog/worklogUtils.js';
import { DEFAULT_CLASSIFICATION, isTooShort, submissionStatus } from '../timer/timeTrackingStore.js';
import {
  CLASSIFICATIONS, bulkActions, classificationLabel, entriesIn, isClassification, summarizeClassifications
} from '../worklog/pendingClassification.js';

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
 * Every pending worklog's time, in seconds: each stored session counts, on any Jira site, so the
 * total is the sum of the rows' durations.
 * @param {Array<{ timeSpentSeconds?: number }>} entries - `timeTracking.pending`
 * @returns {number}
 */
export function pendingTotalSeconds(entries) {
  return (entries ?? []).reduce((total, entry) => total + Math.max(0, Number(entry?.timeSpentSeconds) || 0), 0);
}

/**
 * The Pending Worklogs header's total, in the rows' format (formatPendingDuration()): "1h 05m",
 * "45s" under a minute, and "0h 00m" when nothing is pending.
 * @param {number} seconds - pendingTotalSeconds()
 * @returns {string}
 */
export function formatPendingTotal(seconds) {
  return seconds > 0 ? formatPendingDuration(seconds) : formatDuration(0, { padZeroMinutes: true, alwaysShowHours: true });
}

/**
 * The bulk bar's summary of the selection: how many, and their total time ("2 selected · 20h 10m").
 * @param {number} count
 * @param {number} seconds
 * @returns {string}
 */
export function formatSelectionSummary(count, seconds) {
  return `${count} selected · ${formatPendingTotal(seconds)}`;
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
 * @param {object} options
 * @param {boolean} options.menu - Add the ⋯ button
 * @param {boolean | null} options.selected - In selection mode, whether it's selected (a checkbox
 *   first); null otherwise
 * @param {string} [options.notMoved] - Why the last bulk change didn't move it, flagged on the row
 * @returns {HTMLElement}
 */
function renderPendingWorklog(entry, currentSite, now, { menu, selected, notMoved }) {
  const started = new Date(entry.startedAt);
  const startTime = formatPendingStartTime(started);
  // Added to the date and start time when there is one; whitespace alone counts as none.
  const comment = (entry.comment ?? '').trim();
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

  const selecting = selected !== null;
  return h('li', {
    class: `pending-worklog${short ? ' is-too-short' : ''}${otherSite ? ' is-other-site' : ''}${status ? ` is-${status}` : ''}${selected ? ' is-selected' : ''}${notMoved ? ' is-not-moved' : ''}`,
    'data-pending-id': entry.id
  },
    selecting && h('input', {
      type: 'checkbox', class: 'pending-select-checkbox', 'data-pending-id': entry.id, 'data-focus-key': `select:${entry.id}`,
      'aria-label': `Select pending worklog for ${entry.issueKey}, started ${startTime}`,
      checked: selected
    }),
    h('a', { href: `${baseUrl}/browse/${encodeURIComponent(entry.issueKey)}`, target: '_blank', rel: 'noopener noreferrer', class: 'issue-key-badge', title: `Open ${entry.issueKey} in Jira` },
      entry.issueKey),
    h('div', { class: 'pending-worklog-main' },
      h('span', { class: 'pending-worklog-summary', title: entry.issueSummary || '' }, entry.issueSummary || 'No summary available'),
      h('span', { class: 'pending-worklog-meta' },
        h('span', { class: 'pending-worklog-when' }, `${formatWorklogDate(started)}, ${startTime}${comment ? ` - ${comment}` : ''}`),
        short && h('span', { class: 'pending-flag is-warning', title: 'Jira needs at least 1 minute. Edit the duration before submitting it.' }, 'Under 1 minute'),
        otherSite && h('span', { class: 'pending-flag', title: `Tracked on ${siteHost(entry.site)}. It can only be submitted there.` },
          `Other site · ${siteHost(entry.site)}`),
        flag && h('span', { class: `pending-flag ${flag.className}`, title: flag.title(entry) }, flag.label),
        notMoved && h('span', { class: 'pending-flag is-danger pending-not-moved', title: notMoved }, 'Not moved'))),
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
        svg('path', { d: 'M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' }))),
      menu && h('button', {
        type: 'button', class: 'pending-menu-btn', 'data-pending-id': entry.id, 'data-focus-key': `menu:${entry.id}`,
        'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'pendingActionsMenu',
        'aria-label': `More actions for pending worklog for ${entry.issueKey}, started ${startTime}`,
        // Its classification waits for a submission's outcome, like Edit.
        title: status === 'submitting' ? 'Being submitted to Jira…' : 'More actions',
        'aria-disabled': status === 'submitting' ? 'true' : undefined
      }, buttonIcon(
        svg('circle', { cx: '5', cy: '12', r: '1' }),
        svg('circle', { cx: '12', cy: '12', r: '1' }),
        svg('circle', { cx: '19', cy: '12', r: '1' })))));
}

// What an empty tab says. Nothing pending at all says the same in every tab.
const EMPTY_NOTES = {
  none: 'No pending worklogs. When you stop a timer, its time waits here until you submit or discard it.',
  ready: 'Nothing is pending.',
  'on-hold': 'Nothing is on hold.'
};

/**
 * The classification tabs, side by side, each with its count, in the view tabs' shape and each in
 * its own color (blue Pending, amber On Hold; see options.css). A tablist
 * (WAI-ARIA tabs): the selected tab is the one in the tab order, and the arrow keys, Home, and End
 * choose another. Each tab's tooltip gives its total time.
 * @param {string} tab - The selected classification
 * @param {ReturnType<typeof summarizeClassifications>} summary
 * @param {(tab: string) => void} [onSelectTab]
 * @returns {HTMLElement}
 */
function renderClassificationTabs(tab, summary, onSelectTab) {
  const buttons = CLASSIFICATIONS.map(({ id, label }) => h('button', {
    type: 'button',
    role: 'tab',
    id: `pendingTab-${id}`,
    class: `working-issues-view-tab pending-tab is-${id}${id === tab ? ' is-selected' : ''}`,
    'data-classification': id,
    'data-focus-key': `pending-tab:${id}`,
    'aria-controls': 'pendingWorklogsPanel',
    'aria-selected': String(id === tab),
    tabindex: id === tab ? '0' : '-1',
    title: `${label}: ${formatPendingTotal(summary[id].seconds)}`
  },
    h('span', { class: 'working-issues-view-tab-name' }, label),
    h('span', { class: 'working-issues-view-tab-count' }, ` (${summary[id].count})`)));

  const tablist = h('div', { class: 'pending-tabs', role: 'tablist', 'aria-label': 'Worklogs by classification' }, buttons);
  const select = (id) => {
    if (id !== tab) onSelectTab?.(id);
  };
  tablist.addEventListener('click', (event) => {
    const button = event.target.closest('[role="tab"]');
    if (!button) return;
    event.stopPropagation();
    select(button.dataset.classification);
  });
  tablist.addEventListener('keydown', (event) => {
    const index = buttons.findIndex((button) => button.dataset.classification === tab);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: buttons.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    // Focus first, so it's on the new tab once the group is drawn again.
    const target = buttons[(next + buttons.length) % buttons.length];
    target.focus();
    select(target.dataset.classification);
  });
  return tablist;
}

/**
 * A text button of the selection bar. Unavailable, it stays focusable (aria-disabled), so focus
 * isn't lost when Select all has just selected everything.
 */
function selectionButton(className, focusKey, text, unavailable, extra = {}) {
  return h('button', {
    type: 'button', class: `pending-selection-btn ${className}`, 'data-focus-key': focusKey,
    'aria-disabled': unavailable ? 'true' : undefined, ...extra
  }, text);
}

/**
 * Selection mode's bar, below the tabs: Select all and Deselect all, then, with one or more
 * worklogs selected, how many and their total time, and the classifications they can move to.
 * After a bulk change that didn't move every worklog, a line below names the ones left (they stay
 * selected, each flagged on its row).
 * @param {Array<object>} tabEntries - Every worklog in the selected tab
 * @param {Array<object>} chosen - The selected ones
 * @param {object} selection - renderPendingWorklogs()'s `selection`
 * @returns {HTMLElement}
 */
function renderSelectionBar(tabEntries, chosen, selection) {
  const all = tabEntries.length > 0 && chosen.length === tabEntries.length;
  const seconds = chosen.reduce((total, entry) => total + Math.max(0, Number(entry.timeSpentSeconds) || 0), 0);
  const actions = bulkActions(chosen);

  const bar = h('div', { class: 'pending-selection-bar', role: 'group', 'aria-label': 'Selection' },
    h('div', { class: 'pending-selection-controls' },
      selectionButton('pending-select-all', 'pending-select-all', `Select all (${tabEntries.length})`, tabEntries.length === 0 || all, { 'data-action': 'select-all' }),
      selectionButton('pending-deselect-all', 'pending-deselect-all', 'Deselect all', chosen.length === 0, { 'data-action': 'deselect-all' })),
    chosen.length > 0 && h('div', { class: 'pending-bulk', role: 'group', 'aria-label': 'Move the selected worklogs' },
      h('span', { class: 'pending-bulk-summary', role: 'status' }, formatSelectionSummary(chosen.length, seconds)),
      h('span', { class: 'pending-bulk-actions' }, actions.map((c) => h('button', {
        type: 'button', class: `pending-bulk-btn is-${c.id}`, 'data-action': 'classify', 'data-classification': c.id,
        'data-focus-key': `pending-bulk:${c.id}`,
        'aria-label': `Move ${chosen.length} selected worklog${chosen.length === 1 ? '' : 's'} to ${c.label}`,
        'aria-disabled': selection.busy ? 'true' : undefined
      }, c.bulkAction)))),
    selection.notice && h('p', { class: 'pending-selection-notice', role: 'alert' }, selection.notice));

  bar.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    event.stopPropagation();
    if (button.getAttribute('aria-disabled') === 'true') return;
    if (button.dataset.action === 'select-all') selection.onSelectAll?.();
    else if (button.dataset.action === 'deselect-all') selection.onDeselectAll?.();
    else selection.onClassify?.(button.dataset.classification);
  });
  return bar;
}

/**
 * Builds the Worklogs group's contents: the classification tabs (Pending and On Hold,
 * each with its count) and, beside them, Select worklogs; selection mode's bar; then the selected tab's
 * pending worklogs, each on its own row (sessions are never merged), most recently stopped first,
 * or a short note when it has none.
 *
 * Outside selection mode, the rows are exactly as without classifications, plus their ⋯ button.
 * In selection mode, each row starts with a checkbox (a click elsewhere on the row, away from its
 * links and buttons, toggles it too).
 *
 * @param {object} options
 * @param {Array<object>} options.entries - `timeTracking.pending`, in stored order (every
 *   classification: the tabs count them all)
 * @param {string} options.site - The connected Jira site's ID; others are marked, never hidden
 * @param {number} [options.now=Date.now()] - For a submission left running too long (submissionStatus())
 * @param {(id: string) => void} options.onEdit
 * @param {(id: string) => void} options.onDiscard
 * @param {(id: string) => void} [options.onSubmit] - Also called for a disabled Submit, for the page to say why
 * @param {string} [options.tab='ready'] - The selected classification
 * @param {(tab: string) => void} [options.onSelectTab] - Called with a tab's classification when it's chosen
 * @param {(id: string) => void} [options.onMenu] - Called with a row's ID from its ⋯ button; no ⋯ without it
 * @param {object} [options.selection] - Selection mode; no Select without it
 * @param {boolean} options.selection.active - Selection mode is on
 * @param {Iterable<string>} options.selection.ids - The selected worklogs (of the selected tab)
 * @param {boolean} [options.selection.busy] - A change is being saved: the bulk actions wait
 * @param {() => void} options.selection.onToggleMode - Select, or Done
 * @param {(id: string) => void} options.selection.onToggle - A row's checkbox
 * @param {() => void} options.selection.onSelectAll
 * @param {() => void} options.selection.onDeselectAll
 * @param {(classification: string) => void} options.selection.onClassify - A bulk action
 * @param {Array<{ id: string, reason: string }>} [options.selection.notMoved] - The worklogs the last
 *   bulk change couldn't move, and why: each row is flagged
 * @param {string} [options.selection.notice] - What the last bulk change couldn't do, in the bar
 * @returns {DocumentFragment}
 */
export function renderPendingWorklogs({ entries, site, now = Date.now(), onEdit, onDiscard, onSubmit, tab = DEFAULT_CLASSIFICATION, onSelectTab, onMenu, selection }) {
  const summary = summarizeClassifications(entries);
  const tabEntries = entriesIn(entries, tab);
  const selecting = Boolean(selection?.active);
  const selectedIds = new Set(selecting ? selection.ids : []);
  // Only the selected tab's worklogs can be selected.
  const chosen = tabEntries.filter((entry) => selectedIds.has(entry.id));
  const notMoved = new Map(selecting ? (selection.notMoved ?? []).map(({ id, reason }) => [id, reason]) : []);

  const selectToggle = selection && h('button', {
    type: 'button', class: `pending-select-toggle${selecting ? ' is-active' : ''}`, 'data-focus-key': 'pending-select',
    'aria-pressed': String(selecting),
    'aria-disabled': !selecting && tabEntries.length === 0 ? 'true' : undefined,
    title: selecting ? 'Leave selection mode' : `Select ${classificationLabel(tab)} worklogs to move several at once`
  }, selecting
    // Done: a plain check. Select worklogs: a checked box, like the rows' checkboxes.
    ? buttonIcon(svg('polyline', { points: '20 6 9 17 4 12' }))
    : buttonIcon(
      svg('rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }),
      svg('polyline', { points: '8 12 11 15 16 9' })),
  h('span', {}, selecting ? 'Done' : 'Select worklogs'));
  selectToggle?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (selectToggle.getAttribute('aria-disabled') !== 'true') selection.onToggleMode();
  });

  const toolbar = h('div', { class: 'pending-toolbar' }, renderClassificationTabs(tab, summary, onSelectTab), selectToggle);

  let content;
  if (tabEntries.length === 0) {
    content = h('p', { class: 'working-issues-empty' }, entries.length === 0 ? EMPTY_NOTES.none : EMPTY_NOTES[tab]);
  } else {
    const list = h('ul', { class: `pending-worklogs${selecting ? ' is-selecting' : ''}` }, [...tabEntries].reverse().map((entry) =>
      renderPendingWorklog(entry, site, now, {
        menu: Boolean(onMenu), selected: selecting ? selectedIds.has(entry.id) : null, notMoved: notMoved.get(entry.id)
      })));
    list.addEventListener('click', (event) => {
      const checkbox = selecting && event.target.closest('.pending-select-checkbox');
      if (checkbox) {
        event.stopPropagation();
        selection.onToggle(checkbox.dataset.pendingId);
        return;
      }
      const button = event.target.closest('.pending-submit-btn, .pending-edit-btn, .pending-discard-btn, .pending-menu-btn');
      if (!button) {
        // In selection mode, a click on the row itself (not its issue link) selects it.
        const row = selecting && !event.target.closest('a, button, input') && event.target.closest('.pending-worklog');
        if (row) {
          event.stopPropagation();
          selection.onToggle(row.dataset.pendingId);
        }
        return;
      }
      // The click is the button's alone, not the row's or the section's.
      event.stopPropagation();
      if (button.classList.contains('pending-submit-btn')) onSubmit?.(button.dataset.pendingId);
      else if (button.classList.contains('pending-edit-btn')) onEdit(button.dataset.pendingId);
      else if (button.classList.contains('pending-menu-btn')) onMenu?.(button.dataset.pendingId);
      else onDiscard(button.dataset.pendingId);
    });
    content = list;
  }

  return fragment(
    toolbar,
    selecting && renderSelectionBar(tabEntries, chosen, selection),
    h('div', { id: 'pendingWorklogsPanel', class: 'pending-worklogs-panel', role: 'tabpanel', 'aria-labelledby': `pendingTab-${tab}` }, content));
}

/**
 * The selected tab, its worklogs, and their total, for the Pending Worklogs header: it names the
 * tab and counts what the group lists, like Issues counts its selected view. An unknown tab is Ready.
 * @param {Array<object>} entries - `timeTracking.pending`
 * @param {string} [tab='ready']
 * @returns {{ id: 'ready' | 'on-hold', label: string, count: number, seconds: number }}
 */
export function pendingTabTotals(entries, tab = DEFAULT_CLASSIFICATION) {
  const id = isClassification(tab) ? tab : DEFAULT_CLASSIFICATION;
  const { count, seconds } = summarizeClassifications(entries)[id];
  return { id, label: classificationLabel(id), count, seconds };
}

// The confirmation's wording for discarding a pending worklog (openDeleteWorklogDialog()).
export const DISCARD_PENDING_WORDING = {
  title: 'Discard pending worklog?',
  text: "This removes the tracked time from this browser. It was never sent to Jira, and it can't be recovered.",
  confirm: 'Discard',
  busy: 'Discarding…'
};
