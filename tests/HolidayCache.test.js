import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHolidayCache, datasetKey, isExpired, CACHE_RETENTION_MS, COUNTRIES_KEY, HOLIDAY_CACHE_PREFIX } from '../src/holidays/holidayCache.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 30, 12);

const IT_2026 = [{ date: '2026-12-25', name: 'Christmas Day' }];
const IT_2027 = [{ date: '2027-12-25', name: 'Christmas Day' }];
const FR_2026 = [{ date: '2026-07-14', name: 'Bastille Day' }];
const COUNTRIES = [{ countryCode: 'FR', name: 'France' }, { countryCode: 'IT', name: 'Italy' }];

const dataset = (countryCode, year, holidays, cachedAt) => ({ countryCode, year, cachedAt, holidays });

/** An API that records its calls; `fail` makes every call reject, `gate` holds calls until opened. */
function fakeApi({ holidays = {}, countries = COUNTRIES, fail = false } = {}) {
  const calls = [];
  let open;
  const api = {
    calls,
    gate: null,
    hold() { api.gate = new Promise((resolve) => { open = resolve; }); },
    release() { open(); },
    async fetchCountries() {
      calls.push(['countries']);
      if (api.gate) await api.gate;
      if (fail) throw new Error('offline');
      return countries;
    },
    async fetchHolidays(countryCode, year) {
      calls.push([countryCode, year]);
      if (api.gate) await api.gate;
      if (fail) throw new Error('offline');
      return holidays[`${countryCode}:${year}`] ?? [];
    }
  };
  return api;
}

/** A lock shared by caches, like a Web Lock shared by tabs: one holder per name at a time. */
function sharedLock() {
  const tails = new Map();
  return {
    run(name, fn) {
      const previous = tails.get(name) ?? Promise.resolve();
      const result = previous.then(() => fn());
      tails.set(name, result.catch(() => {}));
      return result;
    }
  };
}

