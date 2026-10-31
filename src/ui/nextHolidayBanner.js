/**
 * The Next Public Holiday banner, between the week navigation bar and the weekday cards: the next
 * holiday from today (whatever week is displayed), with the icon and name its weekday card shows.
 * The whole banner is a button that goes to the holiday's week. Hidden, taking no space, when
 * there's nothing to show.
 */

import { h } from './dom.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// "Fri, Dec 25", as the week's date range writes months; the year is added when it isn't this one.
const SHORT_DATE = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const SHORT_DATE_WITH_YEAR = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/** The local date of a YYYY-MM-DD key. */
export function dateFromKey(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/**
 * When the holiday is, from today: "Today", "Tomorrow", or its date ("Fri, Dec 25", or
 * "Fri, Jan 1, 2027" in another year).
 *
 * @param {string} dateKey - YYYY-MM-DD
 * @param {string} todayKey - YYYY-MM-DD
 */
export function formatHolidayWhen(dateKey, todayKey) {
  const date = dateFromKey(dateKey);
  // Whole calendar days apart (in UTC, so a daylight-saving change in between doesn't matter).
  const utc = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((utc(date) - utc(dateFromKey(todayKey))) / DAY_MS);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return (dateKey.slice(0, 4) === todayKey.slice(0, 4) ? SHORT_DATE : SHORT_DATE_WITH_YEAR).format(date);
}

/**
 * Shows the next holiday, or hides the banner.
 *
 * @param {HTMLButtonElement} banner
 * @param {{ dateKey: string, icon: string, label: string } | null} holiday - From publicHolidays.nextHoliday()
 * @param {string} todayKey - YYYY-MM-DD
 */
export function renderNextHolidayBanner(banner, holiday, todayKey) {
  if (!holiday) {
    banner.classList.add('hidden');
    banner.replaceChildren();
    banner.removeAttribute('data-date');
    banner.removeAttribute('aria-label');
    return;
  }
  const when = formatHolidayWhen(holiday.dateKey, todayKey);
  banner.dataset.date = holiday.dateKey;
  banner.setAttribute('aria-label', `Next public holiday: ${holiday.label}, ${when}. Show its week`);
  banner.replaceChildren(
    h('span', { class: 'next-holiday-icon', 'aria-hidden': 'true' }, holiday.icon),
    h('span', { class: 'next-holiday-text' },
      'Next public holiday: ',
      h('span', { class: 'next-holiday-name' }, holiday.label),
      h('span', { class: 'next-holiday-when' }, ` · ${when}`)));
  banner.classList.remove('hidden');
}
