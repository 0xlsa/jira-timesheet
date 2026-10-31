import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import { createPublicHolidays, RETRY_AFTER_MS } from '../src/holidays/publicHolidays.js';
import { HOLIDAY_ICONS } from '../src/holidays/holidayIcons.js';
import { dateFromKey, formatHolidayWhen, renderNextHolidayBanner } from '../src/ui/nextHolidayBanner.js';
import { createPublicHolidaysSettings } from '../src/ui/publicHolidaysSettings.js';
import { createSettingsStore, normalizeSettings } from '../src/settings/settingsStore.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';
import { getLocalDateKey, getMondayOfWeek } from '../src/worklog/worklogUtils.js';

const NOW = Date.UTC(2026, 9, 30, 12);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const DATA = {
  'IT:2026': [
    { date: '2026-04-06', name: 'Easter Monday' },
    { date: '2026-11-01', name: 'All Saints Day' },
    { date: '2026-12-08', name: 'Immaculate Conception' },
    { date: '2026-12-25', name: 'Christmas Day' },
    { date: '2026-12-26', name: "St. Stephen's Day" }
  ],
  'IT:2027': [{ date: '2027-01-01', name: "New Year's Day" }, { date: '2027-01-06', name: 'Epiphany' }],
  'FR:2026': [{ date: '2026-11-11', name: 'Armistice Day' }, { date: '2026-12-25', name: 'Christmas Day' }],
  // Two holidays on one date, as Nager.Date lists them for some countries.
  'CH:2026': [{ date: '2026-12-25', name: 'Christmas Day' }, { date: '2026-12-25', name: 'Weihnachten' }]
};

/** A cache that records each request; `fail` makes every download fail. */
function fakeCache({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async getHolidays(countryCode, year) {
      calls.push(`${countryCode}:${year}`);
      if (fail) throw new Error('offline');
      return { holidays: DATA[`${countryCode}:${year}`] ?? [], cachedAt: NOW, stale: false };
    }
  };
}

function setup({ cache = fakeCache(), year = 2026 } = {}) {
  let clock = NOW;
  const holidays = createPublicHolidays({ cache, now: () => clock, currentYear: () => year });
  return { holidays, cache, advance: (ms) => { clock += ms; } };
}

/** Configures the feature and waits for today's year to load, as the page does. */
async function loaded(settings, options) {
  const view = setup(options);
  view.holidays.configure(settings);
  await flush();
  return view;
}

