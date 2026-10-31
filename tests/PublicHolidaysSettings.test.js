import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import {
  createPublicHolidaysSettings, validatePublicHolidays,
  SELECT_COUNTRY_LABEL, COUNTRY_REQUIRED_MESSAGE, UNKNOWN_COUNTRY_MESSAGE, COUNTRIES_UNAVAILABLE_MESSAGE
} from '../src/ui/publicHolidaysSettings.js';
import { createSettingsStore, normalizeSettings } from '../src/settings/settingsStore.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';

const COUNTRIES = [{ countryCode: 'AT', name: 'Austria' }, { countryCode: 'IT', name: 'Italy' }];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** The cache as the section uses it: the list (download or cache) and a peek at what's cached. */
function fakeCache({ cached = null, countries = COUNTRIES, fail = false } = {}) {
  const cache = {
    calls: [],
    holidayCalls: [],
    fail,
    async getCountries() {
      cache.calls.push('getCountries');
      if (cache.fail) throw new Error('offline');
      return { countries, cachedAt: 0, stale: false };
    },
    async peekCountries() { return cached; },
    async getHolidays(...args) { cache.holidayCalls.push(args); return { holidays: [] }; }
  };
  return cache;
}

describe('Public Holidays settings', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  function setup(cache = fakeCache()) {
    const elements = {
      toggle: h('input', { type: 'checkbox', role: 'switch' }),
      select: h('select'),
      status: h('div', { class: 'field-hint hidden' }),
      error: h('div', { class: 'field-error' })
    };
    elements.toggle.checked = false;
    const section = createPublicHolidaysSettings(elements, cache);
    const turn = (on) => {
      elements.toggle.checked = on;
      elements.toggle.dispatchEvent({ type: 'change' });
    };
    const choose = (code) => {
      elements.select.value = code;
      elements.select.dispatchEvent({ type: 'change' });
    };
    const options = () => elements.select.querySelectorAll('option').map((o) => [o.getAttribute('value'), o.textContent]);
    return { ...elements, section, cache, turn, choose, options };
  }

  it('selects no country on a new installation, and starts with "Select a country…"', async () => {
    const page = setup();
    await page.section.fill(normalizeSettings({}).publicHolidays);
    assert.equal(page.toggle.checked, false);
    assert.equal(page.select.value, '');
    assert.deepEqual(page.options()[0], ['', SELECT_COUNTRY_LABEL]);
    assert.equal(SELECT_COUNTRY_LABEL, 'Select a country…');
    assert.equal(page.select.disabled, true);
    assert.deepEqual(page.cache.calls, [], 'nothing is downloaded while the feature is off');
  });

  it('never infers a country from the browser or system locale', async (t) => {
    // An Italian browser and system: Italy is in the list, and still not selected.
    t.mock.method(Intl.DateTimeFormat.prototype, 'resolvedOptions', () => ({ locale: 'it-IT', timeZone: 'Europe/Rome' }));
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'it-IT', languages: ['it-IT', 'it'] } });
    t.after(() => (descriptor ? Object.defineProperty(globalThis, 'navigator', descriptor) : delete globalThis.navigator));

    const page = setup();
    await page.section.fill({ enabled: false, countryCode: '' });
    page.turn(true);
    await flush();
    assert.deepEqual(page.options(), [['', SELECT_COUNTRY_LABEL], ['AT', 'Austria'], ['IT', 'Italy']]);
    assert.equal(page.select.value, '');

    for (const file of ['../src/ui/publicHolidaysSettings.js', '../src/holidays/publicHolidays.js', '../src/holidays/holidayCache.js', '../src/holidays/nagerDateClient.js', '../src/settings/settingsStore.js']) {
      assert.doesNotMatch(read(file), /navigator\.(language|languages|geolocation)|resolvedOptions|timeZone|geoip|ipapi/i, file);
    }
  });

  it('downloads the country list when the feature is turned on, and enables the list', async () => {
    const page = setup();
    await page.section.fill({ enabled: false, countryCode: '' });
    page.turn(true);
    assert.equal(page.status.textContent, 'Loading countries…');
    await flush();
    assert.deepEqual(page.cache.calls, ['getCountries']);
    assert.equal(page.select.disabled, false);
    assert.ok(page.status.classList.contains('hidden'));
  });

  it('refuses to turn the feature on without a country, with a clear message', async () => {
    const page = setup();
    await page.section.fill({ enabled: false, countryCode: '' });
    page.turn(true);
    await flush();

    const result = page.section.validate();
    assert.equal(result.isValid, false);
    assert.equal(page.error.textContent, COUNTRY_REQUIRED_MESSAGE);
    assert.match(COUNTRY_REQUIRED_MESSAGE, /select a country before turning on Public Holidays/i);
    assert.ok(page.error.classList.contains('visible'));
    assert.ok(page.select.classList.contains('is-invalid'));
    assert.deepEqual(page.cache.holidayCalls, [], 'no holidays are downloaded');

    // Choosing a country clears the error, and the settings can be saved.
    page.choose('IT');
    assert.equal(page.error.textContent, '');
    assert.deepEqual(page.section.validate(), { isValid: true, value: { enabled: true, countryCode: 'IT', showNext: true } });
  });

  it('does not require a country while the feature is off', async () => {
    const page = setup();
    await page.section.fill({ enabled: false, countryCode: '' });
    assert.deepEqual(page.section.validate(), { isValid: true, value: { enabled: false, countryCode: '', showNext: true } });
  });

  it('restores the saved country, and keeps it when the feature is off', async () => {
    const page = setup(fakeCache({ cached: COUNTRIES }));
    await page.section.fill({ enabled: true, countryCode: 'IT' });
    assert.equal(page.toggle.checked, true);
    assert.equal(page.select.value, 'IT');

    const off = setup(fakeCache({ cached: COUNTRIES }));
    await off.section.fill({ enabled: false, countryCode: 'IT' });
    assert.equal(off.select.value, 'IT');
    assert.deepEqual(off.section.validate(), { isValid: true, value: { enabled: false, countryCode: 'IT', showNext: true } });
    assert.deepEqual(off.cache.calls, []);
  });

  it('only accepts a country from the supported list', async () => {
    const page = setup();
    await page.section.fill({ enabled: false, countryCode: '' });
    page.turn(true);
    await flush();
    page.select.value = 'ZZ';
    assert.deepEqual(page.section.validate(), { isValid: false, error: UNKNOWN_COUNTRY_MESSAGE });
    assert.deepEqual(validatePublicHolidays({ enabled: true, countryCode: 'ZZ' }, { countries: COUNTRIES }), { isValid: false, error: UNKNOWN_COUNTRY_MESSAGE });
  });

  it('shows an error with a retry when no country list is available, and selects nothing', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const cache = fakeCache({ fail: true });
    const page = setup(cache);
    await page.section.fill({ enabled: false, countryCode: '' });
    page.turn(true);
    await flush();

    assert.match(page.status.textContent, new RegExp(COUNTRIES_UNAVAILABLE_MESSAGE.slice(0, 30)));
    assert.deepEqual(page.options(), [['', SELECT_COUNTRY_LABEL]]);
    assert.equal(page.select.value, '');
    assert.equal(page.section.validate().isValid, false);

    cache.fail = false;
    page.status.querySelector('[data-action="retry-countries"]').click();
    await flush();
    assert.deepEqual(cache.calls, ['getCountries', 'getCountries']);
    assert.equal(page.options().length, 3);
    assert.equal(page.select.value, '');
  });

  it('keeps the saved country selectable while the list is unavailable', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const page = setup(fakeCache({ fail: true }));
    await page.section.fill({ enabled: true, countryCode: 'IT' });
    assert.equal(page.select.value, 'IT');
    assert.deepEqual(page.section.validate(), { isValid: true, value: { enabled: true, countryCode: 'IT', showNext: true } });
  });
});

