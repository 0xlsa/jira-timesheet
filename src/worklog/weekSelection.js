/**
 * The week and day the timesheet shows, kept across a reload (F5) of the tab: the page saves them
 * as it's left (pagehide) and starts from them when it's loaded again, then loads that week from
 * Jira as always. They're kept in the tab's own sessionStorage, so a new tab (the toolbar icon)
 * still opens on today, and nothing outlives the tab.
 *
 * A reload that was showing today keeps following today: when the selected day was today, or the
 * week shown was today's week and today is now in a later week, the page opens on today again,
 * never on a day or week that was "today" only when it was saved.
 *
 * No DOM; the storage is passed in, and any failure to use it (storage turned off, a damaged
 * entry) just means the page opens on today.
 */

import { getMondayOfWeek, getLocalDateKey } from './worklogUtils.js';

export const WEEK_SELECTION_KEY = 'jts-shown-week';

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The local date of a YYYY-MM-DD key, or null when it isn't a real date. */
function dateOf(key) {
  if (typeof key !== 'string' || !DATE_KEY.test(key)) return null;
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return getLocalDateKey(date) === key ? date : null;
}

const mondayKeyOf = (date) => getLocalDateKey(getMondayOfWeek(date));

/**
 * Saves the week and day shown, for the next load of this tab.
 *
 * @param {() => Storage} getStorage - The tab's sessionStorage (reading it may throw)
 * @param {{ monday: Date, selectedDateKey: string }} selection
 * @param {Date} [now=new Date()]
 */
export function rememberWeekSelection(getStorage, { monday, selectedDateKey }, now = new Date()) {
  try {
    getStorage().setItem(WEEK_SELECTION_KEY, JSON.stringify({
      monday: mondayKeyOf(monday),
      day: selectedDateKey,
      savedOn: getLocalDateKey(now)
    }));
  } catch {
    // Without storage, the next load opens on today, as it always did.
  }
}

/**
 * The week and day to open on, from what this tab saved, or null to open on today: when nothing
 * was saved, it can't be read, or it was today then (see the module comment).
 *
 * @param {() => Storage} getStorage - The tab's sessionStorage (reading it may throw)
 * @param {Date} [now=new Date()]
 * @returns {{ monday: Date, selectedDateKey: string } | null} The selected day is always in the week
 */
export function restoreWeekSelection(getStorage, now = new Date()) {
  let saved;
  try {
    saved = JSON.parse(getStorage().getItem(WEEK_SELECTION_KEY) ?? 'null');
  } catch {
    return null;
  }
  const monday = dateOf(saved?.monday);
  const savedOn = dateOf(saved?.savedOn);
  if (!monday || !savedOn) return null;
  const mondayKey = mondayKeyOf(monday);
  const day = dateOf(saved.day);
  // Today was selected then: follow today.
  if (saved.day === saved.savedOn) return null;
  // Today's week was shown then, and today is in another week now: follow today.
  if (mondayKey === mondayKeyOf(savedOn) && mondayKeyOf(now) !== mondayKey) return null;
  const selectedDateKey = day && mondayKeyOf(day) === mondayKey ? saved.day : mondayKey;
  return { monday: getMondayOfWeek(monday), selectedDateKey };
}