describe('Next public holiday - choosing it', () => {
  it('is the first holiday from today, whatever week is displayed', async () => {
    const { holidays } = await loaded({ enabled: true, countryCode: 'IT' });
    assert.deepEqual(holidays.nextHoliday('2026-10-30'), { dateKey: '2026-11-01', icon: HOLIDAY_ICONS.other, label: 'All Saints Day' });
    assert.equal(holidays.nextHoliday('2026-11-02').dateKey, '2026-12-08');
    // Showing other weeks loads their years but doesn't change the next holiday.
    holidays.indicatorsFor(['2025-03-03']);
    await flush();
    assert.equal(holidays.nextHoliday('2026-11-02').dateKey, '2026-12-08');
  });

  it('includes a holiday today', async () => {
    const { holidays } = await loaded({ enabled: true, countryCode: 'IT' });
    assert.deepEqual(holidays.nextHoliday('2026-12-25'), { dateKey: '2026-12-25', icon: HOLIDAY_ICONS.christmas, label: 'Christmas Day' });
  });

  it('crosses into next year once this year has no holiday left, loading it then', async () => {
    const { holidays, cache } = await loaded({ enabled: true, countryCode: 'IT' });
    assert.equal(holidays.nextHoliday('2026-12-20').dateKey, '2026-12-25');
    assert.deepEqual(cache.calls, ['IT:2026'], 'next year isn\'t needed yet');
    assert.equal(holidays.nextHoliday('2026-12-27'), null, 'loading next year');
    await flush();
    assert.deepEqual(holidays.nextHoliday('2026-12-27'), { dateKey: '2027-01-01', icon: HOLIDAY_ICONS.newYear, label: "New Year's Day" });
    assert.deepEqual(cache.calls, ['IT:2026', 'IT:2027']);
  });

  it('shows one holiday per date, with the weekday card\'s icon and names', async () => {
    const { holidays } = await loaded({ enabled: true, countryCode: 'CH' });
    assert.deepEqual(holidays.nextHoliday('2026-12-01'), { dateKey: '2026-12-25', icon: HOLIDAY_ICONS.christmas, label: 'Christmas Day / Weihnachten' });
    assert.deepEqual(holidays.indicatorsFor(['2026-12-25']).get('2026-12-25'), { icon: HOLIDAY_ICONS.christmas, label: 'Christmas Day / Weihnachten' });
  });

  it('follows a change of country', async () => {
    const { holidays } = await loaded({ enabled: true, countryCode: 'IT' });
    assert.equal(holidays.nextHoliday('2026-11-05').label, 'Immaculate Conception');
    holidays.configure({ enabled: true, countryCode: 'FR' });
    assert.equal(holidays.nextHoliday('2026-11-05'), null, 'never the previous country\'s holiday');
    await flush();
    assert.equal(holidays.nextHoliday('2026-11-05').label, 'Armistice Day');
  });

  it('is none while the feature is off or without a country, and downloads nothing', async () => {
    const off = await loaded({ enabled: false, countryCode: 'IT' });
    assert.equal(off.holidays.nextHoliday('2026-10-30'), null);
    const noCountry = await loaded({ enabled: true, countryCode: '' });
    assert.equal(noCountry.holidays.nextHoliday('2026-10-30'), null);
    await flush();
    assert.deepEqual([...off.cache.calls, ...noCountry.cache.calls], []);
  });

  it('is none when there is no holiday left in the data', async () => {
    const { holidays, cache } = await loaded({ enabled: true, countryCode: 'FR' });
    assert.equal(holidays.nextHoliday('2026-12-28'), null);
    await flush();
    assert.equal(holidays.nextHoliday('2026-12-28'), null, 'FR 2027 has no data here');
    assert.deepEqual(cache.calls, ['FR:2026', 'FR:2027'], 'and isn\'t requested again');
  });

  it('is none while the data is unavailable, and retries only after the usual wait', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const { holidays, cache, advance } = await loaded({ enabled: true, countryCode: 'IT' }, { cache: fakeCache({ fail: true }) });
    for (let i = 0; i < 5; i++) assert.equal(holidays.nextHoliday('2026-10-30'), null);
    await flush();
    assert.deepEqual(cache.calls, ['IT:2026'], 'one request, not one per render');
    assert.equal(holidays.nextHoliday('2026-12-27'), null);
    assert.deepEqual(cache.calls, ['IT:2026'], 'next year isn\'t tried while this year is unavailable');
    advance(RETRY_AFTER_MS);
    holidays.nextHoliday('2026-10-30');
    assert.deepEqual(cache.calls, ['IT:2026', 'IT:2026']);
  });
});

describe('Next public holiday - when', () => {
  it('says Today and Tomorrow', () => {
    assert.equal(formatHolidayWhen('2026-12-25', '2026-12-25'), 'Today');
    assert.equal(formatHolidayWhen('2026-12-25', '2026-12-24'), 'Tomorrow');
    assert.equal(formatHolidayWhen('2027-01-01', '2026-12-31'), 'Tomorrow', 'across a year');
    assert.equal(formatHolidayWhen('2028-03-01', '2028-02-29'), 'Tomorrow', 'after a leap day');
    assert.equal(formatHolidayWhen('2026-03-30', '2026-03-29'), 'Tomorrow', 'across a daylight-saving change');
  });

  it('gives the weekday and date otherwise, with the year when it isn\'t this one', () => {
    assert.equal(formatHolidayWhen('2026-12-25', '2026-10-30'), 'Fri, Dec 25');
    assert.equal(formatHolidayWhen('2027-01-01', '2026-12-27'), 'Fri, Jan 1, 2027');
  });
});

