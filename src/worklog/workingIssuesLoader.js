/**
 * Loads the My Active Issues section's contents for a week and reports each state it goes
 * through. A newer load cancels an older one, so a slow answer never replaces a newer one (after
 * changing weeks or a Sync). Loading the week already shown, or already loading, does nothing
 * unless forced. No DOM: the page controller renders the states.
 */

import { loadActiveIssues } from './weeklyWorklogService.js';
import { getLocalDateKey } from './worklogUtils.js';

/**
 * @param {(state: { status: 'loading' | 'ready' | 'error', issues?: Array<object>, message?: string } | null) => void}
 *   onChange - Called with each new state; null when there's nothing to show
 * @param {object} [options]
 * @param {(err: Error) => void} [options.logError=console.error] - Reports a failed load
 * @returns {{ refresh: (client: object, week: { monday: Date, sunday?: Date, force?: boolean }) => Promise<void>, clear: () => void }}
 */
export function createWorkingIssuesLoader(onChange, { logError = (err) => console.error('Failed to load active issues:', err) } = {}) {
  // Load in flight, cancelled when a newer one starts: { controller, key }.
  let request = null;
  // Site and week of the issues shown, once loaded; null while loading, after an error, or cleared.
  let shownKey = null;

  return {
    /**
     * Loads the week's issues from Jira, reporting `loading`, then `ready` or `error`. Nothing is
     * reported for a load a newer one replaced.
     *
     * @param {object} client - JiraClient (or a test double with baseUrl and deploymentType)
     * @param {object} week
     * @param {Date} week.monday
     * @param {Date} [week.sunday]
     * @param {boolean} [week.force=false] - Load even when the week is already shown or loading
     *   (Sync, Retry, or a worklog change)
     * @param {Array<{ id: string }>} [week.assignmentFields] - Additional assignment fields; a
     *   different set loads again, like another week
     */
    async refresh(client, { monday, sunday, force = false, assignmentFields = [] }) {
      const fieldsKey = assignmentFields.map((field) => field.id).join(',');
      const key = `${client.deploymentType}|${client.baseUrl}|${getLocalDateKey(monday)}${fieldsKey ? `|${fieldsKey}` : ''}`;
      if (!force && (request?.key === key || (!request && shownKey === key))) return;

      request?.controller.abort();
      const current = { controller: new AbortController(), key };
      request = current;
      shownKey = null;

      onChange({ status: 'loading' });
      try {
        const issues = await loadActiveIssues(client, { monday, sunday, signal: current.controller.signal, assignmentFields });
        if (current.controller.signal.aborted) return;
        shownKey = key;
        onChange({ status: 'ready', issues });
      } catch (err) {
        if (current.controller.signal.aborted) return;
        logError(err);
        onChange({ status: 'error', message: err.message || 'Unable to retrieve issues from Jira.' });
      } finally {
        if (request === current) request = null;
      }
    },

    /** Cancels any load and reports that there's nothing to show. */
    clear() {
      request?.controller.abort();
      request = null;
      shownKey = null;
      onChange(null);
    }
  };
}
