/**
 * The week picker: the week's date range in the navigation bar opens a month calendar, and
 * choosing a day shows that day's week.
 *
 * Weeks start on Monday (getMondayOfWeek() in src/worklog/worklogUtils.js), as everywhere else in
 * the timesheet. The picker keeps no week of its own: it reads the shown week and selected day when
 * it opens, and hands the chosen day back to the page, which updates the same state as the previous
 * and next week buttons.
 *
 * The popover is a non-modal dialog, placed with fixed positioning under the date range (above it
 * when there's no room below) and kept inside the window. It closes when a day is chosen, on
 * Escape (focus goes back to the date range), and on a click or focus outside it.
 *
 * Keyboard, in the calendar (as in the WAI-ARIA date picker pattern): arrows move a day or a week,
 * Home and End go to the week's Monday and Sunday, Page Up and Page Down move a month (with Shift,
 * a year), and Enter or Space chooses the day.
 */

import { h, svg } from './dom.js';
import { getLocalDateKey, getMondayOfWeek } from '../worklog/worklogUtils.js';

const MONTH_FORMAT = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
// Each day's accessible label ("Monday, 21 December 2026").
const DAY_LABEL_FORMAT = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

const WEEKDAYS = [
  ['Mo', 'Monday'], ['Tu', 'Tuesday'], ['We', 'Wednesday'], ['Th', 'Thursday'],
  ['Fr', 'Friday'], ['Sa', 'Saturday'], ['Su', 'Sunday']
];

/** A local date `days` after `date` (calendar days, so daylight-saving changes don't matter). */
function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * The same day of the month `months` later, or the month's last day when it's shorter
 * (Jan 31 + 1 month is Feb 28, or Feb 29 in a leap year).
 */
export function addMonths(date, months) {
  const first = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(date.getDate(), lastDay));
}

/**
 * The weeks to show for a month: Monday to Sunday, from the week of its 1st to the week of its
 * last day, so the first and last weeks can include days of the months around it.
 *
 * @param {number} year
 * @param {number} month - 0 for January
 * @returns {Date[][]} 4 to 6 weeks of 7 days
 */
export function getMonthWeeks(year, month) {
  const last = new Date(year, month + 1, 0);
  const weeks = [];
  for (let monday = getMondayOfWeek(new Date(year, month, 1)); monday <= last; monday = addDays(monday, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(monday, i)));
  }
  return weeks;
}

/**
 * Where to put the popover: under the anchor, centred on it, or above it when it doesn't fit
 * below; always inside the viewport, `margin` from its edges where it can be.
 *
 * @param {{ left: number, top: number, bottom: number, width: number }} anchor - The anchor's client rect
 * @param {{ width: number, height: number }} size - The popover's size
 * @param {{ width: number, height: number }} viewport
 * @param {number} [gap=6] - Between the anchor and the popover
 * @param {number} [margin=8]
 * @returns {{ left: number, top: number }}
 */
export function placePopover(anchor, size, viewport, gap = 6, margin = 8) {
  const centred = anchor.left + anchor.width / 2 - size.width / 2;
  const left = Math.max(margin, Math.min(centred, viewport.width - margin - size.width));
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const fitsBelow = below + size.height <= viewport.height - margin;
  const top = fitsBelow || above < margin ? below : above;
  return { left, top: Math.max(margin, Math.min(top, viewport.height - margin - size.height)) };
}

/** Whether `node` is `root` or inside it. */
function isWithin(node, root) {
  for (let el = node; el; el = el.parentNode) {
    if (el === root) return true;
  }
  return false;
}

