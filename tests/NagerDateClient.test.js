import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNagerDateClient, parseCountries, parseHolidays, normalizeCountryCode, HolidayApiError, NAGER_DATE_API_URL } from '../src/holidays/nagerDateClient.js';

/** A fetch that answers every request with `body` (JSON) and records the URLs. */
function fakeFetch(body, { status = 200 } = {}) {
  const urls = [];
  const fetch = async (url, init) => {
    urls.push(url);
    assert.equal(init.credentials, 'omit');
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetch, urls };
}

// A Community API v4 holiday record, as documented in its OpenAPI description.
const holiday = (date, name, extra = {}) => ({ date, name, countryCode: 'IT', nationalHoliday: true, subdivisionCodes: null, holidayTypes: ['Public'], ...extra });

describe('Nager.Date client', () => {
  it('requests the v4 endpoints, without an API key', async () => {
    const countries = fakeFetch([{ countryCode: 'IT', name: 'Italy' }]);
    await createNagerDateClient({ fetch: countries.fetch }).fetchCountries();
    assert.deepEqual(countries.urls, [`${NAGER_DATE_API_URL}/Countries/Available`]);

    const holidays = fakeFetch([]);
    await createNagerDateClient({ fetch: holidays.fetch }).fetchHolidays('it', 2027);
    assert.deepEqual(holidays.urls, [`${NAGER_DATE_API_URL}/Holidays/IT/2027`]);
    assert.equal(NAGER_DATE_API_URL, 'https://nagerholidays.com/api/v4');
  });

  it('sorts the country list by name, uppercases codes, and drops unusable entries', () => {
    const countries = parseCountries([
      { countryCode: 'it', name: 'Italy' },
      { countryCode: 'AT', name: 'Austria' },
      { countryCode: 'IT', name: 'Italy again' },
      { countryCode: 'XXX', name: 'Nowhere' },
      { countryCode: 'DE' },
      null
    ]);
    assert.deepEqual(countries, [{ countryCode: 'AT', name: 'Austria' }, { countryCode: 'IT', name: 'Italy' }]);
  });

  it('rejects a country list that is not a list or has no usable entry', () => {
    assert.throws(() => parseCountries({}), { code: 'MALFORMED_RESPONSE' });
    assert.throws(() => parseCountries([{ countryCode: '1' }]), { code: 'MALFORMED_RESPONSE' });
  });

  it('keeps only official public holidays for the whole country', () => {
    const holidays = parseHolidays([
      holiday('2027-12-25', 'Christmas Day'),
      holiday('2027-08-15', 'Assumption Day', { nationalHoliday: undefined }),
      holiday('2027-06-24', 'Saint John', { nationalHoliday: false, subdivisionCodes: ['IT-TO'] }),
      holiday('2027-12-24', 'Christmas Eve', { holidayTypes: ['Observance'] }),
      holiday('2027-08-14', 'Bank day', { holidayTypes: ['Bank'] }),
      holiday('2027-05-01', 'Labour Day', { holidayTypes: ['Public', 'Bank'] }),
      holiday('2027-03-01', 'Regional, no flag', { nationalHoliday: undefined, subdivisionCodes: ['IT-21'] })
    ], 'IT', 2027);
    assert.deepEqual(holidays, [
      { date: '2027-05-01', name: 'Labour Day' },
      { date: '2027-08-15', name: 'Assumption Day' },
      { date: '2027-12-25', name: 'Christmas Day' }
    ]);
  });

  it('drops records for another year or country, impossible dates, and missing names', () => {
    const holidays = parseHolidays([
      holiday('2026-12-25', 'Last year'),
      holiday('2027-02-30', 'Not a date'),
      holiday('2027-01-06', 'Elsewhere', { countryCode: 'FR' }),
      holiday('2027-01-06', ''),
      holiday('2027-01-06', 'Epiphany', { countryCode: undefined })
    ], 'IT', 2027);
    assert.deepEqual(holidays, [{ date: '2027-01-06', name: 'Epiphany' }]);
  });

  it('accepts an empty holiday list, and rejects one that is not a list', () => {
    assert.deepEqual(parseHolidays([], 'IT', 2027), []);
    assert.throws(() => parseHolidays({ title: 'Not Found' }, 'IT', 2027), HolidayApiError);
  });

  it('reports unsuccessful responses with their HTTP status', async () => {
    const { fetch } = fakeFetch({ title: 'Not Found' }, { status: 404 });
    await assert.rejects(createNagerDateClient({ fetch }).fetchHolidays('ZZ', 2027), { code: 'HTTP_ERROR', status: 404 });
  });

  it('reports network errors, responses that are not JSON, and timeouts', async () => {
    const offline = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(createNagerDateClient({ fetch: offline }).fetchCountries(), { code: 'NETWORK_ERROR' });

    const notJson = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
    await assert.rejects(createNagerDateClient({ fetch: notJson }).fetchCountries(), { code: 'MALFORMED_RESPONSE' });

    const hanging = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    await assert.rejects(createNagerDateClient({ fetch: hanging, timeoutMs: 5 }).fetchCountries(), { code: 'TIMEOUT' });
  });

  it('refuses to request an invalid country or year', async () => {
    const { fetch, urls } = fakeFetch([]);
    const client = createNagerDateClient({ fetch });
    await assert.rejects(client.fetchHolidays('', 2027), { code: 'INVALID_REQUEST' });
    await assert.rejects(client.fetchHolidays('IT', 2027.5), { code: 'INVALID_REQUEST' });
    assert.deepEqual(urls, []);
  });

  it('normalizes country codes', () => {
    assert.equal(normalizeCountryCode(' it '), 'IT');
    assert.equal(normalizeCountryCode('ITA'), '');
    assert.equal(normalizeCountryCode(undefined), '');
  });
});
