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
 * - showRecentlyLoggedIssues: the Show Recently Logged Issues switch (My Work). Off unless
 *   turned on: missing reads as off. Saved on its own.
 * - assignmentFieldsBySite: Additional Assignment Fields, per Jira site, so one site's fields never
 *   apply to another: { [site]: [{ id, name }] }, `site` being `${deploymentType}|${baseUrl}`
 *   (siteId() in src/timer/timeTrackingStore.js), `id` the custom field ID, and `name` its name when
 *   it was chosen (for display). Saved on its own, by saveAssignmentFields(). Missing or empty: none.
 * - customViewsBySite: the custom views of My Work, per Jira site (`site` as above):
 *   { [site]: { version, views } } (src/jira/customViews.js). Saved on its own, by saveCustomViews(),
 *   which never touches another site's entry, nor one saved by another version of the extension.
 * - customViewOrderBySite: the order of each Jira site's custom view tabs (after Active, always
 *   first): { [site]: [viewId, …] } (src/jira/customViews.js orderViews()). Saved on its own, by
 *   saveCustomViewOrder(), apart from the views, so reordering never rewrites a view. Views it
 *   doesn't name follow, as saved; IDs of views that are gone are skipped. Missing: as saved.
 * - workingIssuesGroupOrderBySite: the order of each Jira site's My Work groups (My Issues and
 *   Pending Worklogs): { [site]: [groupId, …] } (WORKING_ISSUES_GROUP_IDS). Saved on its own, by
 *   saveWorkingIssuesGroupOrder(). Groups it doesn't name follow in their default order. Missing:
 *   the default order (My Issues, then Pending Worklogs).
 */

import { normalizeCountryCode } from '../holidays/nagerDateClient.js';
import { normalizeAssignmentFields, normalizeAssignmentFieldsBySite } from '../jira/assignmentFields.js';
import {
  normalizeCustomViewsBySite, normalizeSiteViews, normalizeView, normalizeCustomViewOrderBySite, normalizeViewOrder, CUSTOM_VIEWS_VERSION, MAX_CUSTOM_VIEWS
} from '../jira/customViews.js';

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
  'assignmentFieldsBySite',
  'customViewsBySite',
  'customViewOrderBySite',
  'workingIssuesGroupOrderBySite'
];

// My Work's groups, in their default order: My Issues ('active'), then Pending Worklogs.
export const WORKING_ISSUES_GROUP_IDS = Object.freeze(['active', 'pending']);

/**
 * A stored My Work group order, checked: every group once, those the order names first, as it has
 * them, then the others in their default order. Anything else is ignored.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeWorkingIssuesGroupOrder(raw) {
  const named = Array.isArray(raw) ? raw.filter((id, index) => WORKING_ISSUES_GROUP_IDS.includes(id) && raw.indexOf(id) === index) : [];
  return [...named, ...WORKING_ISSUES_GROUP_IDS.filter((id) => !named.includes(id))];
}

/**
 * Checks every site's stored My Work group order: `{ [site]: normalizeWorkingIssuesGroupOrder() }`.
 * @param {unknown} raw
 * @returns {Record<string, string[]>}
 */
function normalizeWorkingIssuesGroupOrderBySite(raw) {
  const bySite = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bySite;
  for (const [site, order] of Object.entries(raw)) {
    if (site && Array.isArray(order)) bySite[site] = normalizeWorkingIssuesGroupOrder(order);
  }
  return bySite;
}

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
 *   assignmentFieldsBySite: Record<string, Array<{ id: string, name: string }>>,
 *   customViewsBySite: Record<string, { version: number, views: Array<object>, unsupported?: true }>,
 *   customViewOrderBySite: Record<string, string[]>,
 *   workingIssuesGroupOrderBySite: Record<string, string[]>
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
    showRecentlyLoggedIssues: raw.showRecentlyLoggedIssues === true,
    assignmentFieldsBySite: normalizeAssignmentFieldsBySite(raw.assignmentFieldsBySite),
    customViewsBySite: normalizeCustomViewsBySite(raw.customViewsBySite),
    customViewOrderBySite: normalizeCustomViewOrderBySite(raw.customViewOrderBySite),
    workingIssuesGroupOrderBySite: normalizeWorkingIssuesGroupOrderBySite(raw.workingIssuesGroupOrderBySite)
  };
}

/**
 * A Jira site's custom views.
 * @param {{ customViewsBySite?: object } | null} settings - From normalizeSettings()
 * @param {string} site - `${deploymentType}|${baseUrl}`
 * @returns {{ version: number, views: Array<object>, unsupported?: true }} No views when none are set;
 *   `unsupported` when they were saved by another version of the extension (and can't be changed)
 */
export function customViewsForSite(settings, site) {
  return settings?.customViewsBySite?.[site] ?? { version: CUSTOM_VIEWS_VERSION, views: [] };
}

/**
 * A Jira site's custom view tab order: view IDs, Active not among them.
 * @param {{ customViewOrderBySite?: object } | null} settings - From normalizeSettings()
 * @param {string} site - `${deploymentType}|${baseUrl}`
 * @returns {string[]} Empty when none is saved (the views show as saved)
 */
