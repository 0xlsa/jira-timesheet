import { getWeekRange, getWeekDays, aggregateWorklogsByWeek } from './worklogUtils.js';

/**
 * Fetches the current user's worklogs for one week and aggregates them by day.
 *
 * @param {{ getWorklogsForDateRange: Function }} client - JiraClient (or a test double)
 * @param {object} week
 * @param {Date} week.monday - First day of the week
 * @param {Date} [week.sunday] - Last day of the week (defaults to the Sunday after `monday`)
 * @param {Date} [week.now=new Date()] - Reference used to mark "today"
 * @returns {Promise<{ user: object, sourceWorklogs: Array<object> } & ReturnType<typeof aggregateWorklogsByWeek>>}
 *   `sourceWorklogs` keeps the worklogs as Jira returned them (raw comment and start time) for editing.
 */
export async function loadWeek(client, { monday, sunday, now = new Date() }) {
  const range = getWeekRange(monday);
  const end = sunday ?? range.sunday;

  const result = await client.getWorklogsForDateRange(range.monday, end);
  const aggregated = aggregateWorklogsByWeek(result.worklogs, getWeekDays(range.monday, now));

  return { user: result.user, sourceWorklogs: result.worklogs, ...aggregated };
}

/**
 * Fetches the issues for My Active Issues in one week: those assigned to the current user that
 * are in progress, or that have work logged in the week. Independent of loadWeek(): one failing
 * doesn't affect the other.
 *
 * @param {{ getActiveIssues: Function }} client - JiraClient (or a test double)
 * @param {object} week
 * @param {Date} week.monday - First day of the week
 * @param {Date} [week.sunday] - Last day of the week (defaults to the Sunday after `monday`)
 * @param {AbortSignal} [week.signal] - Cancels the requests
 * @param {Array<{ id: string }>} [week.assignmentFields] - Additional assignment fields; none by default
 * @returns {Promise<Array<object>>} From JiraClient.getActiveIssues()
 */
export async function loadActiveIssues(client, { monday, sunday, signal, assignmentFields = [] }) {
  const range = getWeekRange(monday);
  return client.getActiveIssues(range.monday, sunday ?? range.sunday,
    assignmentFields.length ? { signal, assignmentFields } : { signal });
}

/**
 * Re-aggregates a loaded week from a new list of source worklogs, keeping its user and days.
 *
 * @param {object} week - From loadWeek()
 * @param {Array<object>} sourceWorklogs
 * @param {Date} now
 */
function rebuildWeek(week, sourceWorklogs, now) {
  const aggregated = aggregateWorklogsByWeek(sourceWorklogs, getWeekDays(week.weekDays[0].date, now));
  return { ...week, sourceWorklogs, ...aggregated };
}

/**
 * Returns the week with one worklog replaced by its updated version. Day totals, the week
 * total, and counts are recalculated; a worklog moved to another week drops out.
 *
 * @param {object} week - From loadWeek()
 * @param {object} updatedWorklog - Source worklog with the same `id`
 * @param {Date} [now=new Date()]
 */
export function replaceWorklogInWeek(week, updatedWorklog, now = new Date()) {
  const id = String(updatedWorklog.id);
  const others = (week.sourceWorklogs || []).filter((wl) => String(wl.id) !== id);
  return rebuildWeek(week, [...others, updatedWorklog], now);
}

/**
 * Returns the week without the given worklog, with totals and counts recalculated.
 *
 * @param {object} week - From loadWeek()
 * @param {string} worklogId
 * @param {Date} [now=new Date()]
 */
export function removeWorklogFromWeek(week, worklogId, now = new Date()) {
  const id = String(worklogId);
  return rebuildWeek(week, (week.sourceWorklogs || []).filter((wl) => String(wl.id) !== id), now);
}

/**
 * Saves worklog changes to Jira and returns the source worklog updated with the values
 * Jira stored, so the view matches Jira without reloading the week.
 *
 * @param {{ updateWorklog: Function }} client
 * @param {object} worklog - Source worklog (from `week.sourceWorklogs`)
 * @param {{ started?: Date, timeSpentSeconds?: number, comment?: string }} changes
 * @returns {Promise<object>}
 */
export async function saveWorklogChanges(client, worklog, changes) {
  const saved = await client.updateWorklog(worklog.issueId || worklog.issueKey, worklog.id, changes) || {};

  return {
    ...worklog,
    started: saved.started ?? (changes.started ? changes.started.toISOString() : worklog.started),
    timeSpentSeconds: Number(saved.timeSpentSeconds ?? changes.timeSpentSeconds ?? worklog.timeSpentSeconds) || 0,
    timeSpent: saved.timeSpent ?? worklog.timeSpent,
    // Jira omits an empty comment from the response.
    comment: saved.comment !== undefined ? saved.comment : (changes.comment !== undefined ? changes.comment : worklog.comment)
  };
}

/**
 * Logs new work on an issue and returns it as a source worklog, ready to add to the week
 * with replaceWorklogInWeek().
 *
 * @param {{ createWorklog: Function }} client
 * @param {{ issueId?: string, issueKey: string, issueSummary?: string, issueStatus?: object }} issue
 * @param {{ started: Date, timeSpentSeconds: number, comment?: string }} worklog
 * @param {object} [author] - Shown when Jira's response has no author (the current user)
 * @returns {Promise<object>}
 */
export async function logWork(client, issue, worklog, author) {
  const saved = await client.createWorklog(issue.issueId || issue.issueKey, worklog) || {};

  return {
    id: String(saved.id),
    issueId: issue.issueId,
    issueKey: issue.issueKey,
    issueSummary: issue.issueSummary,
    issueStatus: issue.issueStatus,
    started: saved.started ?? worklog.started.toISOString(),
    timeSpentSeconds: Number(saved.timeSpentSeconds ?? worklog.timeSpentSeconds) || 0,
    timeSpent: saved.timeSpent ?? '',
    comment: saved.comment !== undefined ? saved.comment : worklog.comment,
    author: saved.author ?? author
  };
}

/**
 * Deletes a worklog in Jira.
 *
 * @param {{ deleteWorklog: Function }} client
 * @param {object} worklog - Source worklog
 * @returns {Promise<void>}
 */
export async function deleteWorklog(client, worklog) {
  await client.deleteWorklog(worklog.issueId || worklog.issueKey, worklog.id);
}
