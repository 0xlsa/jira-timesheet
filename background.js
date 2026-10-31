/**
 * Timesheet for Jira - Background Service Worker (Manifest V3)
 * Handles extension lifecycle, the toolbar icon and its menu, and runtime messaging.
 * Compatible with Chrome (MV3) and Firefox (MV3, 140+).
 */

import { createJiraClient } from './src/jira/createJiraClient.js';
import { getMondayOfWeek } from './src/worklog/worklogUtils.js';
import { loadWeek } from './src/worklog/weeklyWorklogService.js';
import { createSettingsStore } from './src/settings/settingsStore.js';
import { ext, isExtensionContext, createPlatform } from './src/compat/browser-api.js';
import { setUpTimesheetLaunchers } from './src/background/launch.js';

// Extension lifecycle and messaging listeners
if (isExtensionContext()) {
  // The toolbar icon, its "Settings" menu item, and the first install open the timesheet
  // (src/background/launch.js).
  setUpTimesheetLaunchers(ext);

  // Listen for runtime messages from the options page or future popup/content scripts
  if (ext.runtime && ext.runtime.onMessage) {
    ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== 'object') {
        return false;
      }

      if (message.action === 'TEST_CONNECTION') {
        handleTestConnection(message.payload)
          .then((result) => sendResponse(result))
          .catch((err) => {
            sendResponse({
              success: false,
              error: `Unexpected error: ${err.message || 'Unknown error'}`,
              errorType: 'UNEXPECTED_ERROR',
              testedAt: new Date().toISOString()
            });
          });
        return true; // Keep message channel open for async response
      }

      if (message.action === 'GET_SETTINGS') {
        createSettingsStore(createPlatform().storage).load()
          .then(({ jiraBaseUrl, deploymentType, email, token, lastTestResult }) => sendResponse({
            success: true,
            settings: { jiraBaseUrl, deploymentType, email, token, lastTestResult }
          }))
          .catch(() => sendResponse({ success: false, settings: {} }));
        return true;
      }

      if (message.action === 'FETCH_WORKLOGS') {
        handleFetchWorklogs(message.payload)
          .then((result) => sendResponse(result))
          .catch((err) => {
            sendResponse({
              success: false,
              error: `Worklog fetch failed: ${err.message || 'Unknown error'}`
            });
          });
        return true;
      }

      return false;
    });
  }
}


/**
 * Handles connection testing request in the service worker context.
 *
 * @param {object} payload
 * @param {string} payload.baseUrl
 * @param {'cloud' | 'server'} payload.deploymentType
 * @param {string} [payload.email]
 * @param {string} payload.token
 * @returns {Promise<object>}
 */
async function handleTestConnection(payload) {
  if (!payload) {
    return {
      success: false,
      error: 'Missing connection configuration payload.',
      errorType: 'CONFIG_ERROR',
      testedAt: new Date().toISOString()
    };
  }

  const { client, error } = createJiraClient(payload);
  if (!client) {
    return {
      success: false,
      error,
      errorType: 'CONFIG_ERROR',
      testedAt: new Date().toISOString()
    };
  }

  return await client.testConnection();
}

/**
 * Handles weekly worklogs retrieval request.
 *
 * @param {object} payload
 * @param {string} payload.baseUrl
 * @param {'cloud' | 'server'} payload.deploymentType
 * @param {string} [payload.email]
 * @param {string} payload.token
 * @param {string | Date} [payload.startDate]
 * @param {string | Date} [payload.endDate]
 * @param {object} [clientOptions] - Passed to JiraClient (e.g. fetchFn in tests)
 * @returns {Promise<object>}
 */
export async function handleFetchWorklogs(payload, clientOptions = {}) {
  if (!payload) {
    return {
      success: false,
      error: 'Missing worklog fetch payload.'
    };
  }

  const { client, error } = createJiraClient(payload, clientOptions);
  if (!client) {
    return { success: false, error };
  }

  const week = await loadWeek(client, {
    monday: payload.startDate ? new Date(payload.startDate) : getMondayOfWeek(new Date()),
    sunday: payload.endDate ? new Date(payload.endDate) : undefined
  });

  return { success: true, ...week };
}
