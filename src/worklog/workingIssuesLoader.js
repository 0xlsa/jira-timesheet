/**
 * Loads My Issues' Active view and reports each state it goes through. A newer
 * load cancels an older one, so a slow answer never replaces a newer one (after a Sync or a change
 * of settings). The list doesn't depend on the week displayed: loading what's already shown (same
 * Jira site, Additional Assignment Fields, and Show Recently Logged Issues), or already loading,
 * does nothing unless forced. No DOM: the page controller renders the states.
 *
 * A load can keep the issues shown while it runs (`keepShown`, for Show Recently Logged Issues):
 * the last issues loaded for the same Jira site stay, marked `refreshing`, until Jira's new answer
 * replaces them in one state; if the load fails, they stay, with `refreshError` saying why. The
 * issues are always Jira's answer to one load: never changed while waiting for the next.
 */

import { loadActiveIssues } from './weeklyWorklogService.js';

/**
 * @param {(state: { status: 'loading' | 'ready' | 'error', issues?: Array<object>, message?: string,
 *   includeRecentlyLogged?: boolean, refreshing?: true, refreshError?: string } | null) => void}
 *   onChange - Called with each new state; null when there's nothing to show. `refreshing`: the
 *   issues are the last ones loaded, kept while a newer load runs; `refreshError`: that load failed,
 *   so they're still the last ones loaded
 * @param {object} [options]
 * @param {(err: Error) => void} [options.logError=console.error] - Reports a failed load
 * @param {() => Date} [options.now] - The clock that ends the recently logged window
 * @returns {{ refresh: (client: object, options?: { force?: boolean, assignmentFields?: Array<{ id: string }>,
 *   includeRecentlyLogged?: boolean, keepShown?: boolean }) => Promise<void>, clear: () => void }}
 */
export function createWorkingIssuesLoader(onChange, { logError = (err) => console.error('Failed to load active issues:', err), now = () => new Date() } = {}) {
  // Load in flight, cancelled when a newer one starts: { controller, key }.
  let request = null;
  // What the issues shown were loaded for, once loaded; null while loading, after an error, or cleared.
  let shownKey = null;
  // The issues shown, once loaded, kept for a load with `keepShown`: { site, key, state }; null while
  // nothing loaded is shown (loading without keepShown, after an error, or cleared).
  let shown = null;

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
     * @param {boolean} [options.keepShown=false] - Keep the issues shown (the same Jira site's) while
     *   this load runs, and after it fails, instead of reporting `loading` or `error`
     */
    async refresh(client, { force = false, assignmentFields = [], includeRecentlyLogged = true, keepShown = false } = {}) {
      const site = `${client.deploymentType}|${client.baseUrl}`;
      const fieldsKey = assignmentFields.map((field) => field.id).join(',');
      const key = `${site}|${includeRecentlyLogged ? 'logged' : 'assigned'}${fieldsKey ? `|${fieldsKey}` : ''}`;
      if (!force && (request?.key === key || (!request && shownKey === key))) return;

      request?.controller.abort();
      const current = { controller: new AbortController(), key };
      request = current;
      shownKey = null;
      // The issues shown stay only for the same site; otherwise they go, as before.
      const previous = keepShown && shown?.site === site ? shown : null;
      shown = previous;

      onChange(previous ? { ...previous.state, refreshing: true } : { status: 'loading' });
      try {
        const issues = await loadActiveIssues(client, { now: now(), signal: current.controller.signal, assignmentFields, includeRecentlyLogged });
        if (current.controller.signal.aborted) return;
        const state = { status: 'ready', issues, includeRecentlyLogged };
        shownKey = key;
        shown = { site, key, state };
        onChange(state);
      } catch (err) {
        if (current.controller.signal.aborted) return;
        logError(err);
        const message = err.message || 'Unable to retrieve issues from Jira.';
        if (previous) {
          // Still the issues of the last load that worked.
          shownKey = previous.key;
          onChange({ ...previous.state, refreshError: message });
        } else {
          onChange({ status: 'error', message });
        }
      } finally {
        if (request === current) request = null;
      }
    },

    /** Cancels any load and reports that there's nothing to show. */
    clear() {
      request?.controller.abort();
      request = null;
      shownKey = null;
      shown = null;
      onChange(null);
    }
  };
}
