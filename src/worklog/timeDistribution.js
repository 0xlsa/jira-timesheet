/**
 * Time by Jira issue, for the selected day's Summary tab and the Weekly Summary: worklogs
 * (aggregateWorklogsByWeek()'s), grouped by issue, each issue's total time and its share of the
 * whole. Read-only: the worklogs themselves are left as they are.
 */

import { formatDuration } from './worklogUtils.js';

// aggregateWorklogsByWeek()'s summary for a worklog without one: any other worklog's is better.
const NO_SUMMARY = 'No summary available';

/** A worklog's duration in whole seconds: 0 for anything that isn't a positive number. */
function secondsOf(worklog) {
  const seconds = Number(worklog?.timeSpentSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0;
}

/**
 * Whole percentages for these amounts that add up to 100 (the largest remainder method): each
 * share rounded down, then the points left over go one each to the largest remainders, the
 * earlier amount first on a tie. All 0 when the amounts add up to nothing.
 * @param {number[]} amounts - Non-negative
 * @returns {number[]}
 */
export function wholePercentages(amounts) {
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  if (!(total > 0)) return amounts.map(() => 0);
  const exact = amounts.map((amount) => (amount / total) * 100);
  const percentages = exact.map(Math.floor);
  let left = 100 - percentages.reduce((sum, p) => sum + p, 0);
  const byRemainder = exact.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder) {
    if (left <= 0) break;
    percentages[index] += 1;
    left -= 1;
  }
  return percentages;
}

/**
 * Worklogs (a day's or a week's) grouped by Jira issue key (by issue ID when a worklog has no
 * key, and all of those with neither together), the issue with the most time first and, on a
 * tie, the one logged first. A worklog with no valid duration counts as 0.
 *
 * @param {Array<object>} worklogs - A day's or a week's worklogs, from aggregateWorklogsByWeek()
 * @returns {{
 *   issues: Array<{ id: string, issueKey: string, issueSummary: string, seconds: number, formattedDuration: string, percent: number }>,
 *   totalSeconds: number
 * }}
 */
export function summarizeByIssue(worklogs) {
  const groups = new Map();
  for (const worklog of Array.isArray(worklogs) ? worklogs : []) {
    if (!worklog) continue;
    const issueKey = String(worklog.issueKey ?? '').trim();
    const id = issueKey || (worklog.issueId ? `id:${worklog.issueId}` : '');
    const summary = String(worklog.issueSummary ?? '').trim();
    const group = groups.get(id) ?? { id, issueKey, issueSummary: '', seconds: 0, order: groups.size };
    if (summary && summary !== NO_SUMMARY && !group.issueSummary) group.issueSummary = summary;
    group.seconds += secondsOf(worklog);
    groups.set(id, group);
  }

  const sorted = [...groups.values()].sort((a, b) => b.seconds - a.seconds || a.order - b.order);
  const percentages = wholePercentages(sorted.map((group) => group.seconds));
  return {
    issues: sorted.map(({ id, issueKey, issueSummary, seconds }, index) => ({
      id,
      issueKey,
      issueSummary: issueSummary || NO_SUMMARY,
      seconds,
      formattedDuration: formatDuration(seconds, { padZeroMinutes: true, alwaysShowHours: true }),
      percent: percentages[index]
    })),
    totalSeconds: sorted.reduce((sum, group) => sum + group.seconds, 0)
  };
}
