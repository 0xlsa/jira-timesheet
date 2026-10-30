import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicHolidays, RETRY_AFTER_MS } from '../src/holidays/publicHolidays.js';
import { createHolidayCache } from '../src/holidays/holidayCache.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';

const NOW = Date.UTC(2026, 9, 30, 12);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const DATA = {
  'IT:2026': [{ date: '2026-12-25', name: 'Natale' }, { date: '2026-12-26', name: 'Santo Stefano' }],
  'IT:2027': [{ date: '2027-01-01', name: "New Year's Day" }],
  'FR:2026': [{ date: '2026-07-14', name: 'Bastille Day' }],
  'GB:2026': [{ date: '2026-12-25', name: 'Christmas Day' }]
};

/** A cache whose answers can be held back, per country and year; records every request. */
function fakeCache({ fail = false } = {}) {
  const calls = [];
  const held = new Map();
  return {
    calls,
    hold(key) { let release; held.set(key, { promise: new Promise((resolve) => { release = resolve; }), release: () => release() }); },
    release(key) { held.get(key).release(); held.delete(key); },
    async getHolidays(countryCode, year) {
      const key = `${countryCode}:${year}`;
      calls.push(key);
      if (held.has(key)) await held.get(key).promise;
      if (fail) throw new Error('offline');
      return { holidays: DATA[key] ?? [], cachedAt: NOW, stale: false };
    }
  };
}

function setup({ cache = fakeCache(), year = 2026 } = {}) {
  let clock = NOW;
  const changes = [];
  const holidays = createPublicHolidays({ cache, now: () => clock, currentYear: () => year, onChange: () => changes.push(true) });
  return { holidays, cache, changes, advance: (ms) => { clock += ms; } };
}

// A week, as date keys (Monday to Sunday).
const week = (...dates) => dates;
const CHRISTMAS_2026 = week('2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24', '2026-12-25', '2026-12-26', '2026-12-27');
const NEW_YEAR_2027 = week('2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03');
const JANUARY_2027 = week('2027-01-11', '2027-01-12', '2027-01-13', '2027-01-14', '2027-01-15', '2027-01-16', '2027-01-17');
const JULY_2026 = week('2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19');
const JANUARY_2025 = week('2025-01-13', '2025-01-14', '2025-01-15', '2025-01-16', '2025-01-17', '2025-01-18', '2025-01-19');

