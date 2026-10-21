import { JiraUrlValidator } from '../validation/JiraUrlValidator.js';
import { JiraCloudTokenProvider } from '../auth/JiraCloudTokenProvider.js';
import { JiraPatProvider } from '../auth/JiraPatProvider.js';
import { JiraClient } from './JiraClient.js';

/**
 * Builds a JiraClient from connection settings: validates the instance URL and
 * picks the auth provider for the Jira edition.
 *
 * @param {object} connection
 * @param {string} connection.baseUrl
 * @param {'cloud' | 'server'} connection.deploymentType
 * @param {string} [connection.email] - Required for Jira Cloud
 * @param {string} connection.token - API token (Cloud) or PAT (Data Center / Server)
 * @param {object} [clientOptions] - Passed to JiraClient (e.g. fetchFn, timeoutMs)
 * @returns {{ client: JiraClient, error: null } | { client: null, error: string }}
 */
export function createJiraClient({ baseUrl, deploymentType, email, token }, clientOptions = {}) {
  const urlCheck = JiraUrlValidator.validate(baseUrl, { deploymentType });
  if (!urlCheck.isValid) {
    return { client: null, error: urlCheck.error || 'Invalid Base URL.' };
  }

  let provider;
  if (deploymentType === 'cloud') {
    provider = new JiraCloudTokenProvider(email, token);
  } else if (deploymentType === 'server') {
    provider = new JiraPatProvider(token);
  } else {
    return {
      client: null,
      error: 'Invalid Jira edition selected. Choose Jira Cloud or Jira Data Center / Server.'
    };
  }

  return { client: new JiraClient(urlCheck.sanitizedUrl, provider, clientOptions), error: null };
}