describe('Public Holidays settings - storage', () => {
  it('stores the switch and the selected country with the other settings', async () => {
    const storage = createMemoryStorageArea();
    const store = createSettingsStore(storage);
    const jira = { deploymentType: 'cloud', email: 'a@b.co', baseUrlsByType: { cloud: 'https://acme.atlassian.net', server: '' }, tokensByType: { cloud: 't', server: '' } };

    assert.deepEqual((await store.load()).publicHolidays, { enabled: false, countryCode: '', showNext: true });

    await store.save({ ...jira, publicHolidays: { enabled: true, countryCode: 'IT' } });
    assert.deepEqual((await store.load()).publicHolidays, { enabled: true, countryCode: 'IT', showNext: true });

    // A new country replaces the old one; turning the feature off keeps it.
    await store.save({ ...jira, publicHolidays: { enabled: true, countryCode: 'AT' } });
    await store.save({ ...jira, publicHolidays: { enabled: false, countryCode: 'AT' } });
    assert.deepEqual((await store.load()).publicHolidays, { enabled: false, countryCode: 'AT', showNext: true });

    // Saving without them leaves them as they are.
    await store.save(jira);
    assert.deepEqual((await store.load()).publicHolidays, { enabled: false, countryCode: 'AT', showNext: true });
  });

  it('reads the feature as off when no valid country is stored', () => {
    assert.deepEqual(normalizeSettings({ publicHolidaysEnabled: true }).publicHolidays, { enabled: false, countryCode: '', showNext: true });
    assert.deepEqual(normalizeSettings({ publicHolidaysEnabled: true, publicHolidaysCountry: 'Italy' }).publicHolidays, { enabled: false, countryCode: '', showNext: true });
    assert.deepEqual(normalizeSettings({ publicHolidaysEnabled: 'yes', publicHolidaysCountry: 'it' }).publicHolidays, { enabled: false, countryCode: 'IT', showNext: true });
  });

  it('saves nothing and loads no holidays when the section is invalid (options.js)', () => {
    const source = read('../options.js');
    const save = source.slice(source.indexOf('async function onSaveSettings'), source.indexOf('function setBusy'));
    const check = save.indexOf('!holidaysValidation.isValid');
    assert.ok(check > 0, 'the save checks the section');
    assert.ok(check < save.indexOf('requestSiteAccess(') && check < save.indexOf('settingsStore.save('), 'before asking for access or saving');
    assert.ok(save.indexOf('settingsStore.save(') < save.indexOf('publicHolidays.configure('), 'holidays load only after a successful save');
    assert.match(save, /publicHolidays: publicHolidaysValues/);
  });
});

