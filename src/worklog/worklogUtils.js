/**
 * Timesheet for Jira Worklog Utility Module
 *
 * Provides date calculations for Monday-based weeks, local timezone grouping,
 * duration formatting, comment text parsing, and worklog aggregation.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Returns the Monday of the week for a given reference date, at 00:00:00.000 local time.
 * Monday is treated as the first day of the week (ISO-8601 convention).
 *
 * @param {Date | string | number} [referenceDate=new Date()]
 * @returns {Date}
 */
export function getMondayOfWeek(referenceDate = new Date()) {
  const date = new Date(referenceDate);
  if (isNaN(date.getTime())) {
    throw new Error('Invalid date provided to getMondayOfWeek.');
  }

  // Set to local start of day
  date.setHours(0, 0, 0, 0);

  const dayOfWeek = date.getDay(); // 0 is Sunday, 1 is Monday, ..., 6 is Saturday
  // If Sunday (0), we need to go back 6 days to reach the preceding Monday.
  // Otherwise, go back (dayOfWeek - 1) days.
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  date.setDate(date.getDate() + diffToMonday);

  return date;
}

/**
 * Formats a Date object into 'YYYY-MM-DD' using local timezone.
 *
 * @param {Date} date
 * @returns {string} e.g. "2026-10-21"
 */
export function getLocalDateKey(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return '';
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Generates metadata for all 7 days of the week starting from Monday.
 *
 * @param {Date} monday - The Monday Date object (start of week)
 * @param {Date} [todayRef=new Date()] - Reference for identifying "today"
 * @returns {Array<{
 *   dateKey: string,
 *   date: Date,
 *   dayName: string,
 *   shortDayName: string,
 *   formattedDate: string,
 *   dayOfMonth: number,
 *   isToday: boolean
 * }>}
 */
export function getWeekDays(monday, todayRef = new Date()) {
  const mon = new Date(monday);
  mon.setHours(0, 0, 0, 0);

  const todayKey = getLocalDateKey(todayRef);
  const days = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);

    const dateKey = getLocalDateKey(d);
    const dayIndex = d.getDay();
    const month = MONTH_NAMES[d.getMonth()];
    const dayOfMonth = d.getDate();

    days.push({
      dateKey,
      date: d,
      dayName: DAY_NAMES[dayIndex],
      shortDayName: SHORT_DAY_NAMES[dayIndex],
      formattedDate: `${month} ${dayOfMonth}`,
      dayOfMonth,
      isToday: dateKey === todayKey
    });
  }

  return days;
}

/**
 * Formats the weekly date range for display.
 * e.g. "Oct 19 – Oct 25, 2026" or "Oct 27 – Nov 2, 2026" or "Dec 29, 2025 – Jan 4, 2026"
 *
 * @param {Date} monday
 * @param {Date} sunday
 * @returns {string}
 */
export function formatWeekRange(monday, sunday) {
  const startMonth = MONTH_NAMES[monday.getMonth()];
  const startDay = monday.getDate();
  const startYear = monday.getFullYear();

  const endMonth = MONTH_NAMES[sunday.getMonth()];
  const endDay = sunday.getDate();
  const endYear = sunday.getFullYear();

  if (startYear === endYear) {
    if (startMonth === endMonth) {
      return `${startMonth} ${startDay} – ${endDay}, ${startYear}`;
    }
    return `${startMonth} ${startDay} – ${endMonth} ${endDay}, ${startYear}`;
  }

  return `${startMonth} ${startDay}, ${startYear} – ${endMonth} ${endDay}, ${endYear}`;
}

/**
 * Formats a worklog's date in local time as "DD Mon YYYY · Weekday", e.g. "28 Oct 2026 · Wednesday".
 *
 * @param {Date} date
 * @returns {string} Empty for an invalid date
 */
export function formatWorklogDate(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return '';
  const day = String(date.getDate()).padStart(2, '0');
  return `${day} ${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()} · ${DAY_NAMES[date.getDay()]}`;
}

/**
 * Formats a duration in seconds into human-readable hours and minutes.
 * Examples:
 *   3600 -> "1h"
 *   5400 -> "1h 30m"
 *   1800 -> "30m"
 *   0    -> "0m" (or "0h 00m" if formatAsDigital is true)
 *
 * @param {number} totalSeconds
 * @param {object} [options]
 * @param {boolean} [options.padZeroMinutes=false] - If true, formats "1h 05m" instead of "1h 5m"
 * @param {boolean} [options.alwaysShowHours=false] - If true, formats "0h 30m" instead of "30m"
 * @param {string} [options.zeroLabel='0m'] - Label to show when seconds === 0
 * @returns {string}
 */
export function formatDuration(totalSeconds, options = {}) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const {
    padZeroMinutes = false,
    alwaysShowHours = false,
    zeroLabel = alwaysShowHours ? (padZeroMinutes ? '0h 00m' : '0h 0m') : '0m'
  } = options;

  if (seconds === 0) {
    return zeroLabel;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const formattedMinutes = padZeroMinutes ? String(minutes).padStart(2, '0') : String(minutes);

  if (hours > 0 && minutes > 0) {
    return `${hours}h ${formattedMinutes}m`;
  }

  if (hours > 0) {
    return padZeroMinutes ? `${hours}h 00m` : `${hours}h`;
  }

  if (alwaysShowHours) {
    return `0h ${formattedMinutes}m`;
  }

  return `${minutes}m`;
}

/**
 * Parses Atlassian Document Format (ADF) or plain string comments into clean plain text.
 *
 * @param {string | object} comment
 * @returns {string}
 */