describe('Next public holiday - banner', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  it('shows the icon, the name, and when, as one labelled button', () => {
    const banner = h('button', { type: 'button', class: 'next-holiday-banner hidden' });
    renderNextHolidayBanner(banner, { dateKey: '2026-12-25', icon: '🎄', label: 'Christmas Day' }, '2026-10-30');
    assert.equal(banner.classList.contains('hidden'), false);
    assert.equal(banner.querySelector('.next-holiday-icon').textContent, '🎄');
    assert.equal(banner.querySelector('.next-holiday-icon').getAttribute('aria-hidden'), 'true');
    assert.equal(banner.querySelector('.next-holiday-text').textContent, 'Next public holiday: Christmas Day · Fri, Dec 25');
    assert.equal(banner.querySelector('svg'), null, 'no chevron');
    assert.equal(banner.getAttribute('aria-label'), 'Next public holiday: Christmas Day, Fri, Dec 25. Show its week');
    assert.equal(banner.dataset.date, '2026-12-25');
  });

  it('hides, empty and taking no space, when there\'s no holiday to show', () => {
    const banner = h('button', { type: 'button', class: 'next-holiday-banner' });
    renderNextHolidayBanner(banner, { dateKey: '2026-12-25', icon: '🎄', label: 'Christmas Day' }, '2026-12-25');
    assert.match(banner.textContent, /· Today$/);
    renderNextHolidayBanner(banner, null, '2026-12-25');
    assert.equal(banner.classList.contains('hidden'), true);
    assert.equal(banner.textContent, '');
    assert.equal(banner.hasAttribute('data-date'), false);
    assert.equal(banner.hasAttribute('aria-label'), false);
  });

  it('goes to the holiday\'s week, starting on Monday', () => {
    const weekOf = (dateKey) => getLocalDateKey(getMondayOfWeek(dateFromKey(dateKey)));
    assert.equal(weekOf('2026-12-25'), '2026-12-21');
    assert.equal(weekOf('2027-01-01'), '2026-12-28', 'a week across the new year');
    assert.equal(weekOf('2026-11-01'), '2026-10-26', 'a Sunday');
    assert.equal(weekOf('2028-02-29'), '2028-02-28', 'a leap day');
  });
});

