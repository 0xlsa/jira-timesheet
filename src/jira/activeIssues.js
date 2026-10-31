/**
 * My Active Issues: the issues assigned to the user that are in progress, and (unless turned off
 * with Show Recently Logged Issues) the issues the user logged work on recently, whoever they're
 * assigned to. Builds the JQL that finds both in one search, and classifies what Jira returns. No
 * DOM and no network access.
 *
 * In progress means the status category "In Progress" (key `indeterminate`), which every Jira
 * Cloud and Data Center / Server site has, whatever its status names.
 */

import { assignmentFieldClause } from './assignmentFields.js';

// Jira's key for the "In Progress" status category, as `status.statusCategory.key` returns it.
export const IN_PROGRESS_CATEGORY_KEY = 'indeterminate';

// How far back "recently logged" reaches: a rolling window ending now, not calendar weeks.
export const RECENTLY_LOGGED_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The window in which the user's worklogs make an issue "recently logged": the last
 * RECENTLY_LOGGED_DAYS days to the millisecond, ending now.
 *
 * @param {Date} [now=new Date()]
 * @returns {{ since: Date, until: Date }}
 */
export function recentlyLoggedWindow(now = new Date()) {
  return { since: new Date(now.getTime() - RECENTLY_LOGGED_DAYS * DAY_MS), until: new Date(now.getTime()) };
}

/**
 * Builds the JQL for the issues assigned to the current user that are in progress, or that the
 * current user logged work on between the given days. The days should include a buffer around
 * the range (see JiraClient.getActiveIssues()); which worklogs are really the user's and in the
 * range is checked afterwards. Without `includeLogged`, only the assigned issues are searched.
 *
 * Additional assignment fields (src/jira/assignmentFields.js) also count as assigned:
 * `(assignee = currentUser() OR cf[10050] = currentUser())`. Without any, the query is unchanged.
 *
 * @param {string} firstDateKey - YYYY-MM-DD
 * @param {string} lastDateKey - YYYY-MM-DD
 * @param {string[]} [assignmentFieldIds] - Custom field IDs (`customfield_10050`)
 * @param {object} [options]
 * @param {boolean} [options.includeLogged=true] - Also find the issues the user logged work on
 * @returns {string}
 */
export function buildActiveIssuesJql(firstDateKey, lastDateKey, assignmentFieldIds = [], { includeLogged = true } = {}) {
  const assigned = ['assignee', ...assignmentFieldIds.map(assignmentFieldClause)]
    .map((clause) => `${clause} = currentUser()`);
  const assignedClause = assigned.length === 1 ? assigned[0] : `(${assigned.join(' OR ')})`;
  if (!includeLogged) return `${assignedClause} AND statusCategory = "In Progress" ORDER BY updated DESC`;
  return `(${assignedClause} AND statusCategory = "In Progress") OR ` +
    `(worklogAuthor = currentUser() AND worklogDate >= "${firstDateKey}" AND worklogDate <= "${lastDateKey}") ORDER BY updated DESC`;
}

/**
 * @param {{ categoryKey?: string } | null} issueStatus - From toIssueStatus()
 * @returns {boolean}
 */
export function isInProgress(issueStatus) {
  return issueStatus?.categoryKey === IN_PROGRESS_CATEGORY_KEY;
}

/**
 * Checks whether any worklog started between two instants, both included. A whole week is Monday
 * 00:00 to Sunday 23:59:59.999 local time (getWeekRange()), as the weekly view groups worklogs;
 * the recently logged window is recentlyLoggedWindow().
 *
 * @param {Array<{ started?: string }>} worklogs
 * @param {Date} since
 * @param {Date} until
 * @returns {boolean}
 */
export function hasWorklogBetween(worklogs, since, until) {
  return worklogs.some((wl) => {
    const started = wl?.started ? new Date(wl.started).getTime() : NaN;
    return started >= since.getTime() && started <= until.getTime();
  });
}