describe('Public holidays', () => {
  it('downloads nothing while the feature is off or no country is selected', async () => {
    const { holidays, cache } = setup();
    holidays.configure({ enabled: false, countryCode: 'IT' });
    assert.equal(holidays.indicatorsFor(CHRISTMAS_2026).size, 0);
    holidays.configure({ enabled: true, countryCode: '' });
    assert.equal(holidays.indicatorsFor(CHRISTMAS_2026).size, 0);
    await flush();
    assert.deepEqual(cache.calls, []);
  });

  it('loads the current calendar year as soon as it is turned on, and not the years around it', async () => {
    const { holidays, cache, changes } = setup({ year: 2026 });
    holidays.configure({ enabled: true, countryCode: 'IT' });
    await flush();
    assert.deepEqual(cache.calls, ['IT:2026']);
    assert.ok(changes.length >= 2, 'the page is told when the data arrives');
  });

  it('shows the icons on the right dates, with the names as tooltips', async () => {
    const { holidays } = setup();
    holidays.configure({ enabled: true, countryCode: 'IT' });
    await flush();
    const indicators = holidays.indicatorsFor(CHRISTMAS_2026);
    assert.deepEqual([...indicators.keys()], ['2026-12-25', '2026-12-26']);
    assert.deepEqual(indicators.get('2026-12-25'), { icon: '🎉', label: 'Natale' });
    assert.equal(holidays.indicatorsFor(JULY_2026).size, 0);
  });

  it('loads another year only when a week in it is displayed, and reuses it when going back', async () => {
    const { holidays, cache } = setup();
    holidays.configure({ enabled: true, countryCode: 'IT' });
    await flush();

    holidays.indicatorsFor(JANUARY_2027);
    await flush();
    assert.deepEqual(cache.calls, ['IT:2026', 'IT:2027']);

    holidays.indicatorsFor(JANUARY_2025);
    await flush();
    assert.deepEqual(cache.calls, ['IT:2026', 'IT:2027', 'IT:2025']);

    holidays.indicatorsFor(JANUARY_2027);
    holidays.indicatorsFor(CHRISTMAS_2026);
    await flush();
    assert.equal(cache.calls.length, 3);
  });

  it('loads both years of a week that spans the new year', async () => {
    const { holidays, cache } = setup();
    holidays.configure({ enabled: true, countryCode: 'IT' });
    holidays.indicatorsFor(NEW_YEAR_2027);
    await flush();
    assert.deepEqual(cache.calls, ['IT:2026', 'IT:2027']);
    assert.equal(holidays.indicatorsFor(NEW_YEAR_2027).get('2027-01-01').icon, '🎆');
  });

  it('shows the newly selected country, using its cached data', async () => {
    const storage = createMemoryStorageArea();
    const api = { calls: [], async fetchHolidays(c, y) { api.calls.push(`${c}:${y}`); return DATA[`${c}:${y}`] ?? []; }, async fetchCountries() { return []; } };
    const cache = createHolidayCache(storage, { api, now: () => NOW, lock: { run: (_n, fn) => fn() } });
    const { holidays } = setup({ cache });

    holidays.configure({ enabled: true, countryCode: 'IT' });
    await flush();
    holidays.configure({ enabled: true, countryCode: 'GB' });
    await flush();
    assert.deepEqual([...holidays.indicatorsFor(CHRISTMAS_2026).values()], [{ icon: '🎄', label: 'Christmas Day' }]);

    holidays.configure({ enabled: true, countryCode: 'IT' });
    await flush();
    assert.deepEqual([...holidays.indicatorsFor(CHRISTMAS_2026).keys()], ['2026-12-25', '2026-12-26']);
    assert.deepEqual(api.calls, ['IT:2026', 'GB:2026'], 'switching back reuses the cache');
  });

  it("never shows a download that finishes after the country changed", async () => {
    const cache = fakeCache();
    cache.hold('IT:2026');
    const { holidays, changes } = setup({ cache });
    holidays.configure({ enabled: true, countryCode: 'IT' });
    holidays.configure({ enabled: true, countryCode: 'FR' });
    await flush();
    const before = changes.length;

    cache.release('IT:2026');
    await flush();
    assert.equal(changes.length, before, 'no update for the previous country');
    assert.deepEqual([...holidays.indicatorsFor(CHRISTMAS_2026).keys()], []);
    assert.deepEqual([...holidays.indicatorsFor(JULY_2026).keys()], ['2026-07-14']);
  });

  it('removes the icons and stops downloading when turned off, even for a download in progress', async () => {
    const cache = fakeCache();
    cache.hold('IT:2027');
    const { holidays, changes } = setup({ cache });
    holidays.configure({ enabled: true, countryCode: 'IT' });
    holidays.indicatorsFor(JANUARY_2027);
    await flush();

    holidays.configure({ enabled: false, countryCode: 'IT' });
    const before = changes.length;
    cache.release('IT:2027');
    await flush();
    assert.equal(changes.length, before);
    assert.equal(holidays.indicatorsFor(CHRISTMAS_2026).size, 0);
    assert.equal(holidays.indicatorsFor(NEW_YEAR_2027).size, 0);

    holidays.indicatorsFor(JANUARY_2025);
    await flush();
    assert.deepEqual(cache.calls, ['IT:2026', 'IT:2027']);
  });

  it('shows nothing, without failing, when the data is unavailable, and retries later rather than in a loop', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const cache = fakeCache({ fail: true });
    const { holidays, advance } = setup({ cache });
    holidays.configure({ enabled: true, countryCode: 'IT' });
    await flush();
    for (let i = 0; i < 5; i++) assert.equal(holidays.indicatorsFor(CHRISTMAS_2026).size, 0);
    await flush();
    assert.deepEqual(cache.calls, ['IT:2026']);

    advance(RETRY_AFTER_MS);
    holidays.indicatorsFor(CHRISTMAS_2026);
    await flush();
    assert.deepEqual(cache.calls, ['IT:2026', 'IT:2026']);
  });

  it('retries a failed year when the settings are saved again', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const cache = fakeCache({ fail: true });
    const { holidays } = setup({ cache });
    holidays.configure({ enabled: true, countryCode: 'IT' });
    await flush();
    holidays.configure({ enabled: true, countryCode: 'IT' });
    await flush();
    assert.deepEqual(cache.calls, ['IT:2026', 'IT:2026']);
  });
});
