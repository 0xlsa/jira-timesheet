import { getWeekRange, getWeekDays, aggregateWorklogsByWeek } from './worklogUtils.js';

/**
 * Fetches the current user's worklogs for one week and aggregates them by day.
 *
 * @param {{ getWorklogsForDateRange: Function }} client - JiraClient (or a test double)
 * @param {object} week
 * @param {Date} week.monday - First day of the week
 * @param {Date} [week.sunday] - Last day of the week (defaults to the Sunday after `monday`)
 * @param {Date} [week.now=new Date()] - Reference used to mark "today"
 * @returns {Promise<{ user: object } & ReturnType<typeof aggregateWorklogsByWeek>>}
 */
export async function loadWeek(client, { monday, sunday, now = new Date() }) {
  const range = getWeekRange(monday);
  const end = sunday ?? range.sunday;

  const result = await client.getWorklogsForDateRange(range.monday, end);
  const aggregated = aggregateWorklogsByWeek(result.worklogs, getWeekDays(range.monday, now));

  return { user: result.user, ...aggregated };
}
