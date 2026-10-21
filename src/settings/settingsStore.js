/**
 * Timesheet for Jira settings persistence.
 *
 * Owns the storage keys and their shape. The storage area is injected
 * (`storage.local` in the extension, an in-memory area in tests), so this
 * module has no browser dependencies.
 *
 * Stored keys:
 * - deploymentType ('cloud' | 'server'), email
 * - jiraBaseUrl, token: the active edition's instance URL and token (read by the
 *   worklog view and background)
 * - cloudBaseUrl, serverBaseUrl, cloudToken, serverToken: per-edition values kept
 *   by the settings form, so switching edition never overwrites the other one
 * - lastTestResult: last successful connection test
 */

const STORAGE_KEYS = [
  'jiraBaseUrl',
  'deploymentType',
  'email',
  'token',
  'cloudBaseUrl',
  'serverBaseUrl',
  'cloudToken',
  'serverToken',
  'lastTestResult'
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
 *   lastTestResult: object | null
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
    lastTestResult: raw.lastTestResult || null
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
     *   tokensByType: { cloud: string, server: string }
     * }} settings
     */
    async save({ deploymentType, email, baseUrlsByType, tokensByType }) {
      await storageArea.set({
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
    }
  };
}