export function parseWorklogComment(comment) {
  if (!comment) {
    return '';
  }

  if (typeof comment === 'string') {
    return comment.trim();
  }

  // Handle Jira Cloud Atlassian Document Format (ADF)
  if (typeof comment === 'object' && comment !== null) {
    const textParts = [];

    function extractText(node) {
      if (!node) return;
      if (node.type === 'text' && typeof node.text === 'string') {
        textParts.push(node.text);
      }
      if (Array.isArray(node.content)) {
        node.content.forEach(extractText);
      }
    }

    extractText(comment);
    return textParts.join(' ').replace(/\s+/g, ' ').trim();
  }

  return '';
}

/**
 * Aggregates a list of Jira worklogs into days for a target week.
 *
 * Guarantees:
 * - Aggregation is computed strictly in seconds to prevent floating-point/rounding errors.
 * - Week total equals the sum of all daily totals.
 * - Daily totals equal the sum of their displayed worklogs.
 * - Local timezone is used to determine which day a worklog belongs to.
 * - Worklogs are deduplicated by ID.
 *
 * @param {Array<object>} rawWorklogs - Worklog items
 * @param {Array<object>} weekDays - Array of day descriptors from getWeekDays()
 * @returns {{
 *   weekDays: Array<{
 *     dateKey: string,
 *     dayName: string,
 *     shortDayName: string,
 *     formattedDate: string,
 *     dayOfMonth: number,
 *     isToday: boolean,
 *     totalDurationSeconds: number,
 *     formattedTotal: string,
 *     worklogCount: number,
 *     worklogs: Array<object>
 *   }>,
 *   weekTotalSeconds: number,
 *   formattedWeekTotal: string,
 *   totalWorklogsCount: number,
 *   hasAnyWorklogs: boolean
 * }}
 */
export function aggregateWorklogsByWeek(rawWorklogs = [], weekDays = []) {
  // Map of dateKey -> Array of worklogs
  const dayMap = new Map();
  weekDays.forEach((day) => {
    dayMap.set(day.dateKey, []);
  });

  const seenWorklogIds = new Set();
  let totalWorklogsCount = 0;

  (rawWorklogs || []).forEach((worklog) => {
    if (!worklog) return;

    // Deduplicate by worklog ID if present
    const worklogId = worklog.id ? String(worklog.id) : null;
    if (worklogId) {
      if (seenWorklogIds.has(worklogId)) {
        return; // Skip duplicate
      }
      seenWorklogIds.add(worklogId);
    }

    // Determine start date in local timezone
    const startedRaw = worklog.started;
    if (!startedRaw) return;

    const startDate = new Date(startedRaw);
    if (isNaN(startDate.getTime())) return;

    const localDateKey = getLocalDateKey(startDate);

    // Only include if it falls within one of the week's days
    if (dayMap.has(localDateKey)) {
      const durationSeconds = Math.max(0, Number(worklog.timeSpentSeconds) || 0);

      const parsedWorklog = {
        id: worklogId || `temp-${Math.random()}`,
        issueId: worklog.issueId || '',
        issueKey: worklog.issueKey || '',
        issueSummary: worklog.issueSummary || 'No summary available',
        issueStatus: worklog.issueStatus?.name ? worklog.issueStatus : null,
        comment: parseWorklogComment(worklog.comment),
        started: startDate,
        formattedStartTime: startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timeSpentSeconds: durationSeconds,
        // Same "0h 00m" shape as the day and week totals, so badges read consistently.
        formattedDuration: formatDuration(durationSeconds, { padZeroMinutes: true, alwaysShowHours: true }),
        author: {
          displayName: worklog.author?.displayName || 'Unknown Author',
          name: worklog.author?.name || '',
          accountId: worklog.author?.accountId || '',
          emailAddress: worklog.author?.emailAddress || ''
        }
      };

      dayMap.get(localDateKey).push(parsedWorklog);
      totalWorklogsCount++;
    }
  });

  let weekTotalSeconds = 0;

  const populatedDays = weekDays.map((day) => {
    const worklogs = dayMap.get(day.dateKey) || [];

    // Sort worklogs chronologically by start time
    worklogs.sort((a, b) => a.started.getTime() - b.started.getTime());

    // Aggregate day duration strictly in seconds
    const dayTotalSeconds = worklogs.reduce((acc, wl) => acc + wl.timeSpentSeconds, 0);
    weekTotalSeconds += dayTotalSeconds;

    return {
      ...day,
      totalDurationSeconds: dayTotalSeconds,
      formattedTotal: formatDuration(dayTotalSeconds, { padZeroMinutes: true, alwaysShowHours: true }),
      worklogCount: worklogs.length,
      worklogs
    };
  });

  return {
    weekDays: populatedDays,
    weekTotalSeconds,
    formattedWeekTotal: formatDuration(weekTotalSeconds, { padZeroMinutes: true, alwaysShowHours: true }),
    totalWorklogsCount,
    hasAnyWorklogs: totalWorklogsCount > 0
  };
}

/**
 * Returns the Monday 00:00:00.000 to Sunday 23:59:59.999 local-time range of the
 * week starting at `monday`. Uses calendar arithmetic, so weeks containing a
 * daylight-saving change still end on Sunday.
 *
 * @param {Date | string | number} monday
 * @returns {{ monday: Date, sunday: Date }}
 */
export function getWeekRange(monday) {
  const start = new Date(monday);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  return { monday: start, sunday: end };
}

/**
 * Returns an aggregated week with no worklogs (all totals 0h 00m).
 *
 * @param {Date} monday
 * @param {Date} [todayRef=new Date()]
 * @returns {ReturnType<typeof aggregateWorklogsByWeek>}
 */
export function buildEmptyWeek(monday, todayRef = new Date()) {
  return aggregateWorklogsByWeek([], getWeekDays(monday, todayRef));
}