describe('Next public holiday - settings', () => {
  const jira = { deploymentType: 'cloud', email: 'a@b.co', baseUrlsByType: { cloud: 'https://acme.atlassian.net', server: '' }, tokensByType: { cloud: 't', server: '' } };

  it('is on for existing users who never set it, keeping their other choices', () => {
    assert.deepEqual(normalizeSettings({ publicHolidaysEnabled: true, publicHolidaysCountry: 'IT' }).publicHolidays,
      { enabled: true, countryCode: 'IT', showNext: true });
    assert.equal(normalizeSettings({}).publicHolidays.showNext, true);
  });

  it('is saved and restored, and kept while the feature is off and when it\'s turned on again', async () => {
    const store = createSettingsStore(createMemoryStorageArea());
    await store.save({ ...jira, publicHolidays: { enabled: true, countryCode: 'IT', showNext: false } });
    assert.deepEqual((await store.load()).publicHolidays, { enabled: true, countryCode: 'IT', showNext: false });
    await store.save({ ...jira, publicHolidays: { enabled: false, countryCode: 'IT', showNext: false } });
    assert.deepEqual((await store.load()).publicHolidays, { enabled: false, countryCode: 'IT', showNext: false });
    await store.save({ ...jira, publicHolidays: { enabled: true, countryCode: 'IT', showNext: false } });
    assert.equal((await store.load()).publicHolidays.showNext, false, 'still off');
    // Saved without it (or without the section), it stays as it was.
    await store.save({ ...jira, publicHolidays: { enabled: true, countryCode: 'IT' } });
    await store.save(jira);
    assert.equal((await store.load()).publicHolidays.showNext, false);
  });

  it('saves the Public Holidays settings on their own, keeping everything else', async () => {
    const store = createSettingsStore(createMemoryStorageArea());
    await store.save({ ...jira, publicHolidays: { enabled: true, countryCode: 'IT', showNext: true } });
    const before = await store.load();
    await store.savePublicHolidays({ enabled: false, countryCode: 'IT', showNext: true });
    const after = await store.load();
    assert.deepEqual(after.publicHolidays, { enabled: false, countryCode: 'IT', showNext: true });
    assert.deepEqual({ ...after, publicHolidays: null }, { ...before, publicHolidays: null });
    await store.savePublicHolidays({ enabled: true, countryCode: 'FR', showNext: false });
    assert.deepEqual((await store.load()).publicHolidays, { enabled: true, countryCode: 'FR', showNext: false });
  });

  it('can be saved on its own, keeping everything else', async () => {
    const store = createSettingsStore(createMemoryStorageArea());
    await store.save({ ...jira, publicHolidays: { enabled: true, countryCode: 'IT', showNext: true } });
    const before = await store.load();
    await store.saveShowNextHoliday(false);
    const after = await store.load();
    assert.deepEqual(after.publicHolidays, { enabled: true, countryCode: 'IT', showNext: false });
    assert.deepEqual({ ...after, publicHolidays: null }, { ...before, publicHolidays: null });
    await store.saveShowNextHoliday(true);
    assert.equal((await store.load()).publicHolidays.showNext, true);
  });

  it('is independent of the weekday card indicators', async () => {
    const { holidays } = await loaded({ enabled: true, countryCode: 'IT' });
    const settings = normalizeSettings({ publicHolidaysEnabled: true, publicHolidaysCountry: 'IT', publicHolidaysShowNext: false });
    assert.equal(settings.publicHolidays.enabled, true, 'indicators still on');
    assert.equal(holidays.indicatorsFor(['2026-12-25']).size, 1);
    assert.equal(settings.publicHolidays.showNext, false, 'banner off');
  });

  it('means no banner without a country', () => {
    const settings = normalizeSettings({ publicHolidaysEnabled: true, publicHolidaysShowNext: true });
    assert.deepEqual(settings.publicHolidays, { enabled: false, countryCode: '', showNext: true });
  });

  describe('switch', () => {
    let restoreDocument;
    beforeEach(() => { restoreDocument = installFakeDocument(); });
    afterEach(() => restoreDocument());

    function setupSection() {
      const changes = [];
      const applied = [];
      const elements = {
        toggle: h('input', { type: 'checkbox', role: 'switch' }),
        select: h('select'),
        status: h('div', { class: 'field-hint hidden' }),
        error: h('div', { class: 'field-error' }),
        showNext: h('input', { type: 'checkbox', role: 'switch' })
      };
      const cache = { async getCountries() { return { countries: [{ countryCode: 'IT', name: 'Italy' }] }; }, async peekCountries() { return [{ countryCode: 'IT', name: 'Italy' }]; } };
      const section = createPublicHolidaysSettings(elements, cache, {
        onChange: (value) => applied.push(value),
        onShowNextChange: (value) => changes.push(value)
      });
      const turn = (on) => {
        elements.toggle.checked = on;
        elements.toggle.dispatchEvent({ type: 'change' });
      };
      const flip = (on) => {
        elements.showNext.checked = on;
        elements.showNext.dispatchEvent({ type: 'change' });
      };
      const choose = (code) => {
        elements.select.value = code;
        elements.select.dispatchEvent({ type: 'change' });
      };
      return { ...elements, section, turn, flip, choose, changes, applied };
    }

    it('applies turning the feature off and on at once, without Save Settings', async () => {
      const page = setupSection();
      await page.section.fill({ enabled: true, countryCode: 'IT', showNext: false });
      page.turn(false);
      assert.deepEqual(page.applied, [{ enabled: false, countryCode: 'IT', showNext: false }]);
      page.turn(true);
      assert.deepEqual(page.applied[1], { enabled: true, countryCode: 'IT', showNext: false }, 'with the saved country');
      assert.equal(page.error.textContent, '');
    });

    it('waits for a country before applying the feature turned on, without showing an error', async () => {
      const page = setupSection();
      await page.section.fill({ enabled: false, countryCode: '', showNext: true });
      page.turn(true);
      await flush();
      assert.deepEqual(page.applied, [], 'nothing saved without a country');
      assert.equal(page.error.textContent, '', 'the error waits for Save Settings');
      page.choose('IT');
      assert.deepEqual(page.applied, [{ enabled: true, countryCode: 'IT', showNext: true }]);
      // Save Settings still checks the section, and saves the same.
      assert.deepEqual(page.section.validate(), { isValid: true, value: { enabled: true, countryCode: 'IT', showNext: true } });
    });

    it('applies a change of country at once', async () => {
      const page = setupSection();
      await page.section.fill({ enabled: true, countryCode: '', showNext: true });
      await flush();
      page.choose('IT');
      page.choose('');
      assert.deepEqual(page.applied, [{ enabled: true, countryCode: 'IT', showNext: true }], 'no country while on isn\'t applied');
    });

    it('applies as soon as it changes, without Save Settings', async () => {
      const page = setupSection();
      await page.section.fill({ enabled: true, countryCode: 'IT', showNext: true });
      page.flip(false);
      page.flip(true);
      page.flip(false);
      assert.deepEqual(page.changes, [false, true, false]);
      // Filling the form (opening Settings) or turning the feature off doesn't count as a change.
      await page.section.fill({ enabled: true, countryCode: 'IT', showNext: true });
      page.turn(false);
      assert.deepEqual(page.changes, [false, true, false]);
    });

    it('shows the saved value, and can only be changed while the feature is on', async () => {
      const page = setupSection();
      await page.section.fill({ enabled: false, countryCode: 'IT', showNext: false });
      assert.equal(page.showNext.checked, false);
      assert.equal(page.showNext.disabled, true);
      page.turn(true);
      assert.equal(page.showNext.disabled, false);
      assert.equal(page.showNext.checked, false, 'the saved choice comes back');
      page.showNext.checked = true;
      page.turn(false);
      assert.equal(page.showNext.disabled, true);
      assert.equal(page.showNext.checked, true, 'kept while the feature is off');
    });

    it('saves its value with the section, apart from the feature switch', async () => {
      const page = setupSection();
      await page.section.fill({ enabled: true, countryCode: 'IT', showNext: true });
      page.showNext.checked = false;
      page.select.value = 'IT';
      assert.deepEqual(page.section.validate(), { isValid: true, value: { enabled: true, countryCode: 'IT', showNext: false } });
      page.turn(false);
      assert.deepEqual(page.section.validate(), { isValid: true, value: { enabled: false, countryCode: 'IT', showNext: false } });
    });

    it('defaults to on when nothing is saved', async () => {
      const page = setupSection();
      await page.section.fill(normalizeSettings({}).publicHolidays);
      assert.equal(page.showNext.checked, true);
    });
  });
});

