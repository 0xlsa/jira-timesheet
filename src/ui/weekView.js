/**
 * Weekly view presentation: weekday cards and the selected day's worklog panel.
 * Pure DOM rendering; state and data loading stay with the page controller.
 */

import { h, svg, fragment } from './dom.js';
import { isEditableWorklog } from '../worklog/worklogEdit.js';

// Daily duration that fills a weekday card's indicator bar (visual only).
const DAY_INDICATOR_FULL_SECONDS = 8 * 60 * 60;

const LONG_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric'
});

// The add button's accessible label ("26 October").
const DAY_LABEL_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' });

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
  const issueUrl = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(wl.issueKey)}` : '#';
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
 * Renders the 7 weekday cards and the selected day's worklog panel into `container`.
 * Daily totals and weekly totals are never modified by changing the selection.
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
 */
export function renderWeek(container, week, { selectedDateKey, baseUrl = '', onSelectDay, onAddWorklog, onEditWorklog, onLogWork, onDeleteWorklog, editingWorklogId }) {
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
    dayCard.title = `${day.dayName}, ${day.formattedDate}`;

    dayCard.append(
      h('span', { class: 'day-card-top' },
        h('span', { class: 'day-name' }, day.shortDayName),
        day.isToday && h('span', { class: 'badge-today' }, 'Today')),
      h('span', { class: 'day-date' }, String(day.dayOfMonth)),
      h('span', { class: 'day-duration' }, day.formattedTotal),
      h('span', { class: 'day-count' }, `${day.worklogCount} ${day.worklogCount === 1 ? 'worklog' : 'worklogs'}`),
      h('span', { class: 'day-indicator', 'aria-hidden': 'true' },
        h('span', { class: 'day-indicator-fill', style: `width: ${fillPercent.toFixed(1)}%` }))
    );

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