/** Storage that records writes and removals. */
function recordingStorage(initial) {
  const area = createMemoryStorageArea(initial);
  const ops = [];
  return {
    ops,
    get: (keys) => area.get(keys),
    async set(items) { ops.push(['set', ...Object.keys(items)]); return area.set(items); },
    async remove(keys) { ops.push(['remove', keys]); return area.remove(keys); }
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup({ stored = {}, api = fakeApi({ holidays: { 'IT:2026': IT_2026, 'IT:2027': IT_2027, 'FR:2026': FR_2026 } }), now = NOW, lock = sharedLock() } = {}) {
  const storage = recordingStorage(stored);
  let clock = now;
  const cache = createHolidayCache(storage, { api, now: () => clock, lock });
  return { storage, api, cache, setNow: (value) => { clock = value; } };
}

describe('Holiday cache - datasets', () => {
  it('uses a valid cached dataset without any request', async () => {
    const { cache, api } = setup({ stored: { [datasetKey('IT', 2026)]: dataset('IT', 2026, IT_2026, NOW - DAY_MS) } });
    const result = await cache.getHolidays('IT', 2026);
    assert.deepEqual(result, { holidays: IT_2026, cachedAt: NOW - DAY_MS, stale: false });
    assert.deepEqual(api.calls, []);
  });

  it('downloads a missing dataset and stores it by country and year, with when it was downloaded', async () => {
    const { cache, api, storage } = setup();
    await cache.getHolidays('IT', 2027);
    assert.deepEqual(api.calls, [['IT', 2027]]);
    const stored = await storage.get(null);
    assert.deepEqual(Object.keys(stored), ['holidayCache:IT:2027']);
    assert.deepEqual(stored['holidayCache:IT:2027'], { countryCode: 'IT', year: 2027, cachedAt: NOW, holidays: IT_2027 });
  });

  it('expires a dataset 400 days after it was downloaded', async () => {
    assert.equal(CACHE_RETENTION_MS, 400 * 24 * 60 * 60 * 1000);
    assert.equal(isExpired(NOW - CACHE_RETENTION_MS + 1, NOW), false);
    assert.equal(isExpired(NOW - CACHE_RETENTION_MS, NOW), true);

    const almost = setup({ stored: { [datasetKey('IT', 2026)]: dataset('IT', 2026, IT_2026, NOW - CACHE_RETENTION_MS + 1) } });
    await almost.cache.getHolidays('IT', 2026);
    assert.deepEqual(almost.api.calls, []);

    const expired = setup({ stored: { [datasetKey('IT', 2026)]: dataset('IT', 2026, [], NOW - CACHE_RETENTION_MS) } });
    const result = await expired.cache.getHolidays('IT', 2026);
    assert.deepEqual(expired.api.calls, [['IT', 2026]]);
    assert.deepEqual(result, { holidays: IT_2026, cachedAt: NOW, stale: false });
    assert.equal((await expired.storage.get([datasetKey('IT', 2026)]))[datasetKey('IT', 2026)].cachedAt, NOW);
  });

  it('keeps and uses an expired dataset when its refresh fails, without changing cachedAt', async () => {
    const old = dataset('IT', 2026, IT_2026, NOW - 500 * DAY_MS);
    const { cache, api, storage } = setup({ stored: { [datasetKey('IT', 2026)]: old }, api: fakeApi({ fail: true }) });

    const result = await cache.getHolidays('IT', 2026);
    assert.equal(result.stale, true);
    assert.deepEqual(result.holidays, IT_2026);
    assert.equal(result.cachedAt, old.cachedAt);
    assert.deepEqual(await storage.get([datasetKey('IT', 2026)]), { [datasetKey('IT', 2026)]: old });
    assert.deepEqual(storage.ops, []);

    // Tried again on the next request, not in a loop.
    await cache.getHolidays('IT', 2026);
    assert.deepEqual(api.calls, [['IT', 2026], ['IT', 2026]]);
  });

  it('keeps the old dataset until its replacement is stored, and replaces it in one write', async () => {
    const old = dataset('IT', 2026, [], NOW - 500 * DAY_MS);
    const api = fakeApi({ holidays: { 'IT:2026': IT_2026 } });
    api.hold();
    const { cache, storage } = setup({ stored: { [datasetKey('IT', 2026)]: old }, api });

    const pending = cache.getHolidays('IT', 2026);
    await flush();
    assert.deepEqual(api.calls, [['IT', 2026]]);
    assert.deepEqual(await storage.get([datasetKey('IT', 2026)]), { [datasetKey('IT', 2026)]: old }, 'still there while downloading');

    api.release();
    await pending;
    assert.deepEqual(storage.ops, [['set', datasetKey('IT', 2026)]]);
    assert.equal((await storage.get([datasetKey('IT', 2026)]))[datasetKey('IT', 2026)].cachedAt, NOW);
  });

  it('rejects when there is no data at all', async () => {
    const { cache } = setup({ api: fakeApi({ fail: true }) });
    await assert.rejects(cache.getHolidays('IT', 2026), /offline/);
  });

  it("reuses each country's and each year's valid dataset", async () => {
    const { cache, api } = setup();
    await cache.getHolidays('IT', 2026);
    await cache.getHolidays('FR', 2026);
    await cache.getHolidays('IT', 2027);
    assert.deepEqual(api.calls, [['IT', 2026], ['FR', 2026], ['IT', 2027]]);

    // Back to the first country and year: nothing is downloaded again.
    await cache.getHolidays('IT', 2026);
    await cache.getHolidays('FR', 2026);
    await cache.getHolidays('IT', 2027);
    assert.equal(api.calls.length, 3);
  });

  it('downloads only the requested year', async () => {
    const { cache, api } = setup();
    await cache.getHolidays('IT', 2027);
    assert.deepEqual(api.calls, [['IT', 2027]]);
  });

  it('shares one download between simultaneous requests in a page', async () => {
    const { cache, api } = setup();
    const results = await Promise.all([cache.getHolidays('IT', 2026), cache.getHolidays('IT', 2026), cache.getHolidays('IT', 2026)]);
    assert.deepEqual(api.calls, [['IT', 2026]]);
    assert.ok(results.every((result) => result.holidays === results[0].holidays));
  });

  it('shares one download between tabs through the lock', async () => {
    const api = fakeApi({ holidays: { 'IT:2026': IT_2026 } });
    const storage = createMemoryStorageArea();
    const lock = sharedLock();
    const tabA = createHolidayCache(storage, { api, now: () => NOW, lock });
    const tabB = createHolidayCache(storage, { api, now: () => NOW, lock });
    const [a, b] = await Promise.all([tabA.getHolidays('IT', 2026), tabB.getHolidays('IT', 2026)]);
    assert.deepEqual(api.calls, [['IT', 2026]]);
    assert.deepEqual(a.holidays, b.holidays);
  });

  it('treats a damaged dataset as missing', async () => {
    const { cache, api } = setup({ stored: { [datasetKey('IT', 2026)]: { countryCode: 'IT', year: 2026, cachedAt: 'yesterday', holidays: [] } } });
    await cache.getHolidays('IT', 2026);
    assert.deepEqual(api.calls, [['IT', 2026]]);
  });
});

describe('Holiday cache - lazy cleanup', () => {
  const expired = NOW - 401 * DAY_MS;

  it('removes unusable entries when the cache is used, and keeps expired data of every country as a fallback', async () => {
    const { cache, storage } = setup({
      stored: {
        [datasetKey('FR', 2025)]: dataset('FR', 2025, FR_2026, expired),
        [datasetKey('IT', 2024)]: dataset('IT', 2024, [], expired),
        [datasetKey('DE', 2026)]: dataset('DE', 2026, [], NOW - DAY_MS),
        [COUNTRIES_KEY]: { cachedAt: expired, countries: COUNTRIES },
        [datasetKey('ES', 2026)]: { countryCode: 'ES', year: 2026, holidays: 'damaged' },
        [datasetKey('PT', 2026)]: dataset('ES', 2026, [], NOW),
        'holidayCache:old-format': [1, 2, 3],
        timeTracking: { version: 2 },
        token: 'secret'
      }
    });
    await cache.getHolidays('IT', 2026);
    await flush();
    await flush();

    const keys = Object.keys(await storage.get(null)).sort();
    assert.deepEqual(keys, ['holidayCache:DE:2026', 'holidayCache:FR:2025', 'holidayCache:IT:2024', 'holidayCache:IT:2026', 'holidayCache:countries', 'timeTracking', 'token']);
    assert.deepEqual(storage.ops.filter(([op]) => op === 'remove').map(([, key]) => key).sort(),
      ['holidayCache:ES:2026', 'holidayCache:PT:2026', 'holidayCache:old-format']);
  });

  it('never deletes an expired dataset before its replacement is stored', async () => {
    const old = dataset('FR', 2025, FR_2026, expired);
    const { cache, storage } = setup({ stored: { [datasetKey('FR', 2025)]: old }, api: fakeApi({ fail: true }) });
    // Switching to and between other countries and years, with downloads failing.
    await cache.getHolidays('IT', 2026).catch(() => {});
    await cache.getHolidays('IT', 2027).catch(() => {});
    await cache.getCountries().catch(() => {});
    await flush();
    assert.deepEqual(await storage.get([datasetKey('FR', 2025)]), { [datasetKey('FR', 2025)]: old });
    assert.deepEqual(storage.ops, []);
  });

  it('does not remove an entry another tab has just stored a good copy of', async () => {
    const storage = recordingStorage({ [datasetKey('FR', 2025)]: { damaged: true } });
    const lock = {
      async run(name, fn) {
        // Another tab stored a good copy before this one got the lock.
        if (name === datasetKey('FR', 2025)) await storage.set({ [name]: dataset('FR', 2025, [], NOW) });
        return fn();
      }
    };
    const cache = createHolidayCache(storage, { api: fakeApi(), now: () => NOW, lock });
    await cache.getHolidays('IT', 2026);
    await flush();
    await flush();
    assert.ok((await storage.get([datasetKey('FR', 2025)]))[datasetKey('FR', 2025)]);
  });

  it('runs no scheduled jobs: no timers, alarms, or background refreshes', () => {
    for (const file of ['../src/holidays/holidayCache.js', '../src/holidays/publicHolidays.js']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /setInterval|setTimeout|alarms/, file);
    }
    const client = readFileSync(new URL('../src/holidays/nagerDateClient.js', import.meta.url), 'utf8');
    assert.doesNotMatch(client, /setInterval|alarms/);
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    assert.equal(manifest.permissions.includes('alarms'), false);
    const background = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
    assert.doesNotMatch(background, /holiday/i);
  });

  it('keeps cache keys apart from settings, credentials, and timer data', () => {
    assert.ok(datasetKey('IT', 2026).startsWith(HOLIDAY_CACHE_PREFIX));
    assert.ok(COUNTRIES_KEY.startsWith(HOLIDAY_CACHE_PREFIX));
    for (const key of ['jiraBaseUrl', 'token', 'cloudToken', 'serverToken', 'timeTracking', 'publicHolidaysCountry']) {
      assert.equal(key.startsWith(HOLIDAY_CACHE_PREFIX), false);
    }
  });
});

describe('Holiday cache - country list', () => {
  it('reuses a valid cached list', async () => {
    const { cache, api } = setup({ stored: { [COUNTRIES_KEY]: { cachedAt: NOW - DAY_MS, countries: COUNTRIES } } });
    assert.deepEqual(await cache.getCountries(), { countries: COUNTRIES, cachedAt: NOW - DAY_MS, stale: false });
    assert.deepEqual(api.calls, []);
  });

  it('downloads a missing list and refreshes an expired one', async () => {
    const missing = setup();
    assert.deepEqual((await missing.cache.getCountries()).countries, COUNTRIES);
    assert.deepEqual(missing.api.calls, [['countries']]);
    assert.equal((await missing.storage.get([COUNTRIES_KEY]))[COUNTRIES_KEY].cachedAt, NOW);

    const expired = setup({ stored: { [COUNTRIES_KEY]: { cachedAt: NOW - CACHE_RETENTION_MS, countries: [{ countryCode: 'IT', name: 'Italy' }] } } });
    const result = await expired.cache.getCountries();
    assert.deepEqual(expired.api.calls, [['countries']]);
    assert.deepEqual(result, { countries: COUNTRIES, cachedAt: NOW, stale: false });
  });

  it('falls back to the cached list when the download fails', async () => {
    const old = { cachedAt: NOW - 500 * DAY_MS, countries: COUNTRIES };
    const { cache, storage } = setup({ stored: { [COUNTRIES_KEY]: old }, api: fakeApi({ fail: true }) });
    assert.deepEqual(await cache.getCountries(), { countries: COUNTRIES, cachedAt: old.cachedAt, stale: true });
    assert.deepEqual(storage.ops, []);
  });

  it('rejects when no list is available', async () => {
    const { cache } = setup({ api: fakeApi({ fail: true }) });
    await assert.rejects(cache.getCountries(), /offline/);
  });

  it('peeks at the cached list without downloading', async () => {
    const empty = setup();
    assert.equal(await empty.cache.peekCountries(), null);
    const old = setup({ stored: { [COUNTRIES_KEY]: { cachedAt: NOW - 900 * DAY_MS, countries: COUNTRIES } } });
    assert.deepEqual(await old.cache.peekCountries(), COUNTRIES);
    assert.deepEqual([...empty.api.calls, ...old.api.calls], []);
  });
});