describe('Next public holiday - page', () => {
  const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  const options = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
  const fn = (name) => {
    const start = options.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    return options.slice(start, options.indexOf('\n}\n', start));
  };

  it('puts the banner between the week navigation bar and the weekday cards', () => {
    const order = ['class="stats-grid"', 'class="week-nav-bar"', 'id="nextHolidayBanner"', 'id="daysContainer"'].map((m) => html.indexOf(m));
    assert.ok(order.every((i) => i > 0));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(html, /<button type="button" id="nextHolidayBanner" class="next-holiday-banner hidden"><\/button>/);
  });

  it('adds the switch to Public Holidays, before the Nager.Date credit, with About still last', () => {
    const fieldset = html.slice(html.indexOf('<fieldset class="form-group holidays-group">'), html.indexOf('</fieldset>', html.indexOf('holidays-group')));
    const at = (m) => fieldset.indexOf(m);
    assert.ok(at('id="publicHolidaysEnabled"') < at('id="publicHolidaysCountry"'));
    assert.ok(at('id="publicHolidaysCountry"') < at('id="publicHolidaysShowNext"'));
    assert.ok(at('id="publicHolidaysShowNext"') < at('id="publicHolidaysHint"'));
    assert.match(fieldset, /<span>Show Next Public Holiday<\/span>/);
    assert.match(fieldset, /Display the next upcoming public holiday on the dashboard\./);
    assert.match(fieldset, /id="publicHolidaysShowNext" class="switch-input" role="switch"\s+aria-describedby="publicHolidaysShowNextHint"/);
    assert.match(fieldset, /Official public holidays provided by <a href="https:\/\/nagerholidays\.com\/api"/);
    const about = html.indexOf('id="aboutSection"');
    assert.ok(about > html.indexOf('</form>'));
    assert.match(html.slice(about), /^id="aboutSection"[^>]*><\/section>\s*<\/div>\s*<\/div>\s*<\/aside>/);
  });

  it('shows the next holiday from today, only with both switches on', () => {
    const show = fn('showNextHoliday');
    assert.match(show, /const todayKey = getLocalDateKey\(new Date\(\)\);/);
    assert.match(show, /savedSettings\?\.publicHolidays\.showNext \? publicHolidays\.nextHoliday\(todayKey\) : null/);
    assert.doesNotMatch(show, /currentMonday|selectedDateKey/);
    // Whenever the holidays or their settings change (configure() calls onChange too).
    const onChange = options.slice(options.indexOf('const publicHolidays = createPublicHolidays({'), options.indexOf('const publicHolidaysSettings'));
    assert.match(onChange, /showNextHoliday\(\);/);
  });

  it('saves the Public Holidays section as it changes, then updates the weekday cards and the banner', () => {
    const start = options.indexOf('async onChange(values) {');
    assert.ok(start > 0);
    const handler = options.slice(start, options.indexOf('\n  },\n', start));
    assert.match(handler, /await settingsStore\.savePublicHolidays\(values\);\s*savedSettings = await settingsStore\.load\(\);/);
    assert.match(handler, /publicHolidays\.configure\(savedSettings\.publicHolidays\);/);
  });

  it('saves the switch as it changes, then updates the banner', () => {
    const start = options.indexOf('async onShowNextChange(showNext) {');
    assert.ok(start > 0);
    const handler = options.slice(start, options.indexOf('\n  }\n', start));
    assert.match(handler, /await settingsStore\.saveShowNextHoliday\(showNext\);\s*savedSettings = await settingsStore\.load\(\);/);
    assert.ok(handler.indexOf('showNextHoliday();') > handler.indexOf('savedSettings = await settingsStore.load();'));
  });

  it('goes to the holiday\'s week, with the holiday selected, closing the week picker', () => {
    const start = options.indexOf("nextHolidayBanner.addEventListener('click'");
    const click = options.slice(start, options.indexOf('\n});', start));
    assert.match(click, /weekPicker\.close\(\);\s*currentMonday = getMondayOfWeek\(dateFromKey\(date\)\);\s*selectedDateKey = date;\s*loadAndRenderWorklogs\(\);/);
    assert.doesNotMatch(click, /closeSettings|timer|settingsStore|force/);
    assert.match(fn('setWorklogBusy'), /nextHolidayBanner\.disabled = isBusy;/);
  });
});
