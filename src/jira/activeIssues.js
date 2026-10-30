/**
 * My Active Issues: the issues assigned to the user that are in progress, and the issues the user
 * logged work on in the selected week, whoever they're assigned to. Builds the JQL that finds both
 * in one search, and classifies what Jira returns. No DOM and no network access.
 *
 * In progress means the status category "In Progress" (key `indeterminate`), which every Jira
 * Cloud and Data Center / Server site has, whatever its status names.
 */

import { getLocalDateKey } from '../worklog/worklogUtils.js';
import { assignmentFieldClause } from './assignmentFields.js';

// Jira's key for the "In Progress" status category, as `status.statusCategory.key` returns it.
export const IN_PROGRESS_CATEGORY_KEY = 'indeterminate';

/**
 * Builds the JQL for the issues assigned to the current user that are in progress, or that the
 * current user logged work on between the given days. The days should include a buffer around
 * the week (see JiraClient.getActiveIssues()); which worklogs are really the user's and in the
 * week is checked afterwards.
 *
 * Additional assignment fields (src/jira/assignmentFields.js) also count as assigned:
 * `(assignee = currentUser() OR cf[10050] = currentUser())`. Without any, the query is unchanged.
 *
 * @param {string} firstDateKey - YYYY-MM-DD
 * @param {string} lastDateKey - YYYY-MM-DD
 * @param {string[]} [assignmentFieldIds] - Custom field IDs (`customfield_10050`)
 * @returns {string}
 */
export function buildActiveIssuesJql(firstDateKey, lastDateKey, assignmentFieldIds = []) {
  const assigned = ['assignee', ...assignmentFieldIds.map(assignmentFieldClause)]
    .map((clause) => `${clause} = currentUser()`);
  const assignedClause = assigned.length === 1 ? assigned[0] : `(${assigned.join(' OR ')})`;
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
 * Checks whether any worklog started on a day of the week, in local time, as the weekly view
 * groups worklogs.
 *
 * @param {Array<{ started?: string }>} worklogs
 * @param {string} startDateKey - First day of the week, YYYY-MM-DD
 * @param {string} endDateKey - Last day of the week, YYYY-MM-DD
 * @returns {boolean}
 */
export function hasWorklogInWeek(worklogs, startDateKey, endDateKey) {
  return worklogs.some((wl) => {
    const dateKey = wl?.started ? getLocalDateKey(new Date(wl.started)) : '';
    return dateKey >= startDateKey && dateKey <= endDateKey;
  });
}
