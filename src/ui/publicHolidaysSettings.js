/**
 * The Public Holidays section of the Connection Settings form: an on/off switch, a country list,
 * and the Show Next Public Holiday switch (the dashboard banner). The banner switch can only be
 * changed while the feature is on, and keeps its value while it's off.
 *
 * Everything applies as soon as it changes, without Save Settings (which saves it too): the
 * feature switch and the country through `onChange`, once they're valid, and the banner switch on
 * its own through `onShowNextChange`. Turning the feature on before a country is chosen saves
 * nothing until one is.
 *
 * The country is only ever the one the user picks: nothing is preselected or guessed (no browser
 * or system locale, no location). The list comes from Nager.Date through the holiday cache, and
 * is downloaded only once the switch is on; until then the section shows the saved country, if
 * any, from what's cached. Saving with the switch on and no country fails validation, so nothing
 * is saved and no holidays are downloaded.
 */

import { h } from './dom.js';
import { normalizeCountryCode } from '../holidays/nagerDateClient.js';

export const SELECT_COUNTRY_LABEL = 'Select a country…';
export const COUNTRY_REQUIRED_MESSAGE = 'Select a country before turning on Public Holidays. Your settings were not saved.';
export const UNKNOWN_COUNTRY_MESSAGE = 'Select a country from the list.';
export const COUNTRIES_UNAVAILABLE_MESSAGE = "Couldn't load the list of countries from Nager.Date. Check your connection and try again.";

/**
 * Checks the section's values before saving.
 *
 * @param {{ enabled: boolean, countryCode: string, showNext?: boolean }} values
 * @param {object} context
 * @param {Array<{ countryCode: string }> | null} context.countries - The supported countries, when known
 * @param {string} [context.savedCountryCode] - Accepted while the list is unavailable: it was
 *   checked against the list when it was saved
 * @returns {{ isValid: true, value: { enabled: boolean, countryCode: string, showNext: boolean } } | { isValid: false, error: string }}
 */
export function validatePublicHolidays({ enabled, countryCode, showNext = true }, { countries, savedCountryCode = '' }) {
  const code = normalizeCountryCode(countryCode);
  if (code && code !== savedCountryCode && !countries?.some((country) => country.countryCode === code)) {
    return { isValid: false, error: UNKNOWN_COUNTRY_MESSAGE };
  }
  if (enabled && !code) return { isValid: false, error: COUNTRY_REQUIRED_MESSAGE };
  return { isValid: true, value: { enabled: Boolean(enabled), countryCode: code, showNext: Boolean(showNext) } };
}

/**
 * @param {object} elements
 * @param {HTMLInputElement} elements.toggle - Checkbox (role="switch")
 * @param {HTMLSelectElement} elements.select
 * @param {HTMLElement} elements.status - Loading and download errors, with a Retry button
 * @param {HTMLElement} elements.error - Validation errors (`.field-error`)
 * @param {HTMLInputElement} [elements.showNext] - Show Next Public Holiday checkbox (role="switch")
 * @param {{ getCountries: Function, peekCountries: Function }} cache - From createHolidayCache()
 * @param {object} [options]
 * @param {(value: { enabled: boolean, countryCode: string, showNext: boolean }) => void} [options.onChange] -
 *   Called when the feature switch or the country changes to a valid value
 * @param {(showNext: boolean) => void} [options.onShowNextChange] - Called when the banner switch changes
 */
export function createPublicHolidaysSettings({ toggle, select, status, error, showNext }, cache, { onChange = () => {}, onShowNextChange = () => {} } = {}) {
  let countries = null;
  let saved = { enabled: false, countryCode: '', showNext: true };
  // Bumped by fill(), so a list arriving for an earlier visit doesn't change this one.
  let visit = 0;

  function renderOptions(list, selectedCode) {
    // A saved country stays selectable while the list is unavailable.
    const options = list ?? (selectedCode ? [{ countryCode: selectedCode, name: selectedCode }] : []);
    select.replaceChildren(
      h('option', { value: '' }, SELECT_COUNTRY_LABEL),
      ...options.map(({ countryCode, name }) => h('option', { value: countryCode }, name))
    );
    select.value = options.some((option) => option.countryCode === selectedCode) ? selectedCode : '';
  }

  function updateEnabled() {
    select.disabled = !toggle.checked;
    if (showNext) showNext.disabled = !toggle.checked;
  }

  function showStatus(message, { retry = false } = {}) {
    status.replaceChildren(...[
      message,
      retry && ' ',
      retry && h('button', { type: 'button', class: 'holidays-retry-btn', 'data-action': 'retry-countries' }, 'Try again')
    ].filter(Boolean));
    status.classList.toggle('hidden', !message);
  }

  function clearError() {
    error.textContent = '';
    error.classList.remove('visible');
    select.classList.remove('is-invalid');
  }

  async function loadCountries() {
    const thisVisit = visit;
    if (countries) return;
    showStatus('Loading countries…');
    try {
      const result = await cache.getCountries();
      if (thisVisit !== visit) return;
      countries = result.countries;
      renderOptions(countries, select.value || saved.countryCode);
      showStatus('');
    } catch (err) {
      if (thisVisit !== visit) return;
      console.warn('Could not load the public holiday countries:', err);
      showStatus(COUNTRIES_UNAVAILABLE_MESSAGE, { retry: true });
    }
  }

  /** Applies the feature switch and the country once they're valid (on needs a country), quietly. */
  function applyChange() {
    const result = validatePublicHolidays(
      { enabled: toggle.checked, countryCode: select.value, showNext: showNext ? showNext.checked : saved.showNext },
      { countries, savedCountryCode: saved.countryCode });
    if (!result.isValid) return;
    saved = { ...result.value };
    onChange(result.value);
  }

  toggle.addEventListener('change', () => {
    clearError();
    updateEnabled();
    if (toggle.checked) loadCountries();
    applyChange();
  });
  select.addEventListener('change', () => {
    clearError();
    applyChange();
  });
  showNext?.addEventListener('change', () => {
    saved = { ...saved, showNext: showNext.checked };
    onShowNextChange(showNext.checked);
  });
  status.addEventListener('click', (event) => {
    if (event.target?.closest?.('[data-action="retry-countries"]')) loadCountries();
  });

  return {
    /**
     * Shows the saved settings, discarding unsaved changes. Downloads the country list only when
     * the feature is on (and the list isn't cached).
     *
     * @param {{ enabled: boolean, countryCode: string, showNext?: boolean }} settings
     */
    async fill(settings) {
      visit++;
      saved = { enabled: settings.enabled, countryCode: settings.countryCode, showNext: settings.showNext !== false };
      toggle.checked = saved.enabled;
      if (showNext) showNext.checked = saved.showNext;
      clearError();
      showStatus('');
      updateEnabled();
      const thisVisit = visit;
      const cached = countries ?? await cache.peekCountries().catch(() => null);
      if (thisVisit !== visit) return;
      renderOptions(cached, saved.countryCode);
      if (saved.enabled) await loadCountries();
    },

    /**
     * Validates the section, showing the error when it fails.
     * @returns {ReturnType<typeof validatePublicHolidays>}
     */
    validate() {
      clearError();
      const result = validatePublicHolidays(
        { enabled: toggle.checked, countryCode: select.value, showNext: showNext ? showNext.checked : saved.showNext },
        { countries, savedCountryCode: saved.countryCode });
      if (!result.isValid) {
        error.textContent = result.error;
        error.classList.add('visible');
        select.classList.add('is-invalid');
      }
      return result;
    }
  };
}
