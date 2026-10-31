import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import { addMonths, createWeekPicker, getMonthWeeks, placePopover } from '../src/ui/weekPicker.js';
import { getLocalDateKey, getMondayOfWeek } from '../src/worklog/worklogUtils.js';

const key = getLocalDateKey;
const date = (dateKey) => new Date(`${dateKey}T00:00:00`);

describe('Week picker - month grid', () => {
  const keys = (year, month) => getMonthWeeks(year, month).map((week) => week.map(key));

  it('shows Monday-to-Sunday weeks from the week of the 1st to the week of the last day', () => {
    const weeks = keys(2026, 11); // December 2026: Tue 1st to Thu 31st
    assert.equal(weeks.length, 5);
    assert.deepEqual(weeks[0], ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06']);
    assert.deepEqual(weeks[4], ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
    for (const week of getMonthWeeks(2026, 11)) assert.equal(week[0].getDay(), 1, 'starts on Monday');
  });

  it('has 4 to 6 weeks, as the month needs', () => {
    assert.equal(keys(2021, 1).length, 4, 'February 2021: Monday 1st to Sunday 28th');
    assert.equal(keys(2026, 7).length, 6, 'August 2026: Saturday 1st to Monday 31st');
  });

  it('includes February 29 in a leap year, and not otherwise', () => {
    assert.ok(keys(2028, 1).flat().includes('2028-02-29'));
    assert.ok(!keys(2026, 1).flat().includes('2026-02-29'));
    assert.ok(keys(2026, 1).flat().includes('2026-03-01'), 'the last week runs into March');
  });

  it('covers every day of the month, in order, without gaps', () => {
    for (const [year, month] of [[2024, 1], [2026, 0], [2026, 11], [2100, 1]]) {
      const days = getMonthWeeks(year, month).flat();
      for (let i = 1; i < days.length; i++) {
        assert.equal(key(new Date(days[i - 1].getFullYear(), days[i - 1].getMonth(), days[i - 1].getDate() + 1)), key(days[i]));
      }
      const inMonth = days.filter((d) => d.getMonth() === month);
      assert.equal(inMonth.length, new Date(year, month + 1, 0).getDate(), `${year}-${month + 1}`);
    }
  });
});

describe('Week picker - moving by months', () => {
  it('keeps the day of the month, or uses the shorter month\'s last day', () => {
    assert.equal(key(addMonths(date('2026-12-15'), 1)), '2027-01-15', 'into the next year');
    assert.equal(key(addMonths(date('2027-01-15'), -1)), '2026-12-15', 'back into the previous year');
    assert.equal(key(addMonths(date('2027-01-31'), 1)), '2027-02-28');
    assert.equal(key(addMonths(date('2028-01-31'), 1)), '2028-02-29', 'leap year');
    assert.equal(key(addMonths(date('2026-03-31'), -1)), '2026-02-28');
    assert.equal(key(addMonths(date('2028-02-29'), 12)), '2029-02-28');
    assert.equal(key(addMonths(date('2026-05-10'), -240)), '2006-05-10', 'no limit');
  });
});

describe('Week picker - popover placement', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 264, height: 300 };

  it('goes under the date range, centred on it', () => {
    const anchor = { left: 400, top: 100, bottom: 130, width: 200 };
    assert.deepEqual(placePopover(anchor, size, viewport), { left: 368, top: 136 });
  });

  it('stays inside the window at its edges', () => {
    assert.equal(placePopover({ left: 0, top: 100, bottom: 130, width: 100 }, size, viewport).left, 8);
    assert.equal(placePopover({ left: 950, top: 100, bottom: 130, width: 50 }, size, viewport).left, 1000 - 8 - 264);
  });

  it('goes above the date range when there is no room below', () => {
    const anchor = { left: 400, top: 600, bottom: 630, width: 200 };
    assert.equal(placePopover(anchor, size, viewport).top, 600 - 6 - 300);
  });

  it('stays in the window when it fits neither below nor above', () => {
    const { top } = placePopover({ left: 400, top: 200, bottom: 230, width: 200 }, size, { width: 1000, height: 400 });
    assert.equal(top, 400 - 8 - 300, 'as low as it can be without leaving the window');
  });
});

