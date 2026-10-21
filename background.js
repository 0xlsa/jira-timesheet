/**
 * Timesheet for Jira - Background Service Worker (Manifest V3)
 * Handles extension lifecycle, action clicks, and runtime messaging.
 * Compatible with Chrome (MV3) and Firefox (MV3, 116+).
 */

import { JiraUrlValidator } from './src/validation/JiraUrlValidator.js';
import { JiraCloudTokenProvider } from './src/auth/JiraCloudTokenProvider.js';
import { JiraPatProvider } from './src/auth/JiraPatProvider.js';
import { JiraClient } from './src/jira/JiraClient.js';
import {
  getMondayOfWeek,
  getWeekDays,
  aggregateWorklogsByWeek
} from './src/worklog/worklogUtils.js';
import { ext, isExtensionContext } from './src/compat/browser-api.js';

// Extension lifecycle and messaging listeners
if (isExtensionContext()) {
  // Open options page when clicking the extension action toolbar button
  if (ext.action && ext.action.onClicked) {
    ext.action.onClicked.addListener(async () => {
      try {
        await ext.runtime.openOptionsPage();
      } catch (err) {
        console.error('Failed to open Timesheet for Jira options page:', err);
      }
    });
  }

  // Extension installation or update listener
  // Note: details.reason is a string ('install', 'update', 'browser_update')
  // in both Chrome and Firefox — we use the string literal for cross-browser safety.
  if (ext.runtime && ext.runtime.onInstalled) {
    ext.runtime.onInstalled.addListener((details) => {
      if (details.reason === 'install') {
        // Open options page on initial install to guide the user through setup
        ext.runtime.openOptionsPage().catch(() => {});
      }
    });
  }

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
        ext.storage.local.get(['jiraBaseUrl', 'deploymentType', 'email', 'token', 'lastTestResult'])
          .then((data) => sendResponse({ success: true, settings: data }))
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

  const { baseUrl, deploymentType, email, token } = payload;

  const urlValidation = JiraUrlValidator.validate(baseUrl);
  if (!urlValidation.isValid) {
    return {
      success: false,
      error: urlValidation.error || 'Invalid Base URL.',
      errorType: 'CONFIG_ERROR',
      testedAt: new Date().toISOString()
    };
  }

  let provider;
  if (deploymentType === 'cloud') {
    provider = new JiraCloudTokenProvider(email, token);
  } else if (deploymentType === 'server') {
    provider = new JiraPatProvider(token);
  } else {
    return {
      success: false,
      error: 'Invalid Jira edition selected. Choose Jira Cloud or Jira Data Center / Server.',
      errorType: 'CONFIG_ERROR',
      testedAt: new Date().toISOString()
    };
  }

  const client = new JiraClient(urlValidation.sanitizedUrl, provider);
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
 * @returns {Promise<object>}
 */
export async function handleFetchWorklogs(payload, options = {}) {
  if (!payload) {
    return {
      success: false,
      error: 'Missing worklog fetch payload.'
    };
  }

  const { baseUrl, deploymentType, email, token, startDate, endDate } = payload;

  const urlValidation = JiraUrlValidator.validate(baseUrl);
  if (!urlValidation.isValid) {
    return {
      success: false,
      error: urlValidation.error || 'Invalid Base URL.'
    };
  }

  let provider;
  if (deploymentType === 'cloud') {
    provider = new JiraCloudTokenProvider(email, token);
  } else if (deploymentType === 'server') {
    provider = new JiraPatProvider(token);
  } else {
    return {
      success: false,
      error: 'Invalid Jira edition selected.'
    };
  }

  const client = new JiraClient(urlValidation.sanitizedUrl, provider, options);

  const monday = startDate ? new Date(startDate) : getMondayOfWeek(new Date());
  const sunday = endDate ? new Date(endDate) : new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000);

  const result = await client.getWorklogsForDateRange(monday, sunday);
  const weekDays = getWeekDays(monday, new Date());
  const aggregated = aggregateWorklogsByWeek(result.worklogs, weekDays);

  return {
    success: true,
    user: result.user,
    ...aggregated
  };
}

