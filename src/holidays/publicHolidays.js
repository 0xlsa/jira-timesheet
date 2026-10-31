/**
 * Public holidays for the weekly timesheet: which datasets to load, and the indicators to show.
 *
 * Nothing is requested while the feature is off or no country is selected. Turning it on (or
 * changing the country) loads the current calendar year; after that, only the years of the weeks
 * displayed are loaded, when they're displayed. Data is kept by country, and indicators are only
 * ever built from the selected country's data, so a download that finishes after the country
 * changed or the feature was turned off never shows. It still fills the cache.
 *
 * The next holiday (for the dashboard banner) comes from the same data, counted from today, not
 * the week displayed: today's year, which is loaded anyway, and the next year only once today's
 * has no holiday left.
 *
 * A dataset that couldn't be loaded (or only as an expired copy) is tried again at the next
 * display after RETRY_AFTER_MS, or when the settings are next applied; never in a loop.
 * No DOM; the cache and the clock are injected.
 */

import { buildHolidayIndicators } from './holidayIcons.js';

export const RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * @param {object} options
 * @param {{ getHolidays: Function }} options.cache - From createHolidayCache()
 * @param {() => number} [options.now=Date.now] - Epoch milliseconds
 * @param {() => number} [options.currentYear] - The calendar year today (system date)
 * @param {() => void} [options.onChange] - Called when the selected country's indicators change
 */
export function createPublicHolidays({ cache, now = Date.now, currentYear = () => new Date(now()).getFullYear(), onChange = () => {} }) {
  let config = { enabled: false, countryCode: '' };
  // By `${countryCode}:${year}`: { loading, indicators (Map or null), retryAt }
  const datasets = new Map();

  const isActive = () => config.enabled && Boolean(config.countryCode);

  function request(countryCode, year) {
    const key = `${countryCode}:${year}`;
    const entry = datasets.get(key);
    if (entry && (entry.loading || now() < entry.retryAt)) return;

    // What's already shown stays shown while it's refreshed.
    datasets.set(key, { loading: true, indicators: entry?.indicators ?? null, retryAt: Infinity });
    cache.getHolidays(countryCode, year).then(
      ({ holidays, stale }) => {
        datasets.set(key, { loading: false, indicators: buildHolidayIndicators(holidays), retryAt: stale ? now() + RETRY_AFTER_MS : Infinity });
      },
      (err) => {
        console.warn(`Public holidays for ${countryCode} ${year} are unavailable:`, err);
        datasets.set(key, { loading: false, indicators: entry?.indicators ?? null, retryAt: now() + RETRY_AFTER_MS });
      }
    ).then(() => {
      if (isActive() && config.countryCode === countryCode) onChange();
    });
  }

  return {
    /**
     * Applies saved settings. When the feature is on, loads the current year's holidays at once,
     * whatever week is displayed.
     *
     * @param {{ enabled: boolean, countryCode: string }} settings
     */
    configure({ enabled, countryCode }) {
      config = { enabled: Boolean(enabled), countryCode: countryCode || '' };
      if (isActive()) {
        // Saving the settings is the next chance to retry what failed.
        for (const [key, entry] of datasets) {
          if (key.startsWith(`${config.countryCode}:`) && !entry.loading && entry.retryAt !== Infinity) entry.retryAt = 0;
        }
        request(config.countryCode, currentYear());
      }
      onChange();
    },

    /**
     * Indicators for the given dates, from what's loaded now; loads the years they fall in when
     * needed (a week can span two years). Empty while the feature is off.
     *
     * @param {string[]} dateKeys - YYYY-MM-DD
     * @returns {Map<string, { icon: string, label: string }>}
     */
    indicatorsFor(dateKeys) {
      const result = new Map();
      if (!isActive()) return result;
      const { countryCode } = config;
      const years = [...new Set(dateKeys.map((key) => Number(key.slice(0, 4))).filter(Number.isInteger))];
      for (const year of years) {
        request(countryCode, year);
        const indicators = datasets.get(`${countryCode}:${year}`)?.indicators;
        if (!indicators) continue;
        for (const key of dateKeys) {
          if (indicators.has(key)) result.set(key, indicators.get(key));
        }
      }
      return result;
    },

    /**
     * The first holiday on or after `todayKey`, from what's loaded now: one per date, with the
     * same icon and name as its weekday card. Null while the feature is off, while the data it
     * needs is loading or unavailable, and when there's none. Loads today's year when needed, and
     * the next year only when today's has no holiday left.
     *
     * @param {string} todayKey - YYYY-MM-DD, today's local date
     * @returns {{ dateKey: string, icon: string, label: string } | null}
     */
    nextHoliday(todayKey) {
      if (!isActive()) return null;
      const { countryCode } = config;
      const year = Number(todayKey.slice(0, 4));
      for (const candidate of [year, year + 1]) {
        request(countryCode, candidate);
        const indicators = datasets.get(`${countryCode}:${candidate}`)?.indicators;
        if (!indicators) return null;
        const next = [...indicators.keys()].filter((key) => key >= todayKey).sort()[0];
        if (next) return { dateKey: next, ...indicators.get(next) };
      }
      return null;
    }
  };
}
