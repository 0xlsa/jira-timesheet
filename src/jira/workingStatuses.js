/**
 * Working issues: the statuses an issue assigned to the user is listed in, matched against the
 * statuses a Jira site has, and the JQL that finds those issues. No DOM and no network access.
 *
 * Statuses are matched by name, because status IDs differ from one Jira site to the next. A name
 * is only put in JQL once the site's status list (`GET /status`) has it: both Jira Cloud and
 * Data Center / Server reject a search for a status that doesn't exist.
 */

// Statuses listed in My Active Issues, by name. Letter case and surrounding spaces don't matter.
export const WORKING_STATUS_NAMES = ['In Progress'];

/**
 * Picks the working statuses that exist on a Jira site, under the site's own spelling.
 *
 * @param {Array<object>} statuses - From `GET /status`
 * @param {string[]} [wantedNames=WORKING_STATUS_NAMES]
 * @returns {{ names: string[] } | { reason: string }} The names to search for, or why there are none
 */
export function selectWorkingStatuses(statuses, wantedNames = WORKING_STATUS_NAMES) {
  const siteNames = new Map();
  for (const status of Array.isArray(statuses) ? statuses : []) {
    const name = typeof status?.name === 'string' ? status.name.trim() : '';
    // Jira can have several statuses with one name (one per project); JQL matches them all by name.
    if (name && !siteNames.has(name.toLowerCase())) siteNames.set(name.toLowerCase(), name);
  }

  const names = wantedNames.map((name) => siteNames.get(name.trim().toLowerCase())).filter(Boolean);
  if (names.length > 0) return { names };

  return {
    reason: `This Jira site has no status named ${wantedNames.join(' or ')}. My Active Issues lists ` +
      'the issues assigned to you in that status.'
  };
}

/**
 * Quotes a value for JQL.
 * @param {string} value
 * @returns {string}
 */
function jqlString(value) {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/**
 * Builds the JQL for the issues assigned to the current user in the given statuses, most
 * recently updated first.
 *
 * @param {string[]} statusNames - As the site spells them (selectWorkingStatuses())
 * @returns {string}
 */
export function buildWorkingIssuesJql(statusNames) {
  return `assignee = currentUser() AND status in (${statusNames.map(jqlString).join(', ')}) ORDER BY updated DESC`;
}
