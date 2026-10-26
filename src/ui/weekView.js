/**
 * Weekly view presentation: weekday cards and the selected day's worklog panel.
 * Pure DOM rendering; state and data loading stay with the page controller.
 */

import { escapeHtml } from './html.js';
import { isEditableWorklog } from '../worklog/worklogEdit.js';

// Daily duration that fills a weekday card's indicator bar (visual only).
const DAY_INDICATOR_FULL_SECONDS = 8 * 60 * 60;

const LONG_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric'
});

// Jira status category keys with a dedicated badge color; anything else (custom or `undefined`) is neutral.
const STATUS_CATEGORY_CLASSES = {
  new: 'status-category-new',
  indeterminate: 'status-category-indeterminate',
  done: 'status-category-done'
};

/**
 * Builds the status label (colored dot + name) shown under the issue key, or '' when the status is unknown.
 * @param {{ name: string, categoryKey?: string } | null | undefined} status
 * @returns {string}
 */
export function renderIssueStatusBadge(status) {
  const name = typeof status?.name === 'string' ? status.name.trim() : '';
  if (!name) return '';

  const categoryClass = STATUS_CATEGORY_CLASSES[status.categoryKey] || 'status-category-unknown';
  return `
    <span class="issue-status ${categoryClass}" title="Status: ${escapeHtml(name)}">
      <span class="issue-status-dot" aria-hidden="true"></span>
      <span class="issue-status-name">${escapeHtml(name)}</span>
    </span>`;
}

/**
 * Builds the HTML for a single worklog entry in the selected-day panel.
 * @param {object} wl
 * @param {string} baseUrl
 * @param {object} [options]
 * @param {boolean} [options.editable=false] - Show the edit (pencil) button
 * @param {boolean} [options.canLogWork=false] - Show the log work (plus) button for the worklog's issue
 * @param {boolean} [options.deletable=false] - Show the delete (trash) button
 * @returns {string}
 */
export function renderWorklogItem(wl, baseUrl, { editable = false, canLogWork = false, deletable = false } = {}) {
  const issueUrl = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(wl.issueKey)}` : '#';

  return `
    <div class="worklog-issue">
      <a href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener noreferrer" class="issue-key-badge" title="Open ${escapeHtml(wl.issueKey)} in Jira">
        ${escapeHtml(wl.issueKey || 'ISSUE')}
      </a>
      ${renderIssueStatusBadge(wl.issueStatus)}
    </div>
    <div class="worklog-body">
      <span class="issue-summary" title="${escapeHtml(wl.issueSummary)}">${escapeHtml(wl.issueSummary)}</span>
      ${wl.comment ? `<div class="worklog-comment">${escapeHtml(wl.comment)}</div>` : ''}
      <div class="worklog-meta-row">
        <span class="worklog-time">
          <svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
          Started ${escapeHtml(wl.formattedStartTime)}
        </span>
        ${wl.author?.displayName ? `
        <span class="worklog-author">
          <svg class="meta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
          ${escapeHtml(wl.author.displayName)}
        </span>` : ''}
      </div>
    </div>
    <div class="worklog-side">
      <span class="worklog-duration-badge">${escapeHtml(wl.formattedDuration)}</span>
      ${canLogWork || editable || deletable ? `
      <div class="worklog-actions">
        ${canLogWork ? `
        <button type="button" class="worklog-log-btn" data-worklog-id="${escapeHtml(String(wl.id))}" aria-label="Log work on ${escapeHtml(wl.issueKey)}" title="Log work">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>` : ''}
        ${editable ? `
        <button type="button" class="worklog-edit-btn" data-worklog-id="${escapeHtml(String(wl.id))}" aria-label="Edit worklog for ${escapeHtml(wl.issueKey)}, started ${escapeHtml(wl.formattedStartTime)}" title="Edit worklog">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20h9"/>
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
          </svg>
        </button>` : ''}
        ${deletable ? `
        <button type="button" class="worklog-delete-btn" data-worklog-id="${escapeHtml(String(wl.id))}" aria-label="Delete worklog for ${escapeHtml(wl.issueKey)}, started ${escapeHtml(wl.formattedStartTime)}" title="Delete worklog">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6"/>
            <path d="M14 11v6"/>
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>` : ''}
      </div>` : ''}
    </div>
  `;
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
 * @param {(worklogId: string) => void} [options.onEditWorklog] - Called when a worklog's edit button is clicked; no edit buttons without it
 * @param {(worklogId: string) => void} [options.onLogWork] - Called when a worklog's log work button is clicked; no log work buttons without it
 * @param {(worklogId: string) => void} [options.onDeleteWorklog] - Called when a worklog's delete button is clicked; no delete buttons without it
 * @param {string} [options.editingWorklogId] - Worklog currently open in the editor, highlighted in the list
 */
export function renderWeek(container, week, { selectedDateKey, baseUrl = '', onSelectDay, onEditWorklog, onLogWork, onDeleteWorklog, editingWorklogId }) {
  container.innerHTML = '';

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

    dayCard.innerHTML = `
      <span class="day-card-top">
        <span class="day-name">${escapeHtml(day.shortDayName)}</span>
        ${day.isToday ? '<span class="badge-today">Today</span>' : ''}
      </span>
      <span class="day-date">${escapeHtml(String(day.dayOfMonth))}</span>
      <span class="day-duration">${escapeHtml(day.formattedTotal)}</span>
      <span class="day-count">${day.worklogCount} ${day.worklogCount === 1 ? 'worklog' : 'worklogs'}</span>
      <span class="day-indicator" aria-hidden="true"><span class="day-indicator-fill" style="width: ${fillPercent.toFixed(1)}%"></span></span>
    `;

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
  panel.innerHTML = `
    <div class="day-panel-header">
      <div>
        <h3 class="day-panel-title">${escapeHtml(selectedDay.dayName)}, ${escapeHtml(LONG_DATE_FORMAT.format(selectedDay.date))}</h3>
        <span class="day-panel-meta">${countLabel} &bull; ${escapeHtml(selectedDay.formattedTotal)} total</span>
      </div>
      <span class="day-panel-total ${selectedDay.totalDurationSeconds > 0 ? 'has-time' : ''}">${escapeHtml(selectedDay.formattedTotal)}</span>
    </div>
  `;

  if (selectedDay.worklogs.length > 0) {
    const listEl = document.createElement('div');
    listEl.className = 'worklog-list';

    selectedDay.worklogs.forEach((wl) => {
      const itemEl = document.createElement('div');
      itemEl.className = `worklog-item ${editingWorklogId && String(wl.id) === editingWorklogId ? 'is-editing' : ''}`;
      itemEl.innerHTML = renderWorklogItem(wl, baseUrl, {
        editable: Boolean(onEditWorklog) && isEditableWorklog(wl),
        canLogWork: Boolean(onLogWork) && Boolean(wl.issueId || wl.issueKey),
        deletable: Boolean(onDeleteWorklog) && isEditableWorklog(wl)
      });
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