describe('Settings page structure', () => {
  const html = read('../options.html');
  const drawer = html.slice(html.indexOf('<aside id="settingsDrawer"'), html.indexOf('</aside>', html.indexOf('<aside id="settingsDrawer"')));

  it('puts Public Holidays in the settings form, after Jira Connection (and its actions) and before About', () => {
    const holidays = drawer.indexOf('id="publicHolidaysEnabled"');
    assert.ok(holidays > drawer.indexOf('<form id="settingsForm"'));
    assert.ok(holidays < drawer.indexOf('</form>'), 'in the form, so Save Settings saves it');
    assert.ok(holidays > drawer.indexOf('id="saveSettingsBtn"'));
    assert.ok(holidays < drawer.indexOf('id="aboutSection"'));
    assert.match(drawer, /<select id="publicHolidaysCountry"[^>]*>\s*<option value="">Select a country…<\/option>\s*<\/select>/);
    assert.doesNotMatch(drawer, /<option value="[A-Z]{2}"[^>]*selected/i, 'no country is preselected');
  });

  it('keeps About as the last section of Settings, once', () => {
    assert.equal(html.match(/id="aboutSection"/g).length, 1);
    // Nothing but the closing tags of the scroll area and the drawer after it.
    const afterAbout = drawer.slice(drawer.indexOf('<section id="aboutSection"'));
    assert.match(afterAbout, /^<section id="aboutSection" class="settings-about" aria-labelledby="aboutTitle"><\/section>\s*<\/div>\s*<\/div>\s*$/);
    // Validation messages live inside their fields, before About.
    for (const id of ['urlError', 'emailError', 'tokenError', 'publicHolidaysError', 'publicHolidaysStatus', 'statusArea']) {
      assert.ok(drawer.indexOf(`id="${id}"`) < drawer.indexOf('id="aboutSection"'), id);
    }
  });

  it('keeps the About content: attribution, links, and the version from the manifest', () => {
    const js = read('../options.js');
    assert.match(js, /renderAboutSection\(document\.getElementById\('aboutSection'\), \{ manifest: platform\.getManifest\(\), info \}\)/);
    const about = read('../src/ui/aboutSection.js');
    assert.match(about, /View source on GitHub/);
    assert.match(about, /Developed by /);
  });
});
