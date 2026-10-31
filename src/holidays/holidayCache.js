/**
 * Local cache of Nager.Date data: the supported-country list, and one public-holiday dataset per
 * country and calendar year.
 *
 * Stored in `storage.local` under its own keys, apart from settings, credentials, and timer data:
 * - holidayCache:countries: { cachedAt, countries: [{ countryCode, name }] }
 * - holidayCache:{countryCode}:{year}: { countryCode, year, cachedAt, holidays: [{ date, name }] }
 * `cachedAt` is when the data was downloaded (epoch milliseconds); reading it never changes it.
 *
 * Retention is 400 days: data is expired once `now - cachedAt >= CACHE_RETENTION_MS`. Expired data
 * is downloaded again when it's needed, and the new copy replaces it in one write, so the old copy
 * is never removed before a replacement is stored. When the download fails, the expired copy is
 * still used (marked `stale`), and the next request tries again.
 *
 * Nothing runs on a schedule. An expired dataset is only ever discarded by its own replacement, so
 * it stays available as a fallback whatever country or year is selected. Cleanup is lazy: the first
 * time a cache is used, it removes entries under its prefix that can't be read (damaged, or not in
 * this format), since they can never be used.
 *
 * Requests for the same data share one download: within a page through the promise in flight,
 * and between tabs through a Web Lock per storage key (re-reading the cache once the lock is
 * held, so a tab that waited uses what the other tab stored). No DOM; storage, fetching, the
 * clock, and the lock are injected.
 */

export const CACHE_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

export const HOLIDAY_CACHE_PREFIX = 'holidayCache:';
export const COUNTRIES_KEY = `${HOLIDAY_CACHE_PREFIX}countries`;

const LOCK_PREFIX = 'timesheet-for-jira:';

/**
 * @param {string} countryCode - Uppercase ISO 3166-1 alpha-2
 * @param {number} year
 */
export const datasetKey = (countryCode, year) => `${HOLIDAY_CACHE_PREFIX}${countryCode}:${year}`;

/** True once data downloaded at `cachedAt` is past the retention period. */
export const isExpired = (cachedAt, now) => now - cachedAt >= CACHE_RETENTION_MS;

/**
 * A lock per storage key, shared by the extension's tabs. Without Web Locks every call runs at
 * once: tabs may then download the same data twice, which is harmless.
 *
 * @param {Navigator} [nav]
 * @returns {{ run: <T>(name: string, fn: () => Promise<T>) => Promise<T> }}
 */
export function createHolidayCacheLock(nav = globalThis.navigator) {
  const locks = nav?.locks;
  if (typeof locks?.request !== 'function') return { run: (_name, fn) => fn() };
  return { run: (name, fn) => locks.request(LOCK_PREFIX + name, () => fn()) };
}

const isRecord = (value) => Boolean(value) && typeof value === 'object';
const isString = (value) => typeof value === 'string' && value !== '';

function readDataset(value, countryCode, year) {
  if (!isRecord(value) || value.countryCode !== countryCode || value.year !== year) return null;
  if (!Number.isFinite(value.cachedAt) || !Array.isArray(value.holidays)) return null;
  if (!value.holidays.every((holiday) => isRecord(holiday) && isString(holiday.date) && isString(holiday.name))) return null;
  return value;
}

function readCountries(value) {
  if (!isRecord(value) || !Number.isFinite(value.cachedAt) || !Array.isArray(value.countries)) return null;
  if (!value.countries.every((country) => isRecord(country) && isString(country.countryCode) && isString(country.name))) return null;
  return value.countries.length ? value : null;
}

/**
 * @param {{ get: Function, set: Function, remove: Function }} storageArea - `storage.local`, or createMemoryStorageArea()
 * @param {object} options
 * @param {{ fetchCountries: Function, fetchHolidays: Function }} options.api - From createNagerDateClient()
 * @param {() => number} [options.now=Date.now] - Epoch milliseconds
 * @param {{ run: Function }} [options.lock] - From createHolidayCacheLock()
 */
