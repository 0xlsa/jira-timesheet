/**
 * Loads the My Active Issues section's contents and reports each state it goes through. A newer
 * load cancels an older one, so a slow answer never replaces a newer one (after changing weeks
 * or a Sync). The statuses found on a Jira site are reused until a load asks for them again or
 * the site changes. No DOM: the page controller renders the states.
 */

import { loadWorkingIssues } from './weeklyWorklogService.js';

/**
 * @param {(state: { status: 'loading' | 'ready' | 'unavailable' | 'error', issues?: Array<object>,
 *   statusNames?: string[], message?: string } | null) => void} onChange - Called with each new state;
 *   null when there's nothing to show
 * @param {object} [options]
 * @param {(err: Error) => void} [options.logError=console.error] - Reports a failed load
 * @returns {{ refresh: (client: object, options?: { refreshStatuses?: boolean }) => Promise<void>, clear: () => void }}
 */
export function createWorkingIssuesLoader(onChange, { logError = (err) => console.error('Failed to load working issues:', err) } = {}) {
  // Load in flight, cancelled when a newer one starts.
  let request = null;
  // Statuses found on a Jira site: { siteKey, workingStatuses }.
  let statusCache = null;

  return {
    /**
     * Loads the issues from Jira, reporting `loading`, then `ready`, `unavailable` (the site has
     * none of the statuses), or `error`. Nothing is reported for a load a newer one replaced.
     *
     * @param {object} client - JiraClient (or a test double with baseUrl and deploymentType)
     * @param {object} [options]
     * @param {boolean} [options.refreshStatuses=false] - Look the site's statuses up again
     */
    async refresh(client, { refreshStatuses = false } = {}) {
      request?.abort();
      const current = new AbortController();
      request = current;

      const siteKey = `${client.deploymentType}|${client.baseUrl}`;
      if (refreshStatuses || statusCache?.siteKey !== siteKey) statusCache = null;

      onChange({ status: 'loading' });
      try {
        const { workingStatuses, issues } = await loadWorkingIssues(client, {
          workingStatuses: statusCache?.workingStatuses, signal: current.signal
        });
        if (current.signal.aborted) return;

        statusCache = { siteKey, workingStatuses };
        onChange(issues
          ? { status: 'ready', issues, statusNames: workingStatuses.names }
          : { status: 'unavailable', message: workingStatuses.reason });
      } catch (err) {
        if (current.signal.aborted) return;
        // A status may have been renamed or removed since it was found: look them up again next time.
        statusCache = null;
        logError(err);
        onChange({ status: 'error', message: err.message || 'Unable to retrieve issues from Jira.' });
      } finally {
        if (request === current) request = null;
      }
    },

    /** Cancels any load and reports that there's nothing to show. */
    clear() {
      request?.abort();
      request = null;
      onChange(null);
    }
  };
}
