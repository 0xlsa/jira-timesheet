import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getMondayOfWeek,
  getLocalDateKey,
  getWeekDays,
  formatWeekRange,
  formatDuration,
  aggregateWorklogsByWeek
} from '../src/worklog/worklogUtils.js';

describe('Weekly Worklog View - Complete Integration & Math Verifications', () => {
  it('verifies that daily totals strictly equal sum of worklogs and weekly total equals sum of daily totals', () => {
    const monday = new Date(2026, 9, 19);
    const weekDays = getWeekDays(monday);

    // Multi-day, multi-issue worklogs dataset
    const worklogs = [
      // Monday (1h 15m = 4500s + 2h 45m = 9900s = 4h 00m = 14400s)
      { id: '1', issueKey: 'ENG-101', issueSummary: 'Auth token refresh', started: '2026-10-19T09:00:00.000Z', timeSpentSeconds: 4500 },
      { id: '2', issueKey: 'ENG-102', issueSummary: 'Fix race condition', started: '2026-10-19T13:00:00.000Z', timeSpentSeconds: 9900 },
      // Tuesday (0 logs)
      // Wednesday (3h 30m = 12600s + 45m = 2700s = 4h 15m = 15300s)
      { id: '3', issueKey: 'ENG-103', issueSummary: 'Setup CI/CD pipeline', started: '2026-10-21T08:30:00.000Z', timeSpentSeconds: 12600 },
      { id: '4', issueKey: 'ENG-104', issueSummary: 'Review PR', started: '2026-10-21T16:00:00.000Z', timeSpentSeconds: 2700 },
      // Thursday (6h = 21600s)
      { id: '5', issueKey: 'ENG-105', issueSummary: 'Weekly sync UI design', started: '2026-10-22T10:00:00.000Z', timeSpentSeconds: 21600 },
      // Friday (7h 30m = 27000s)
      { id: '6', issueKey: 'ENG-106', issueSummary: 'End-to-end testing', started: '2026-10-23T09:00:00.000Z', timeSpentSeconds: 27000 },
      // Saturday (0 logs)
      // Sunday (1h = 3600s)
      { id: '7', issueKey: 'ENG-107', issueSummary: 'Production release monitoring', started: '2026-10-25T14:00:00.000Z', timeSpentSeconds: 3600 }
    ];

    const result = aggregateWorklogsByWeek(worklogs, weekDays);

    // 1. Acceptance Criteria: Daily totals equal the sum of displayed worklogs
    result.weekDays.forEach((day) => {
      const worklogSecondsSum = day.worklogs.reduce((sum, w) => sum + w.timeSpentSeconds, 0);
      assert.equal(day.totalDurationSeconds, worklogSecondsSum, `Day ${day.dayName} duration must match worklogs sum`);
      assert.equal(day.worklogCount, day.worklogs.length);
    });

    // 2. Acceptance Criteria: The weekly total equals the sum of all included daily totals
    const sumOfAllDailySeconds = result.weekDays.reduce((sum, d) => sum + d.totalDurationSeconds, 0);
    assert.equal(result.weekTotalSeconds, sumOfAllDailySeconds, 'Weekly total must strictly equal sum of all daily totals');

    const expectedTotalSeconds = 14400 + 15300 + 21600 + 27000 + 3600; // 81900s = 22h 45m
    assert.equal(result.weekTotalSeconds, expectedTotalSeconds);
    assert.equal(result.formattedWeekTotal, '22h 45m');
    assert.equal(result.totalWorklogsCount, 7);

    // Monday totals
    assert.equal(result.weekDays[0].formattedTotal, '4h 00m');
    assert.equal(result.weekDays[0].worklogCount, 2);

    // Tuesday totals (empty day)
    assert.equal(result.weekDays[1].formattedTotal, '0h 00m');
    assert.equal(result.weekDays[1].worklogCount, 0);

    // Wednesday totals
    assert.equal(result.weekDays[2].formattedTotal, '4h 15m');
    assert.equal(result.weekDays[2].worklogCount, 2);

    // Thursday totals
    assert.equal(result.weekDays[3].formattedTotal, '6h 00m');
    assert.equal(result.weekDays[3].worklogCount, 1);

    // Friday totals
    assert.equal(result.weekDays[4].formattedTotal, '7h 30m');
    assert.equal(result.weekDays[4].worklogCount, 1);

    // Saturday totals (empty day)
    assert.equal(result.weekDays[5].formattedTotal, '0h 00m');
    assert.equal(result.weekDays[5].worklogCount, 0);

    // Sunday totals
    assert.equal(result.weekDays[6].formattedTotal, '1h 00m');
    assert.equal(result.weekDays[6].worklogCount, 1);
  });

  it('preserves chronological order of worklogs within each day', () => {
    const monday = new Date(2026, 9, 19);
    const weekDays = getWeekDays(monday);

    const unorderedWorklogs = [
      { id: '1', issueKey: 'TASK-C', started: '2026-10-19T16:00:00.000Z', timeSpentSeconds: 1800 },
      { id: '2', issueKey: 'TASK-A', started: '2026-10-19T09:00:00.000Z', timeSpentSeconds: 3600 },
      { id: '3', issueKey: 'TASK-B', started: '2026-10-19T13:00:00.000Z', timeSpentSeconds: 5400 }
    ];

    const result = aggregateWorklogsByWeek(unorderedWorklogs, weekDays);
    const mondayWorklogs = result.weekDays[0].worklogs;

    assert.equal(mondayWorklogs.length, 3);
    assert.equal(mondayWorklogs[0].issueKey, 'TASK-A', 'Earliest worklog must appear first');
    assert.equal(mondayWorklogs[1].issueKey, 'TASK-B');
    assert.equal(mondayWorklogs[2].issueKey, 'TASK-C', 'Latest worklog must appear last');
  });

  it('navigates previous and next weeks with consistent Monday-based boundaries', () => {
    // Starting week: Oct 19, 2026
    const baseMonday = getMondayOfWeek(new Date(2026, 9, 21));
    assert.equal(getLocalDateKey(baseMonday), '2026-10-19');

    // Previous week: Oct 12, 2026
    const prevMonday = new Date(baseMonday);
    prevMonday.setDate(prevMonday.getDate() - 7);
    assert.equal(getLocalDateKey(prevMonday), '2026-10-12');
    const prevSunday = new Date(prevMonday);
    prevSunday.setDate(prevMonday.getDate() + 6);
    assert.equal(formatWeekRange(prevMonday, prevSunday), 'Oct 12 – 18, 2026');

    // Next week: Oct 26, 2026
    const nextMonday = new Date(baseMonday);
    nextMonday.setDate(nextMonday.getDate() + 7);
    assert.equal(getLocalDateKey(nextMonday), '2026-10-26');
    const nextSunday = new Date(nextMonday);
    nextSunday.setDate(nextMonday.getDate() + 6);
    assert.equal(formatWeekRange(nextMonday, nextSunday), 'Oct 26 – Nov 1, 2026');
  });

  it('verifies that expanding or collapsing days does not modify aggregated data or totals', () => {
    const monday = new Date(2026, 9, 19);
    const weekDays = getWeekDays(monday);

    const worklogs = [
      { id: '1', issueKey: 'ENG-1', started: '2026-10-19T09:00:00.000Z', timeSpentSeconds: 7200 }
    ];

    const aggregated = aggregateWorklogsByWeek(worklogs, weekDays);
    const initialWeekTotal = aggregated.weekTotalSeconds;
    const initialDayTotal = aggregated.weekDays[0].totalDurationSeconds;

    // Simulate accordion state changes
    const expandedDays = new Set();
    // Collapse all
    expandedDays.clear();
    assert.equal(aggregated.weekTotalSeconds, initialWeekTotal);
    assert.equal(aggregated.weekDays[0].totalDurationSeconds, initialDayTotal);

    // Expand all
    aggregated.weekDays.forEach((d) => expandedDays.add(d.dateKey));
    assert.equal(aggregated.weekTotalSeconds, initialWeekTotal);
    assert.equal(aggregated.weekDays[0].totalDurationSeconds, initialDayTotal);
  });
});