export function createHolidayCache(storageArea, { api, now = Date.now, lock = createHolidayCacheLock() }) {
  const inFlight = new Map();
  let cleaned = false;

  async function read(key, parse) {
    const { [key]: value } = await storageArea.get([key]);
    return parse(value);
  }

  /**
   * Fresh cached data, else downloaded and stored data, else the expired copy (when the download
   * fails and there is one). Rejects only when there is no data at all.
   */
  function load(key, parse, download, toEntry) {
    if (inFlight.has(key)) return inFlight.get(key);

    const promise = (async () => {
      const cached = await read(key, parse);
      if (cached && !isExpired(cached.cachedAt, now())) return { data: cached, stale: false };
      try {
        return await lock.run(key, async () => {
          // Another tab may have stored it while this one waited for the lock.
          const current = await read(key, parse);
          if (current && !isExpired(current.cachedAt, now())) return { data: current, stale: false };
          const entry = toEntry(await download(), now());
          // Replaces the expired copy, if any, in one write.
          await storageArea.set({ [key]: entry });
          return { data: entry, stale: false };
        });
      } catch (err) {
        if (cached) return { data: cached, stale: true, error: err };
        throw err;
      }
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, promise);
    return promise;
  }

  /** Reads any entry under the prefix; null when it can't be used. */
  function readEntry(key, value) {
    if (key === COUNTRIES_KEY) return readCountries(value);
    const match = /^([A-Z]{2}):(\d{4})$/.exec(key.slice(HOLIDAY_CACHE_PREFIX.length));
    return match ? readDataset(value, match[1], Number(match[2])) : null;
  }

  /** Removes unusable entries, once per cache. Expired data that can be read is left alone. */
  async function cleanUp() {
    if (cleaned) return;
    cleaned = true;
    const everything = await storageArea.get(null);
    const unusable = Object.entries(everything ?? {})
      .filter(([key, value]) => key.startsWith(HOLIDAY_CACHE_PREFIX) && !readEntry(key, value))
      .map(([key]) => key);
    for (const key of unusable) {
      await lock.run(key, async () => {
        // Skipped if another tab has just stored a good copy.
        const { [key]: value } = await storageArea.get([key]);
        if (!readEntry(key, value)) await storageArea.remove(key);
      });
    }
  }

  const cleanUpLater = () => cleanUp().catch((err) => console.warn('Holiday cache cleanup failed:', err));

  return {
    /**
     * The supported countries, sorted by name.
     * @returns {Promise<{ countries: Array<{ countryCode: string, name: string }>, cachedAt: number, stale: boolean }>}
     */
    async getCountries() {
      try {
        const { data, stale } = await load(COUNTRIES_KEY, readCountries, () => api.fetchCountries(),
          (countries, cachedAt) => ({ cachedAt, countries }));
        return { countries: data.countries, cachedAt: data.cachedAt, stale };
      } finally {
        cleanUpLater();
      }
    },

    /**
     * The countries saved in the cache, whatever their age, without downloading anything.
     * @returns {Promise<Array<{ countryCode: string, name: string }> | null>}
     */
    async peekCountries() {
      return (await read(COUNTRIES_KEY, readCountries))?.countries ?? null;
    },

    /**
     * One country's official public holidays in one year.
     * @param {string} countryCode - Uppercase ISO 3166-1 alpha-2
     * @param {number} year
     * @returns {Promise<{ holidays: Array<{ date: string, name: string }>, cachedAt: number, stale: boolean }>}
     */
    async getHolidays(countryCode, year) {
      try {
        const { data, stale } = await load(datasetKey(countryCode, year), (value) => readDataset(value, countryCode, year),
          () => api.fetchHolidays(countryCode, year),
          (holidays, cachedAt) => ({ countryCode, year, cachedAt, holidays }));
        return { holidays: data.holidays, cachedAt: data.cachedAt, stale };
      } finally {
        cleanUpLater();
      }
    }
  };
}