export function customViewOrderForSite(settings, site) {
  return settings?.customViewOrderBySite?.[site] ?? [];
}

/**
 * A Jira site's My Work group order.
 * @param {{ workingIssuesGroupOrderBySite?: object } | null} settings - From normalizeSettings()
 * @param {string} site - `${deploymentType}|${baseUrl}`
 * @returns {string[]} Every group ID once; the default order when none is saved
 */
export function workingIssuesGroupOrderForSite(settings, site) {
  return normalizeWorkingIssuesGroupOrder(settings?.workingIssuesGroupOrderBySite?.[site]);
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
    },

    /**
     * Replaces one Jira site's custom views; every other site's entry is kept exactly as stored. An
     * empty list removes the site's entry.
     *
     * @param {string} site - `${deploymentType}|${baseUrl}`
     * @param {Array<object>} views - Valid views (src/jira/customViews.js), at most MAX_CUSTOM_VIEWS
     * @throws {Error} Without a site, for an invalid list, or when the site's views were saved by
     *   another version of the extension, which are left as they are
     */
    async saveCustomViews(site, views) {
      if (!site) throw new Error('A Jira site is required.');
      const valid = views.map(normalizeView);
      if (valid.some((view) => !view) || valid.length > MAX_CUSTOM_VIEWS) throw new Error('These custom views aren\'t valid.');
      const { customViewsBySite } = await storageArea.get(['customViewsBySite']);
      const bySite = customViewsBySite && typeof customViewsBySite === 'object' && !Array.isArray(customViewsBySite)
        ? { ...customViewsBySite }
        : {};
      if (normalizeSiteViews(bySite[site]).unsupported) {
        throw new Error('This Jira site\'s custom views were saved by another version of Timesheet for Jira, so they weren\'t changed. Update the extension to edit them.');
      }
      if (valid.length) bySite[site] = { version: CUSTOM_VIEWS_VERSION, views: valid };
      else delete bySite[site];
      await storageArea.set({ customViewsBySite: bySite });
    },

    /**
     * Replaces one Jira site's custom view tab order; every other site's entry is kept exactly as
     * stored, and the views themselves aren't touched.
     *
     * @param {string} site - `${deploymentType}|${baseUrl}`
     * @param {string[]} ids - The custom views' IDs, in their tabs' order
     * @throws {Error} Without a site, for a list that isn't valid IDs, each once, or when the site's
     *   views or order were saved by another version of the extension, which are left as they are
     */
    async saveCustomViewOrder(site, ids) {
      if (!site) throw new Error('A Jira site is required.');
      if (!Array.isArray(ids) || normalizeViewOrder(ids).length !== ids.length || ids.length > MAX_CUSTOM_VIEWS) {
        throw new Error('This order of custom views isn\'t valid.');
      }
      const { customViewsBySite, customViewOrderBySite } = await storageArea.get(['customViewsBySite', 'customViewOrderBySite']);
      const bySite = customViewOrderBySite && typeof customViewOrderBySite === 'object' && !Array.isArray(customViewOrderBySite)
        ? { ...customViewOrderBySite }
        : {};
      const viewsEntry = customViewsBySite && typeof customViewsBySite === 'object' ? customViewsBySite[site] : undefined;
      if (normalizeSiteViews(viewsEntry).unsupported || (site in bySite && !Array.isArray(bySite[site]))) {
        throw new Error('This Jira site\'s custom views were saved by another version of Timesheet for Jira, so their order wasn\'t changed. Update the extension to reorder them.');
      }
      bySite[site] = [...ids];
      await storageArea.set({ customViewOrderBySite: bySite });
    },

    /**
     * Replaces one Jira site's My Work group order; every other site's entry is kept exactly as
     * stored.
     *
     * @param {string} site - `${deploymentType}|${baseUrl}`
     * @param {string[]} ids - Every group ID (WORKING_ISSUES_GROUP_IDS) once, in their new order
     * @throws {Error} Without a site, or for a list that isn't every group once
     */
    async saveWorkingIssuesGroupOrder(site, ids) {
      if (!site) throw new Error('A Jira site is required.');
      if (!Array.isArray(ids) || ids.length !== WORKING_ISSUES_GROUP_IDS.length ||
          normalizeWorkingIssuesGroupOrder(ids).join() !== ids.join()) {
        throw new Error('This order of the My Work groups isn\'t valid.');
      }
      const { workingIssuesGroupOrderBySite } = await storageArea.get(['workingIssuesGroupOrderBySite']);
      const bySite = workingIssuesGroupOrderBySite && typeof workingIssuesGroupOrderBySite === 'object' && !Array.isArray(workingIssuesGroupOrderBySite)
        ? { ...workingIssuesGroupOrderBySite }
        : {};
      bySite[site] = [...ids];
      await storageArea.set({ workingIssuesGroupOrderBySite: bySite });
    }
  };
}
