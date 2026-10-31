/**
 * Nager.Date public holidays API (Community API v4, https://nagerholidays.com/api).
 *
 * Two endpoints, no API key:
 * - GET /api/v4/Countries/Available: [{ countryCode, name }]
 * - GET /api/v4/Holidays/{countryCode}/{year}:
 *   [{ date, name, countryCode, nationalHoliday?, subdivisionCodes, holidayTypes }]
 *   (400 and 404 for an invalid request or an unknown country)
 *
 * Responses are checked before use. Only official holidays for the whole country are kept:
 * holidayTypes includes "Public", and the holiday isn't limited to some subdivisions. Bank,
 * school, optional, and observance days, and regional holidays, are left out, since only a
 * country is selected.
 *
 * No DOM and no storage; `fetch` is injected.
 */

export const NAGER_DATE_API_URL = 'https://nagerholidays.com/api/v4';

const DEFAULT_TIMEOUT_MS = 15000;
const COUNTRY_CODE = /^[A-Z]{2}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A failed request or an unusable response. `code`: HTTP_ERROR (with `status`), NETWORK_ERROR,
 * TIMEOUT, MALFORMED_RESPONSE, or INVALID_REQUEST.
 */
export class HolidayApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'HolidayApiError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/**
 * @param {string} value
 * @returns {string} The uppercase ISO 3166-1 alpha-2 code, or '' when `value` isn't one
 */
export function normalizeCountryCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return COUNTRY_CODE.test(code) ? code : '';
}

/**
 * Checks a `Countries/Available` response.
 *
 * @param {unknown} data
 * @returns {Array<{ countryCode: string, name: string }>} Sorted by name, without entries that aren't usable
 */
export function parseCountries(data) {
  if (!Array.isArray(data)) throw new HolidayApiError('The country list is not a list.', 'MALFORMED_RESPONSE');
  const byCode = new Map();
  for (const item of data) {
    const countryCode = normalizeCountryCode(item?.countryCode);
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (countryCode && name && !byCode.has(countryCode)) byCode.set(countryCode, { countryCode, name });
  }
  if (byCode.size === 0) throw new HolidayApiError('The country list is empty.', 'MALFORMED_RESPONSE');
  return [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/** True for a real calendar date in `year` ("2026-02-30" isn't). */
function isDateInYear(date, year) {
  const match = ISO_DATE.exec(date);
  if (!match || Number(match[1]) !== year) return false;
  const parsed = new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[3])));
  return parsed.getUTCMonth() === Number(match[2]) - 1 && parsed.getUTCDate() === Number(match[3]);
}

/** Applies to the whole country: says so, or (without nationalHoliday) names no subdivisions. */
function isNationwide(item) {
  if (typeof item.nationalHoliday === 'boolean') return item.nationalHoliday;
  return !Array.isArray(item.subdivisionCodes) || item.subdivisionCodes.length === 0;
}

/**
 * Checks a `Holidays/{countryCode}/{year}` response and keeps the official nationwide holidays.
 * An empty list is valid.
 *
 * @param {unknown} data
 * @param {string} countryCode
 * @param {number} year
 * @returns {Array<{ date: string, name: string }>} In date order
 */
export function parseHolidays(data, countryCode, year) {
  if (!Array.isArray(data)) throw new HolidayApiError('The holiday list is not a list.', 'MALFORMED_RESPONSE');
  const holidays = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name || typeof item.date !== 'string' || !isDateInYear(item.date, year)) continue;
    // Another country's record never counts for this one.
    if (item.countryCode !== undefined && normalizeCountryCode(item.countryCode) !== countryCode) continue;
    if (!Array.isArray(item.holidayTypes) || !item.holidayTypes.includes('Public')) continue;
    if (!isNationwide(item)) continue;
    holidays.push({ date: item.date, name });
  }
  return holidays.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch]
 * @param {string} [options.baseUrl]
 * @param {number} [options.timeoutMs]
 */
export function createNagerDateClient({ fetch: fetchFn = globalThis.fetch, baseUrl = NAGER_DATE_API_URL, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  async function getJson(path) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, {
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        signal: controller.signal
      });
      if (!response.ok) {
        throw new HolidayApiError(`Nager.Date answered with HTTP ${response.status}.`, 'HTTP_ERROR', response.status);
      }
      try {
        return await response.json();
      } catch {
        throw new HolidayApiError('Nager.Date sent a response that is not JSON.', 'MALFORMED_RESPONSE');
      }
    } catch (err) {
      if (err instanceof HolidayApiError) throw err;
      if (controller.signal.aborted) {
        throw new HolidayApiError(`Nager.Date did not answer within ${timeoutMs / 1000} seconds.`, 'TIMEOUT');
      }
      throw new HolidayApiError(`Could not reach Nager.Date: ${err?.message || 'network error'}`, 'NETWORK_ERROR');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return {
    /** @returns {Promise<Array<{ countryCode: string, name: string }>>} */
    async fetchCountries() {
      return parseCountries(await getJson('/Countries/Available'));
    },

    /**
     * @param {string} countryCode
     * @param {number} year
     * @returns {Promise<Array<{ date: string, name: string }>>}
     */
    async fetchHolidays(countryCode, year) {
      const code = normalizeCountryCode(countryCode);
      if (!code || !Number.isInteger(year)) throw new HolidayApiError('Invalid country or year.', 'INVALID_REQUEST');
      return parseHolidays(await getJson(`/Holidays/${code}/${year}`), code, year);
    }
  };
}
