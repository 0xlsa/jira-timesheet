/**
 * Timesheet for Jira settings persistence.
 *
 * Owns the storage keys and their shape. The storage area is injected
 * (`storage.local` in the extension, an in-memory area in tests), so this
 * module has no browser dependencies.
 *
 * Stored keys:
 * - deploymentType ('cloud' | 'server')
 * - email: the Atlassian account email for Jira Cloud, kept when saving either edition
 * - jiraBaseUrl, token: the active edition's instance URL and token (read by the
 *   worklog view and background)
 * - cloudBaseUrl, serverBaseUrl, cloudToken, serverToken: per-edition values kept
 *   by the settings form, so switching edition never overwrites the other one
 * - lastTestResult: last successful connection test
 * - publicHolidaysEnabled, publicHolidaysCountry: the Public Holidays switch, and the country the
 *   user selected (an ISO 3166-1 alpha-2 code, or ''). The country is only ever what the user
 *   chose; it's kept when the feature is turned off.
 * - publicHolidaysShowNext: the Show Next Public Holiday switch (the dashboard banner). Missing
 *   (saved before the switch existed) reads as on; it's kept when the feature is turned off.
 * - showRecentlyLoggedIssues: the Show Recently Logged Issues switch (My Active Issues). Missing
 *   (saved before the switch existed) reads as on, as the list was before. Saved on its own.
 * - assignmentFieldsBySite: Additional Assignment Fields, per Jira site, so one site's fields never
 *   apply to another: { [site]: [{ id, name }] }, `site` being `${deploymentType}|${baseUrl}`
 *   (siteId() in src/timer/timeTrackingStore.js), `id` the custom field ID, and `name` its name when
 *   it was chosen (for display). Saved on its own, by saveAssignmentFields(). Missing or empty: none.
 */

import { normalizeCountryCode } from '../holidays/nagerDateClient.js';
import { normalizeAssignmentFields, normalizeAssignmentFieldsBySite } from '../jira/assignmentFields.js';

const STORAGE_KEYS = [
  'jiraBaseUrl',
  'deploymentType',
  'email',
  'token',
  'cloudBaseUrl',
  'serverBaseUrl',
  'cloudToken',
  'serverToken',
  'lastTestResult',
  'publicHolidaysEnabled',
  'publicHolidaysCountry',
  'publicHolidaysShowNext',
  'showRecentlyLoggedIssues',
  'assignmentFieldsBySite'
];

/**
 * Normalizes raw stored values into the settings shape used by the app.
 *
 * Settings saved before per-edition values existed only have `jiraBaseUrl` and
 * `token`, which belong to the saved deployment type.
 *
 * @param {object} [raw]
 * @returns {{
 *   jiraBaseUrl: string,
 *   deploymentType: 'cloud' | 'server',
 *   email: string,
 *   token: string,
 *   baseUrlsByType: { cloud: string, server: string },
 *   tokensByType: { cloud: string, server: string },
 *   lastTestResult: object | null,
 *   publicHolidays: { enabled: boolean, countryCode: string, showNext: boolean },
 *   showRecentlyLoggedIssues: boolean,
 *   assignmentFieldsBySite: Record<string, Array<{ id: string, name: string }>>
 * }}
 */
export function normalizeSettings(raw = {}) {
  const deploymentType = raw.deploymentType === 'server' ? 'server' : 'cloud';
  const activeBaseUrl = raw.jiraBaseUrl || '';
  const activeToken = raw.token || '';
  const forEdition = (cloudValue, serverValue, activeValue) => ({
    cloud: cloudValue ?? (deploymentType === 'cloud' ? activeValue : ''),
    server: serverValue ?? (deploymentType === 'server' ? activeValue : '')
  });

  return {
    jiraBaseUrl: activeBaseUrl,
    deploymentType,
    email: raw.email || '',
    token: activeToken,
    baseUrlsByType: forEdition(raw.cloudBaseUrl, raw.serverBaseUrl, activeBaseUrl),
    tokensByType: forEdition(raw.cloudToken, raw.serverToken, activeToken),
    lastTestResult: raw.lastTestResult || null,
    publicHolidays: normalizePublicHolidays(raw),
    showRecentlyLoggedIssues: raw.showRecentlyLoggedIssues !== false,
    assignmentFieldsBySite: normalizeAssignmentFieldsBySite(raw.assignmentFieldsBySite)
  };
}

/**
 * A Jira site's Additional Assignment Fields.
 * @param {{ assignmentFieldsBySite?: object } | null} settings - From normalizeSettings()
 * @param {string} site - `${deploymentType}|${baseUrl}`
 * @returns {Array<{ id: string, name: string }>} Empty when none are set for the site
 */
