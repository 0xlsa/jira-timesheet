/**
 * Weekly view presentation: weekday cards and the selected day's worklog panel.
 * Pure DOM rendering; state and data loading stay with the page controller.
 */

import { escapeHtml } from './html.js';

// Daily duration that fills a weekday card's indicator bar (visual only).
const DAY_INDICATOR_FULL_SECONDS = 8 * 60 * 60;

const LONG_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric'
});

/**
 * Builds the HTML for a single worklog entry in the selected-day panel.
 * @param {object} wl
 * @param {string} baseUrl
 * @returns {string}
 */
function renderWorklogItem(wl, baseUrl) {
  const issueUrl = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(wl.issueKey)}` : '#';

  return `
    <a href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener noreferrer" class="issue-key-badge" title="Open ${escapeHtml(wl.issueKey)} in Jira">
      ${escapeHtml(wl.issueKey || 'ISSUE')}
    </a>
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
    <span class="worklog-duration-badge">${escapeHtml(wl.formattedDuration)}</span>
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
 */
export function renderWeek(container, week, { selectedDateKey, baseUrl = '', onSelectDay }) {
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
      itemEl.className = 'worklog-item';
      itemEl.innerHTML = renderWorklogItem(wl, baseUrl);
      listEl.appendChild(itemEl);
    });

    panel.appendChild(listEl);
  } else {
    const emptyPlaceholder = document.createElement('div');
    emptyPlaceholder.className = 'empty-day-placeholder';
    emptyPlaceholder.textContent = 'No worklogs logged for this day.';
    panel.appendChild(emptyPlaceholder);
  }

  container.appendChild(panel);
}
