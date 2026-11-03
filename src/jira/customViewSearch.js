/**
 * The results of custom views' own Jira searches (src/jira/customViews.js), kept in memory for the
 * page: never stored, and apart from the Active view's issues (src/worklog/workingIssuesLoader.js),
 * which never sees them.
 *
 * Results are kept by key, the Jira site and the view's JQL, so editing a view's condition gives it
 * a new key (and new results) while renaming it keeps them. A view is searched when the page asks
 * for it (shown), once: asking again while it loads, or once it has loaded or failed, does nothing.
 * refresh() searches again (Retry, Sync), clear() forgets everything, and retain() forgets
 * the keys no view has any more. A search that's replaced or forgotten is cancelled, and its answer,
 * even a late one, is never shown.
 *
 * No DOM: the page renders the results through `onChange`.
 */

/**
 * @param {() => void} onChange - Called after a search finishes or fails; never during load(),
 *   refresh(), retain(), or clear()
 * @param {object} [options]
 * @param {(err: Error) => void} [options.logError=console.error] - Reports a failed search
 * @returns {{
 *   get: (key: string) => { status: 'loading' | 'ready' | 'error', issues: Array<object>, total: number | null,
 *     hasMore: boolean, message: string } | null,
 *   load: (key: string, search: Search) => void,
 *   refresh: (key: string, search: Search) => void,
 *   retain: (keys: Iterable<string>) => void,
 *   clear: () => void
 * }}
 *
 * @typedef {(signal: AbortSignal) => Promise<{ issues: Array<object>, total: number | null, hasMore: boolean }>} Search
 *   Runs a view's search (JiraClient.searchCustomViewIssues())
 */
export function createCustomViewSearch(onChange, { logError = (err) => console.error('Failed to search a custom view:', err) } = {}) {
  // key → { status, issues, total, hasMore, message, controller }
  const entries = new Map();

  /** Starts a key's search, replacing (and cancelling) the one it had. */
  function start(key, search) {
    entries.get(key)?.controller.abort();
    const controller = new AbortController();
    const entry = { status: 'loading', issues: [], total: null, hasMore: false, message: '', controller };
    entries.set(key, entry);
    const current = () => entries.get(key) === entry && !controller.signal.aborted;

    Promise.resolve()
      .then(() => search(controller.signal))
      .then((result) => {
        if (!current()) return;
        entry.status = 'ready';
        entry.issues = Array.isArray(result?.issues) ? result.issues : [];
        entry.total = typeof result?.total === 'number' ? result.total : null;
        entry.hasMore = result?.hasMore === true;
        onChange();
      }, (err) => {
        if (!current()) return;
        logError(err);
        entry.status = 'error';
        entry.message = err?.message || "Couldn't search Jira for this view.";
        onChange();
      });
  }

  return {
    /** A key's results; null when it hasn't been searched (or was forgotten). */
    get(key) {
      const entry = entries.get(key);
      return entry
        ? { status: entry.status, issues: entry.issues, total: entry.total, hasMore: entry.hasMore, message: entry.message }
        : null;
    },

    /** Searches a key unless it's loading, loaded, or failed already. */
    load(key, search) {
      if (!entries.has(key)) start(key, search);
    },

    /** Searches a key again, cancelling a search in progress. */
    refresh(key, search) {
      start(key, search);
    },

    /** Forgets every key but these, cancelling their searches. */
    retain(keys) {
      const kept = new Set(keys);
      for (const [key, entry] of entries) {
        if (kept.has(key)) continue;
        entry.controller.abort();
        entries.delete(key);
      }
    },

    /** Forgets every key, cancelling their searches. */
    clear() {
      for (const entry of entries.values()) entry.controller.abort();
      entries.clear();
    }
  };
}