export function assignmentFieldsForSite(settings, site) {
  return settings?.assignmentFieldsBySite?.[site] ?? [];
}

/**
 * The feature is only on with a country: a stored "on" without one reads as off. The banner
 * switch is on unless it was turned off.
 */
function normalizePublicHolidays(raw) {
  const countryCode = normalizeCountryCode(raw.publicHolidaysCountry);
  return {
    enabled: raw.publicHolidaysEnabled === true && Boolean(countryCode),
    countryCode,
    showNext: raw.publicHolidaysShowNext !== false
  };
}

/**
 * Returns true when settings contain everything needed to call Jira.
 * @param {{ jiraBaseUrl: string, deploymentType: string, email: string, token: string }} settings
 * @returns {boolean}
 */
export function isConfigured(settings) {
  return Boolean(
    settings.jiraBaseUrl &&
    settings.token &&
    (settings.deploymentType === 'server' || settings.email)
  );
}

/**
 * @param {{ get: Function, set: Function, remove: Function }} storageArea
 */
export function createSettingsStore(storageArea) {
  return {
    async load() {
      return normalizeSettings(await storageArea.get(STORAGE_KEYS));
    },

    /**
     * @param {{
     *   deploymentType: 'cloud' | 'server',
     *   email: string,
     *   baseUrlsByType: { cloud: string, server: string },
     *   tokensByType: { cloud: string, server: string },
     *   publicHolidays?: { enabled: boolean, countryCode: string, showNext?: boolean }
     * }} settings - Without `publicHolidays`, the saved Public Holidays settings are kept (and
     *   without `showNext`, the saved banner switch)
     */
    async save({ deploymentType, email, baseUrlsByType, tokensByType, publicHolidays }) {
      await storageArea.set({
        ...(publicHolidays && {
          publicHolidaysEnabled: publicHolidays.enabled,
          publicHolidaysCountry: publicHolidays.countryCode,
          ...(typeof publicHolidays.showNext === 'boolean' && { publicHolidaysShowNext: publicHolidays.showNext })
        }),
        jiraBaseUrl: baseUrlsByType[deploymentType],
        deploymentType,
        email,
        token: tokensByType[deploymentType],
        cloudBaseUrl: baseUrlsByType.cloud,
        serverBaseUrl: baseUrlsByType.server,
        cloudToken: tokensByType.cloud,
        serverToken: tokensByType.server,
        savedAt: new Date().toISOString()
      });
    },

    /** @param {{ user: object, serverInfo?: object, testedAt: string }} result */
    async saveTestResult({ user, serverInfo, testedAt }) {
      await storageArea.set({
        lastTestResult: { success: true, user, serverInfo, testedAt }
      });
    },

    async clearTestResult() {
      await storageArea.remove('lastTestResult');
    },

    /**
     * Saves the Public Holidays settings on their own, as they change; the other settings are kept.
     * @param {{ enabled: boolean, countryCode: string, showNext: boolean }} publicHolidays
     */
    async savePublicHolidays({ enabled, countryCode, showNext }) {
      await storageArea.set({
        publicHolidaysEnabled: Boolean(enabled),
        publicHolidaysCountry: countryCode,
        publicHolidaysShowNext: Boolean(showNext)
      });
    },

    /**
     * Saves the Show Recently Logged Issues switch on its own, as it changes; the other settings
     * are kept.
     * @param {boolean} show
     */
    async saveShowRecentlyLoggedIssues(show) {
      await storageArea.set({ showRecentlyLoggedIssues: Boolean(show) });
    },

    /**
     * Saves the Show Next Public Holiday switch on its own, as it changes; the other settings
     * are kept.
     * @param {boolean} showNext
     */
    async saveShowNextHoliday(showNext) {
      await storageArea.set({ publicHolidaysShowNext: Boolean(showNext) });
    },

    /**
     * Replaces one Jira site's Additional Assignment Fields; other sites' are kept. An empty list
     * removes the site's entry.
     *
     * @param {string} site - `${deploymentType}|${baseUrl}`
     * @param {Array<{ id: string, name: string }>} fields
     */
    async saveAssignmentFields(site, fields) {
      if (!site) throw new Error('A Jira site is required.');
      const { assignmentFieldsBySite } = await storageArea.get(['assignmentFieldsBySite']);
      const bySite = normalizeAssignmentFieldsBySite(assignmentFieldsBySite);
      const valid = normalizeAssignmentFields(fields);
      if (valid.length) bySite[site] = valid;
      else delete bySite[site];
      await storageArea.set({ assignmentFieldsBySite: bySite });
    }
  };
}