const chevron = (points) => svg('svg', { class: 'icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'aria-hidden': 'true' },
  svg('polyline', { points }));

/**
 * Wires the date range button to a calendar popover.
 *
 * @param {object} options
 * @param {HTMLButtonElement} options.trigger - The date range button
 * @param {HTMLElement} options.container - Where the popover is added (the page's body)
 * @param {() => { monday: Date, selectedDateKey: string }} options.getSelection - The shown week and selected day
 * @param {(date: Date) => void} options.onSelect - Called with the chosen day, after the popover closes
 *   (focus is back on the date range)
 * @param {() => Date} [options.today]
 * @returns {{ isOpen: () => boolean, open: () => void, close: (options?: { restoreFocus?: boolean }) => void }}
 */
export function createWeekPicker({ trigger, container, getSelection, onSelect, today = () => new Date() }) {
  const popover = h('div', { id: 'weekPicker', class: 'week-picker hidden', role: 'dialog', 'aria-label': 'Choose a week' });
  container.append(popover);
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'weekPicker');

  // The day with keyboard focus; the calendar shows its month.
  let focused = null;
  let selection = null;
  let opened = false;

  const isOpen = () => opened;

  // The header stays while the month changes, so its buttons keep focus.
  const prev = h('button', { type: 'button', class: 'btn btn-secondary btn-nav week-picker-month-btn', 'aria-label': 'Previous month', title: 'Previous month' }, chevron('15 18 9 12 15 6'));
  const next = h('button', { type: 'button', class: 'btn btn-secondary btn-nav week-picker-month-btn', 'aria-label': 'Next month', title: 'Next month' }, chevron('9 18 15 12 9 6'));
  const title = h('h3', { id: 'weekPickerMonth', class: 'week-picker-month', 'aria-live': 'polite' });
  prev.addEventListener('click', () => moveTo(addMonths(focused, -1)));
  next.addEventListener('click', () => moveTo(addMonths(focused, 1)));
  popover.append(h('div', { class: 'week-picker-header' }, prev, title, next));

  function render({ focus = false } = {}) {
    const year = focused.getFullYear();
    const month = focused.getMonth();
    const todayKey = getLocalDateKey(today());
    const focusedKey = getLocalDateKey(focused);
    const shownMonday = getLocalDateKey(selection.monday);

    const rows = getMonthWeeks(year, month).map((week) => {
      const isShownWeek = getLocalDateKey(week[0]) === shownMonday;
      return h('tr', { class: isShownWeek ? 'week-picker-week is-shown-week' : 'week-picker-week' }, week.map((date) => {
        const key = getLocalDateKey(date);
        const classes = ['week-picker-day'];
        if (date.getMonth() !== month) classes.push('is-outside');
        if (key === todayKey) classes.push('is-today');
        if (key === selection.selectedDateKey) classes.push('is-selected');
        return h('td', { role: 'gridcell', 'aria-selected': isShownWeek ? 'true' : 'false' },
          h('button', {
            type: 'button',
            class: classes.join(' '),
            'data-date': key,
            tabindex: key === focusedKey ? '0' : '-1',
            'aria-label': DAY_LABEL_FORMAT.format(date),
            'aria-current': key === todayKey ? 'date' : null
          }, date.getDate()));
      }));
    });

    const grid = h('table', { class: 'week-picker-grid', role: 'grid', 'aria-labelledby': 'weekPickerMonth' },
      h('thead', {}, h('tr', {}, WEEKDAYS.map(([short, long]) => h('th', { scope: 'col', abbr: long }, short)))),
      h('tbody', {}, rows));
    grid.addEventListener('click', (event) => {
      const day = event.target.closest?.('.week-picker-day');
      if (day) choose(day.dataset.date);
    });
    grid.addEventListener('keydown', onGridKeydown);

    title.textContent = MONTH_FORMAT.format(focused);
    popover.querySelector('.week-picker-grid')?.remove();
    popover.append(grid);
    if (focus) popover.querySelector(`[data-date="${focusedKey}"]`)?.focus();
  }

  /** Moves the focused day, changing month when it leaves the one shown. */
  function moveTo(date, { focus = false } = {}) {
    focused = date;
    render({ focus });
  }

  function onGridKeydown(event) {
    const moves = {
      ArrowLeft: () => addDays(focused, -1),
      ArrowRight: () => addDays(focused, 1),
      ArrowUp: () => addDays(focused, -7),
      ArrowDown: () => addDays(focused, 7),
      Home: () => getMondayOfWeek(focused),
      End: () => addDays(getMondayOfWeek(focused), 6),
      PageUp: () => addMonths(focused, event.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focused, event.shiftKey ? 12 : 1)
    };
    const move = moves[event.key];
    if (!move || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    moveTo(move(), { focus: true });
  }

  function choose(dateKey) {
    const [year, month, day] = dateKey.split('-').map(Number);
    close({ restoreFocus: true });
    onSelect(new Date(year, month - 1, day));
  }

  function position() {
    if (!trigger.getBoundingClientRect || !popover.getBoundingClientRect) return;
    const { left, top } = placePopover(trigger.getBoundingClientRect(), popover.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight });
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  // While open: a click or focus outside closes it, Escape closes it from anywhere in it.
  function onOutside(event) {
    if (!isWithin(event.target, popover) && !isWithin(event.target, trigger)) close();
  }
  function onKeydown(event) {
    if (!opened || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close({ restoreFocus: true });
  }
  popover.addEventListener('keydown', onKeydown);
  trigger.addEventListener('keydown', onKeydown);

  function open() {
    if (opened) return;
    selection = getSelection();
    const selected = selection.selectedDateKey && new Date(`${selection.selectedDateKey}T00:00:00`);
    const inShownWeek = selected && getLocalDateKey(getMondayOfWeek(selected)) === getLocalDateKey(selection.monday);
    focused = inShownWeek ? selected : new Date(selection.monday);
    opened = true;
    render();
    popover.classList.remove('hidden');
    trigger.setAttribute('aria-expanded', 'true');
    position();
    popover.querySelector(`[data-date="${getLocalDateKey(focused)}"]`)?.focus();
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('focusin', onOutside);
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', position);
      window.addEventListener('scroll', position, true);
    }
  }

  function close({ restoreFocus = false } = {}) {
    if (!opened) return;
    opened = false;
    popover.classList.add('hidden');
    popover.querySelector('.week-picker-grid')?.remove();
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside);
    document.removeEventListener('focusin', onOutside);
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    }
    if (restoreFocus) trigger.focus();
  }

  trigger.addEventListener('click', () => (opened ? close() : open()));

  return { isOpen, open, close };
}
