/**
 * Loads the My Active Issues section's contents and reports each state it goes through. A newer
 * load cancels an older one, so a slow answer never replaces a newer one (after a Sync or a change
 * of settings). The list doesn't depend on the week displayed: loading what's already shown (same
 * Jira site, Additional Assignment Fields, Show Recently Logged Issues, and custom view fields), or
 * already loading, does nothing unless forced. No DOM: the page controller renders the states.
 *
 * Custom views (src/jira/customViews.js) use this same load: their fields (`viewFields`) are only
 * added to what it returns, and they filter its issues on the page.
 */

import { loadActiveIssues } from './weeklyWorklogService.js';

/**
 * @param {(state: { status: 'loading' | 'ready' | 'error', issues?: Array<object>, message?: string,
 *   includeRecentlyLogged?: boolean, viewFields?: string[] } | null) => void}
 *   onChange - Called with each new state; null when there's nothing to show
 * @param {object} [options]
 * @param {(err: Error) => void} [options.logError=console.error] - Reports a failed load
 * @param {() => Date} [options.now] - The clock that ends the recently logged window
 * @returns {{ refresh: (client: object, options?: { force?: boolean, assignmentFields?: Array<{ id: string }>,
 *   includeRecentlyLogged?: boolean, viewFields?: string[] }) => Promise<void>, clear: () => void }}
 */
export function createWorkingIssuesLoader(onChange, { logError = (err) => console.error('Failed to load active issues:', err), now = () => new Date() } = {}) {
  // Load in flight, cancelled when a newer one starts: { controller, key }.
  let request = null;
  // What the issues shown were loaded for, once loaded; null while loading, after an error, or cleared.
  let shownKey = null;

  return {
    /**
     * Loads the issues from Jira, reporting `loading`, then `ready` or `error`. Nothing is
     * reported for a load a newer one replaced.
     *
     * @param {object} client - JiraClient (or a test double with baseUrl and deploymentType)
     * @param {object} [options]
     * @param {boolean} [options.force=false] - Load even when the same list is already shown or
     *   loading (Sync, Retry, or a worklog change)
     * @param {Array<{ id: string }>} [options.assignmentFields] - Additional assignment fields; a
     *   different set loads again
     * @param {boolean} [options.includeRecentlyLogged=true] - Show Recently Logged Issues; a change
     *   loads again
     * @param {string[]} [options.viewFields] - The fields custom views compare (reported back with the
     *   issues as `viewFields`); a different set loads again
     */
    async refresh(client, { force = false, assignmentFields = [], includeRecentlyLogged = true, viewFields = [] } = {}) {
      const fieldsKey = assignmentFields.map((field) => field.id).join(',');
      const key = `${client.deploymentType}|${client.baseUrl}|${includeRecentlyLogged ? 'logged' : 'assigned'}${fieldsKey ? `|${fieldsKey}` : ''}` +
        `${viewFields.length ? `|views:${viewFields.join(',')}` : ''}`;
      if (!force && (request?.key === key || (!request && shownKey === key))) return;

      request?.controller.abort();
      const current = { controller: new AbortController(), key };
      request = current;
      shownKey = null;

      onChange({ status: 'loading' });
      try {
        const issues = await loadActiveIssues(client, { now: now(), signal: current.controller.signal, assignmentFields, includeRecentlyLogged, viewFields });
        if (current.controller.signal.aborted) return;
        shownKey = key;
        onChange({ status: 'ready', issues, includeRecentlyLogged, ...(viewFields.length && { viewFields }) });
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
