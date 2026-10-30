process.env.TZ = 'Europe/London';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument, toHtml } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import { renderWeek, updateHolidays } from '../src/ui/weekView.js';
import { buildEmptyWeek } from '../src/worklog/worklogUtils.js';
import { buildHolidayIndicators } from '../src/holidays/holidayIcons.js';

// Monday 21 December 2026: Christmas is on the Friday, Boxing Day on the Saturday.
const MONDAY = new Date(2026, 11, 21);
const UK = buildHolidayIndicators([
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2026-12-26', name: 'Boxing Day' },
  { date: '2026-12-26', name: "St. Stephen's Day" }
]);
const ITALY = buildHolidayIndicators([{ date: '2026-12-26', name: 'Santo Stefano' }]);

describe('WeekView - public holidays', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  function render(holidays) {
    const container = h('div');
    const week = buildEmptyWeek(MONDAY);
    renderWeek(container, week, { selectedDateKey: '2026-12-21', onSelectDay: () => {}, holidays });
    return { container, week };
  }

  const card = (container, dateKey) => container.querySelector(`.day-card[data-date-key="${dateKey}"]`);
  const iconsOn = (container) => container.querySelectorAll('.day-holiday').map((icon) => [icon.closest('.day-card').dataset.dateKey, icon.textContent]);

  it('shows one icon beside the weekday name on each holiday, with its name as the tooltip', () => {
    const { container } = render(UK);
    assert.deepEqual(iconsOn(container), [['2026-12-25', '🎄'], ['2026-12-26', '🎉']]);

    const christmas = card(container, '2026-12-25').querySelector('.day-holiday');
    assert.equal(christmas.getAttribute('title'), 'Christmas Day');
    assert.equal(christmas.getAttribute('aria-label'), 'Public holiday: Christmas Day');
    // The weekday name stays first (left); the icon is in the group on the right.
    const top = christmas.closest('.day-card-top');
    assert.equal(top.children[0].className, 'day-name');
    assert.equal(top.children[0].textContent, 'Fri');
    assert.equal(christmas.parentNode, top.children[1]);
    assert.equal(christmas.parentNode.className, 'day-card-end');
    assert.match(card(container, '2026-12-25').title, /· Christmas Day$/);

    // Two names on one date: one icon, both names.
    const boxingDay = card(container, '2026-12-26');
    assert.equal(boxingDay.querySelectorAll('.day-holiday').length, 1);
    assert.equal(boxingDay.querySelector('.day-holiday').getAttribute('title'), "Boxing Day / St. Stephen's Day");
  });

  it('puts the icon before the Today badge, and keeps the badge when the icons change', () => {
    const container = h('div');
    const week = buildEmptyWeek(MONDAY, new Date(2026, 11, 25));
    renderWeek(container, week, { selectedDateKey: '2026-12-21', onSelectDay: () => {}, holidays: UK });
    const end = () => card(container, '2026-12-25').querySelector('.day-card-end').children.map((el) => el.className);
    assert.deepEqual(end(), ['day-holiday', 'badge-today']);

    updateHolidays(container, week, new Map());
    assert.deepEqual(end(), ['badge-today']);
  });

  it('shows no icons without holidays, and keeps the weekday name unchanged', () => {
    const { container } = render(undefined);
    assert.equal(container.querySelectorAll('.day-holiday').length, 0);
    assert.equal(card(container, '2026-12-25').querySelector('.day-name').textContent, 'Fri');
    assert.doesNotMatch(card(container, '2026-12-25').title, /·/);
  });

  it('updates the icons in place: another country, or the feature turned off', () => {
    const { container, week } = render(UK);
    const before = card(container, '2026-12-25');
    before.focus();

    updateHolidays(container, week, ITALY);
    assert.deepEqual(iconsOn(container), [['2026-12-26', '🎉']]);
    assert.equal(card(container, '2026-12-26').querySelector('.day-holiday').getAttribute('title'), 'Santo Stefano');
    assert.equal(card(container, '2026-12-25'), before, 'the cards are not rebuilt');
    assert.equal(document.activeElement, before);

    updateHolidays(container, week, new Map());
    assert.equal(container.querySelectorAll('.day-holiday').length, 0);
    assert.doesNotMatch(card(container, '2026-12-26').title, /·/);
  });

  it('leaves worklog totals and the day cards otherwise as they were', () => {
    const plain = render(undefined).container;
    const withHolidays = render(UK).container;
    const strip = (html) => html.replace(/<span class="day-holiday"[^>]*>[^<]*<\/span>/g, '').replace(/ title="[^"]*"/g, '');
    assert.equal(strip(toHtml(withHolidays)), strip(toHtml(plain)));
  });

  it('keeps holidays display-only: no worklog, timer, or Jira code depends on them', () => {
    for (const file of ['../src/holidays/publicHolidays.js', '../src/holidays/holidayCache.js', '../src/holidays/holidayIcons.js', '../src/holidays/nagerDateClient.js', '../src/ui/publicHolidaysSettings.js']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /from\s+['"][^'"]*(jira|worklog|timer)\//i, file);
    }
    for (const file of ['../src/worklog/weeklyWorklogService.js', '../src/worklog/worklogUtils.js', '../src/timer/timeTrackingStore.js', '../src/timer/timerController.js', '../src/jira/JiraClient.js']) {
      assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /holiday/i, file);
    }
  });
});
