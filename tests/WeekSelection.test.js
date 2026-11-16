// Local dates throughout; pin a time zone so they're the same on every machine.
process.env.TZ = 'Europe/London';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rememberWeekSelection, restoreWeekSelection, WEEK_SELECTION_KEY } from '../src/worklog/weekSelection.js';

/** A tab's sessionStorage, in memory. */
function memoryStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value))
  };
}

const at = (key, hours = 10) => {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day, hours);
};
// Wednesday 18 November 2026; its week starts on Monday the 16th.
const WEDNESDAY = at('2026-11-18');

/** Saves what's shown at `savedAt`, then reads it back at `now`, as a reload would. */
function reload({ monday, day, savedAt = WEDNESDAY, now = savedAt }) {
  const storage = memoryStorage();
  rememberWeekSelection(() => storage, { monday: at(monday, 0), selectedDateKey: day }, savedAt);
  const restored = restoreWeekSelection(() => storage, now);
  return restored && { monday: restored.monday.toDateString(), selectedDateKey: restored.selectedDateKey };
}

describe('Week selection - kept across a reload', () => {
  it('opens on the week and day that were shown', () => {
    assert.deepEqual(reload({ monday: '2026-10-26', day: '2026-10-28' }),
      { monday: at('2026-10-26', 0).toDateString(), selectedDateKey: '2026-10-28' });
    assert.deepEqual(reload({ monday: '2026-11-23', day: '2026-11-27' }),
      { monday: at('2026-11-23', 0).toDateString(), selectedDateKey: '2026-11-27' }, 'a later week too');
  });

  it('keeps another day of this week selected when reloaded the same week', () => {
    assert.deepEqual(reload({ monday: '2026-11-16', day: '2026-11-16', now: at('2026-11-19') }),
      { monday: at('2026-11-16', 0).toDateString(), selectedDateKey: '2026-11-16' });
  });

  it('follows today when today was selected', () => {
    assert.equal(reload({ monday: '2026-11-16', day: '2026-11-18' }), null, 'the same day');
    assert.equal(reload({ monday: '2026-11-16', day: '2026-11-18', now: at('2026-11-19') }), null, 'the next day selects that day');
  });

  it('follows today when this week was shown and today is now in another week', () => {
    assert.equal(reload({ monday: '2026-11-16', day: '2026-11-17', now: at('2026-11-23') }), null);
  });

  it('keeps an earlier week shown, even days later', () => {
    assert.deepEqual(reload({ monday: '2026-11-09', day: '2026-11-13', now: at('2026-11-25') }),
      { monday: at('2026-11-09', 0).toDateString(), selectedDateKey: '2026-11-13' });
  });

  it('saves the week by its Monday, and selects that Monday when the day isn\'t in the week', () => {
    const storage = memoryStorage();
    rememberWeekSelection(() => storage, { monday: at('2026-10-28'), selectedDateKey: '2026-11-02' }, WEDNESDAY);
    assert.deepEqual(JSON.parse(storage.items.get(WEEK_SELECTION_KEY)), { monday: '2026-10-26', day: '2026-11-02', savedOn: '2026-11-18' });
    assert.equal(restoreWeekSelection(() => storage, WEDNESDAY).selectedDateKey, '2026-10-26');
  });

  it('opens on today when nothing was saved, or what was saved can\'t be used', () => {
    assert.equal(restoreWeekSelection(() => memoryStorage(), WEDNESDAY), null, 'a new tab');
    for (const value of ['not json', '42', 'null', JSON.stringify({ monday: '2026-02-30', day: '2026-02-28', savedOn: '2026-11-18' }),
      JSON.stringify({ monday: '2026-10-26', day: '2026-10-27' }), JSON.stringify({ monday: 20261026, savedOn: '2026-11-18' })]) {
      assert.equal(restoreWeekSelection(() => memoryStorage({ [WEEK_SELECTION_KEY]: value }), WEDNESDAY), null, value);
    }
  });

  it('opens on today, and never fails, when storage can\'t be used', () => {
    const broken = () => { throw new Error('SecurityError'); };
    assert.equal(restoreWeekSelection(broken, WEDNESDAY), null);
    assert.doesNotThrow(() => rememberWeekSelection(broken, { monday: at('2026-10-26'), selectedDateKey: '2026-10-26' }, WEDNESDAY));
    const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
    assert.doesNotThrow(() => rememberWeekSelection(() => full, { monday: at('2026-10-26'), selectedDateKey: '2026-10-26' }, WEDNESDAY));
  });

  it('is wired into the page: restored at start, saved as the page is left', () => {
    const page = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
    assert.match(page, /const tabSessionStorage = \(\) => window\.sessionStorage;/);
    assert.match(page, /let currentMonday = restoredWeek\?\.monday \?\? getMondayOfWeek\(new Date\(\)\);/);
    assert.match(page, /let selectedDateKey = restoredWeek\?\.selectedDateKey \?\? getLocalDateKey\(new Date\(\)\);/);
    assert.match(page, /window\.addEventListener\('pagehide', \(\) => \{[^}]*rememberWeekSelection\(tabSessionStorage, \{ monday: currentMonday, selectedDateKey \}\);/);
  });
});