describe('Week picker - calendar', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  /** The page around the picker: the date range button, and the shown week and selected day. */
  function setup({ monday = '2026-12-21', selected = '2026-12-23', today = '2026-12-23' } = {}) {
    const state = { monday: date(monday), selectedDateKey: selected };
    const chosen = [];
    const trigger = h('button', { type: 'button', id: 'weekPickerBtn' }, 'Dec 21 – 27, 2026');
    const outside = h('button', { type: 'button', id: 'refreshWorklogsBtn' }, 'Sync');
    const body = h('body', {}, h('div', { class: 'week-nav-bar' }, trigger, outside));
    const picker = createWeekPicker({
      trigger,
      container: body,
      getSelection: () => ({ ...state }),
      today: () => date(today),
      onSelect: (day) => {
        chosen.push(key(day));
        // As options.js does: the chosen day's week, with the day selected.
        state.monday = getMondayOfWeek(day);
        state.selectedDateKey = key(day);
      }
    });
    const popover = body.querySelector('#weekPicker');
    const day = (dateKey) => popover.querySelector(`[data-date="${dateKey}"]`);
    const month = () => popover.querySelector('.week-picker-month').textContent;
    const shownWeek = () => popover.querySelectorAll('.is-shown-week').map((row) => row.querySelectorAll('.week-picker-day')
      .map((button) => button.dataset.date));
    const press = (keyName, extra = {}) => document.activeElement.dispatchEvent({ type: 'keydown', key: keyName, ...extra });
    const isVisible = () => !popover.classList.contains('hidden');
    return { picker, trigger, outside, popover, day, month, shownWeek, press, isVisible, chosen, state };
  }

  it('opens from the date range on the shown week\'s month, and closes from it again', () => {
    const view = setup();
    assert.equal(view.isVisible(), false);
    assert.equal(view.trigger.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(view.trigger.getAttribute('aria-expanded'), 'false');
    view.trigger.click();
    assert.equal(view.isVisible(), true);
    assert.equal(view.picker.isOpen(), true);
    assert.equal(view.trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(view.popover.getAttribute('role'), 'dialog');
    assert.equal(view.month(), 'December 2026');
    view.trigger.click();
    assert.equal(view.isVisible(), false);
    assert.equal(view.trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(view.chosen.length, 0);
  });

  it('marks today, highlights the shown week, and focuses the selected day', () => {
    const view = setup({ today: '2026-12-08' });
    view.trigger.click();
    assert.deepEqual(view.shownWeek(), [['2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24', '2026-12-25', '2026-12-26', '2026-12-27']]);
    assert.equal(view.day('2026-12-08').getAttribute('aria-current'), 'date');
    assert.ok(view.day('2026-12-08').classList.contains('is-today'));
    assert.equal(view.popover.querySelectorAll('[aria-current]').length, 1);
    assert.ok(view.day('2026-12-23').classList.contains('is-selected'));
    assert.equal(document.activeElement, view.day('2026-12-23'));
    assert.equal(view.day('2026-12-23').getAttribute('tabindex'), '0');
    assert.equal(view.popover.querySelectorAll('[tabindex="0"]').length, 1, 'one tab stop in the grid');
    assert.equal(view.day('2026-12-23').getAttribute('aria-label'), 'Wednesday, 23 December 2026');
    assert.ok(view.day('2026-11-30').classList.contains('is-outside'), 'a November day in the first week');
  });

  it('labels the weekdays from Monday, and the grid by its month', () => {
    const view = setup();
    view.trigger.click();
    const headings = view.popover.querySelectorAll('th');
    assert.deepEqual(headings.map((th) => th.textContent), ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
    assert.equal(headings[0].getAttribute('abbr'), 'Monday');
    assert.equal(view.popover.querySelector('.week-picker-grid').getAttribute('aria-labelledby'), 'weekPickerMonth');
    assert.equal(view.popover.querySelector('#weekPickerMonth').textContent, 'December 2026');
  });

  it('chooses a day in the shown week: closes, and selects that day', () => {
    const view = setup();
    view.trigger.click();
    view.day('2026-12-25').click();
    assert.deepEqual(view.chosen, ['2026-12-25']);
    assert.equal(view.isVisible(), false);
    assert.equal(key(view.state.monday), '2026-12-21', 'the same week');
    assert.equal(document.activeElement, view.trigger, 'focus goes back to the date range');
  });

  it('chooses a day in another week, and the next opening shows that week', () => {
    const view = setup();
    view.trigger.click();
    view.day('2026-12-09').click();
    assert.deepEqual(view.chosen, ['2026-12-09']);
    assert.equal(key(view.state.monday), '2026-12-07');
    view.trigger.click();
    assert.deepEqual(view.shownWeek()[0][0], '2026-12-07');
    assert.equal(document.activeElement, view.day('2026-12-09'));
  });

  it('chooses a day of the next month shown in the last week', () => {
    const view = setup();
    view.trigger.click();
    view.day('2027-01-03').click();
    assert.deepEqual(view.chosen, ['2027-01-03']);
    assert.equal(key(view.state.monday), '2026-12-28', 'Sunday January 3 is in the week of Monday December 28');
  });

  it('moves between months, across years, and back', () => {
    const view = setup();
    view.trigger.click();
    const [prev, next] = view.popover.querySelectorAll('.week-picker-month-btn');
    assert.equal(prev.getAttribute('aria-label'), 'Previous month');
    assert.equal(next.getAttribute('aria-label'), 'Next month');
    next.click();
    assert.equal(view.month(), 'January 2027');
    assert.ok(view.day('2027-01-31'));
    assert.deepEqual(view.shownWeek(), [], 'the shown week is in December');
    prev.click();
    prev.click();
    assert.equal(view.month(), 'November 2026');
    for (let i = 0; i < 26; i++) prev.click();
    assert.equal(view.month(), 'September 2024', 'no limit');
    assert.equal(view.isVisible(), true, 'still open');
    assert.equal(view.chosen.length, 0);
  });

  it('chooses a leap day, in the week of Monday February 28', () => {
    const view = setup({ monday: '2028-02-21', selected: '2028-02-21', today: '2028-02-21' });
    view.trigger.click();
    assert.equal(view.month(), 'February 2028');
    view.day('2028-02-29').click();
    assert.deepEqual(view.chosen, ['2028-02-29']);
    assert.equal(key(view.state.monday), '2028-02-28');
  });

  it('opens on the week\'s Monday when the selected day is in another week', () => {
    const view = setup({ monday: '2027-01-04', selected: '2026-12-23' });
    view.trigger.click();
    assert.equal(view.month(), 'January 2027');
    assert.equal(document.activeElement, view.day('2027-01-04'));
  });

  describe('keyboard', () => {
    it('moves by day and week with the arrows, across a year', () => {
      const view = setup({ monday: '2026-12-28', selected: '2026-12-31' });
      view.trigger.click();
      assert.equal(view.press('ArrowRight'), false, 'handled');
      assert.equal(view.month(), 'January 2027');
      assert.equal(document.activeElement, view.day('2027-01-01'));
      view.press('ArrowUp');
      assert.equal(view.month(), 'December 2026');
      assert.equal(document.activeElement, view.day('2026-12-25'));
      view.press('ArrowDown');
      view.press('ArrowLeft');
      assert.equal(document.activeElement, view.day('2026-12-31'));
    });

    it('goes to the week\'s Monday and Sunday with Home and End', () => {
      const view = setup();
      view.trigger.click();
      view.press('Home');
      assert.equal(document.activeElement, view.day('2026-12-21'));
      view.press('End');
      assert.equal(document.activeElement, view.day('2026-12-27'));
    });

    it('moves a month with Page Up and Page Down, and a year with Shift', () => {
      const view = setup({ monday: '2028-01-31', selected: '2028-01-31' });
      view.trigger.click();
      view.press('PageDown');
      assert.equal(view.month(), 'February 2028');
      assert.equal(document.activeElement, view.day('2028-02-29'), 'January 31 to the leap day');
      view.press('PageDown', { shiftKey: true });
      assert.equal(view.month(), 'February 2029');
      assert.equal(document.activeElement, view.day('2029-02-28'));
      view.press('PageUp');
      assert.equal(view.month(), 'January 2029');
    });

    it('chooses the focused day with Enter or Space, as its button', () => {
      const view = setup();
      view.trigger.click();
      view.press('ArrowRight');
      // A native button: Enter and Space click it.
      assert.equal(document.activeElement.localName, 'button');
      document.activeElement.click();
      assert.deepEqual(view.chosen, ['2026-12-24']);
    });

    it('leaves keys with a modifier to the page\'s shortcuts', () => {
      const view = setup();
      view.trigger.click();
      assert.equal(view.press('ArrowRight', { ctrlKey: true }), true);
      assert.equal(document.activeElement, view.day('2026-12-23'));
    });
  });

  describe('closing', () => {
    it('closes on Escape, keeping the key from the page, and focuses the date range', () => {
      const view = setup();
      let pageSawEscape = false;
      document.addEventListener('keydown', () => { pageSawEscape = true; });
      view.trigger.click();
      assert.equal(view.press('Escape'), false);
      assert.equal(view.isVisible(), false);
      assert.equal(pageSawEscape, false, 'Escape doesn\'t also close a panel');
      assert.equal(document.activeElement, view.trigger);
      assert.equal(view.chosen.length, 0);
    });

    it('closes on Escape with focus still on the date range', () => {
      const view = setup();
      view.trigger.click();
      view.trigger.focus();
      view.trigger.dispatchEvent({ type: 'keydown', key: 'Escape' });
      assert.equal(view.isVisible(), false);
    });

    it('closes on a click outside, but not inside', () => {
      const view = setup();
      view.trigger.click();
      view.popover.querySelector('.week-picker-month').dispatchEvent({ type: 'pointerdown' });
      view.day('2026-12-01').dispatchEvent({ type: 'pointerdown' });
      assert.equal(view.isVisible(), true);
      view.outside.dispatchEvent({ type: 'pointerdown' });
      assert.equal(view.isVisible(), false);
      assert.equal(view.chosen.length, 0);
    });

    it('closes when focus moves outside', () => {
      const view = setup();
      view.trigger.click();
      view.outside.dispatchEvent({ type: 'focusin' });
      assert.equal(view.isVisible(), false);
    });

    it('stops listening once closed', () => {
      const view = setup();
      view.trigger.click();
      view.picker.close();
      assert.deepEqual(document.listeners.pointerdown ?? [], []);
      assert.deepEqual(document.listeners.focusin ?? [], []);
      view.trigger.click();
      assert.equal(view.isVisible(), true, 'and opens again');
    });
  });
});

describe('Week picker - page wiring', () => {
  const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  const options = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
  const nav = html.slice(html.indexOf('<div class="week-nav-bar">'), html.indexOf('id="refreshWorklogsBtn"') + 400);

  it('makes the date range a button between the previous and next week buttons', () => {
    const button = nav.match(/<button type="button" id="weekPickerBtn" class="week-range-btn"[^>]*>/)?.[0];
    assert.ok(button);
    assert.ok(nav.indexOf('id="prevWeekBtn"') < nav.indexOf('id="weekPickerBtn"'));
    assert.ok(nav.indexOf('id="weekPickerBtn"') < nav.indexOf('id="nextWeekBtn"'));
    // The heading's text is still set as before, and the button says what it does.
    assert.match(nav, /<h2 class="week-date-range">\s*<button[^>]*id="weekPickerBtn"[\s\S]*?<span id="weekDateRangeText">/);
    assert.match(nav, /<span class="sr-only">, choose a week<\/span>/);
    assert.match(nav, /class="week-range-icon"[^>]*aria-hidden="true"/);
  });

  it('keeps Today and Sync as they were', () => {
    assert.match(nav, /<button type="button" id="thisWeekBtn" class="btn btn-secondary btn-today" title="Jump to Today">\s*Today\s*<\/button>/);
    assert.match(nav, /<button type="button" id="refreshWorklogsBtn" class="btn btn-secondary btn-refresh"/);
    const listener = (id) => options.slice(options.indexOf(`${id}.addEventListener('click'`), options.indexOf('\n});', options.indexOf(`${id}.addEventListener('click'`)));
    assert.match(listener('thisWeekBtn'), /currentMonday = getMondayOfWeek\(new Date\(\)\);\s*selectedDateKey = getLocalDateKey\(new Date\(\)\);\s*loadAndRenderWorklogs\(\);/);
    assert.match(listener('refreshWorklogsBtn'), /loadAndRenderWorklogs\(\{ force: true \}\);/);
    assert.doesNotMatch(listener('thisWeekBtn') + listener('refreshWorklogsBtn'), /weekPicker/);
  });

  it('shows the chosen day\'s week through the same state as the week buttons', () => {
    const wiring = options.slice(options.indexOf('const weekPicker = createWeekPicker({'));
    const block = wiring.slice(0, wiring.indexOf('\n});') + 4);
    assert.match(block, /getSelection: \(\) => \(\{ monday: currentMonday, selectedDateKey \}\)/);
    assert.match(block, /currentMonday = getMondayOfWeek\(date\);\s*selectedDateKey = getLocalDateKey\(date\);\s*loadAndRenderWorklogs\(\);/);
    assert.match(options, /prevWeekBtn\.addEventListener\('click', \(\) => \{\s*currentMonday\.setDate\(currentMonday\.getDate\(\) - 7\);\s*loadAndRenderWorklogs\(\);/);
    assert.match(options, /nextWeekBtn\.addEventListener\('click', \(\) => \{\s*currentMonday\.setDate\(currentMonday\.getDate\(\) \+ 7\);\s*loadAndRenderWorklogs\(\);/);
  });

  it('is unavailable, and closed, while a week loads, like the buttons around it', () => {
    const start = options.indexOf('function setWorklogBusy(');
    const busy = options.slice(start, options.indexOf('\n}\n', start));
    assert.match(busy, /nextWeekBtn\.disabled = isBusy;\s*weekPickerBtn\.disabled = isBusy;/);
    assert.match(busy, /if \(isBusy\) weekPicker\.close\(\);/);
    // Created before anything can load a week.
    assert.ok(options.indexOf('const weekPicker = createWeekPicker({') < options.indexOf('function loadAndRenderWorklogs('));
  });
});
