import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getMondayOfWeek,
  getLocalDateKey,
  getWeekDays,
  formatWeekRange,
  formatDuration,
  parseWorklogComment,
  aggregateWorklogsByWeek
} from '../src/worklog/worklogUtils.js';

describe('WorklogUtils - Date & Week Boundaries', () => {
  it('correctly finds the Monday of a week for any given day', () => {
    // 2026-10-21 is Wednesday
    const wednesday = new Date(2026, 9, 21, 14, 30, 0); // October is month 9 (0-indexed)
    const monday = getMondayOfWeek(wednesday);

    assert.equal(monday.getDay(), 1, 'Should be Monday (day 1)');
    assert.equal(monday.getDate(), 19, 'Should be October 19');
    assert.equal(monday.getMonth(), 9, 'Should be October');
    assert.equal(monday.getFullYear(), 2026);
    assert.equal(monday.getHours(), 0);
    assert.equal(monday.getMinutes(), 0);
  });

  it('correctly handles Sunday (boundary of week)', () => {
    // 2026-10-25 is Sunday
    const sunday = new Date(2026, 9, 25, 23, 59, 0);
    const monday = getMondayOfWeek(sunday);

    assert.equal(monday.getDay(), 1);
    assert.equal(monday.getDate(), 19, 'Sunday Oct 25 belongs to Monday Oct 19 week');
  });

  it('correctly handles Monday itself', () => {
    const mondayDate = new Date(2026, 9, 19, 8, 0, 0);
    const monday = getMondayOfWeek(mondayDate);

    assert.equal(monday.getDay(), 1);
    assert.equal(monday.getDate(), 19);
  });

  it('correctly handles month boundaries (e.g., late October into November)', () => {
    // 2026-11-01 is Sunday
    const sundayNov1 = new Date(2026, 10, 1, 12, 0, 0);
    const monday = getMondayOfWeek(sundayNov1);

    assert.equal(monday.getDay(), 1);
    assert.equal(monday.getMonth(), 9, 'Should be October');
    assert.equal(monday.getDate(), 26, 'Should be October 26');
  });

  it('formats local date keys correctly', () => {
    const d = new Date(2026, 9, 5);
    assert.equal(getLocalDateKey(d), '2026-10-05');
  });

  it('generates 7 days for a week starting from Monday', () => {
    const monday = new Date(2026, 9, 19);
    const days = getWeekDays(monday, new Date(2026, 9, 21));

    assert.equal(days.length, 7);
    assert.equal(days[0].dayName, 'Monday');
    assert.equal(days[0].dateKey, '2026-10-19');
    assert.equal(days[0].isToday, false);

    assert.equal(days[2].dayName, 'Wednesday');
    assert.equal(days[2].dateKey, '2026-10-21');
    assert.equal(days[2].isToday, true);

    assert.equal(days[6].dayName, 'Sunday');
    assert.equal(days[6].dateKey, '2026-10-25');
  });

  it('formats week date ranges cleanly', () => {
    const monSameMonth = new Date(2026, 9, 19);
    const sunSameMonth = new Date(2026, 9, 25);
    assert.equal(formatWeekRange(monSameMonth, sunSameMonth), 'Oct 19 – 25, 2026');

    const monDiffMonth = new Date(2026, 9, 26);
    const sunDiffMonth = new Date(2026, 10, 1);
    assert.equal(formatWeekRange(monDiffMonth, sunDiffMonth), 'Oct 26 – Nov 1, 2026');

    const monDiffYear = new Date(2025, 11, 29);
    const sunDiffYear = new Date(2026, 0, 4);
    assert.equal(formatWeekRange(monDiffYear, sunDiffYear), 'Dec 29, 2025 – Jan 4, 2026');
  });
});

describe('WorklogUtils - Duration Formatting', () => {
  it('formats seconds into hours and minutes correctly', () => {
    assert.equal(formatDuration(0), '0m');
    assert.equal(formatDuration(1800), '30m');
    assert.equal(formatDuration(3600), '1h');
    assert.equal(formatDuration(3660), '1h 1m');
    assert.equal(formatDuration(5400), '1h 30m');
    assert.equal(formatDuration(28800), '8h');
    assert.equal(formatDuration(29700), '8h 15m');
  });

  it('supports padding zero minutes and always showing hours', () => {
    assert.equal(formatDuration(3660, { padZeroMinutes: true }), '1h 01m');
    assert.equal(formatDuration(3600, { padZeroMinutes: true }), '1h 00m');
    assert.equal(formatDuration(1800, { alwaysShowHours: true, padZeroMinutes: true }), '0h 30m');
    assert.equal(formatDuration(0, { zeroLabel: '0h 00m' }), '0h 00m');
  });
});

describe('WorklogUtils - Comment Parsing', () => {
  it('handles plain string comments', () => {
    assert.equal(parseWorklogComment('Investigated API token auth'), 'Investigated API token auth');
    assert.equal(parseWorklogComment(''), '');
    assert.equal(parseWorklogComment(null), '');
  });

  it('handles Atlassian Document Format (ADF) object comments', () => {
    const adf = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Implemented ' },
            { type: 'text', text: 'weekly calendar view.' }
          ]
        }
      ]
    };
    assert.equal(parseWorklogComment(adf), 'Implemented weekly calendar view.');
  });
});

describe('WorklogUtils - Aggregation & Math Correctness', () => {
  it('correctly aggregates worklogs into days and calculates exact weekly totals', () => {
    const monday = new Date(2026, 9, 19);
    const weekDays = getWeekDays(monday);

    const rawWorklogs = [
      {
        id: '101',
        issueKey: 'DEV-10',
        issueSummary: 'Fix session token validation',
        started: '2026-10-19T09:00:00.000Z',
        timeSpentSeconds: 3600 // 1h
      },
      {
        id: '102',
        issueKey: 'DEV-11',
        issueSummary: 'Implement calendar UI',
        started: '2026-10-19T13:30:00.000Z',
        timeSpentSeconds: 7200 // 2h
      },
      {
        id: '103',
        issueKey: 'DEV-12',
        issueSummary: 'Unit test worklog parser',
        started: '2026-10-21T10:00:00.000Z',
        timeSpentSeconds: 5400 // 1h 30m
      },
      // Worklog outside the week (Oct 28) - should be excluded
      {
        id: '104',
        issueKey: 'DEV-13',
        issueSummary: 'Future task',
        started: '2026-10-28T10:00:00.000Z',
        timeSpentSeconds: 3600
      }
    ];

    const result = aggregateWorklogsByWeek(rawWorklogs, weekDays);

    // Week totals check
    assert.equal(result.totalWorklogsCount, 3);
    assert.equal(result.weekTotalSeconds, 3600 + 7200 + 5400); // 16200s = 4h 30m
    assert.equal(result.formattedWeekTotal, '4h 30m');
    assert.equal(result.hasAnyWorklogs, true);

    // Monday check (2 worklogs: 1h + 2h = 3h)
    const mon = result.weekDays[0];
    assert.equal(mon.worklogCount, 2);
    assert.equal(mon.totalDurationSeconds, 10800);
    assert.equal(mon.formattedTotal, '3h 00m');
    assert.equal(mon.worklogs[0].issueKey, 'DEV-10');
    assert.equal(mon.worklogs[1].issueKey, 'DEV-11');

    // Wednesday check (1 worklog: 1h 30m)
    const wed = result.weekDays[2];
    assert.equal(wed.worklogCount, 1);
    assert.equal(wed.totalDurationSeconds, 5400);
    assert.equal(wed.formattedTotal, '1h 30m');

    // Tuesday check (0 worklogs)
    const tue = result.weekDays[1];
    assert.equal(tue.worklogCount, 0);
    assert.equal(tue.totalDurationSeconds, 0);
    assert.equal(tue.formattedTotal, '0h 00m');

    // Mathematical invariant: Weekly total seconds MUST equal sum of all daily total seconds
    const sumDailySeconds = result.weekDays.reduce((sum, d) => sum + d.totalDurationSeconds, 0);
    assert.equal(sumDailySeconds, result.weekTotalSeconds);

    // Mathematical invariant: Daily total seconds MUST equal sum of its worklogs' seconds
    result.weekDays.forEach((d) => {
      const sumWlSeconds = d.worklogs.reduce((sum, w) => sum + w.timeSpentSeconds, 0);
      assert.equal(sumWlSeconds, d.totalDurationSeconds);
    });
  });

  it('deduplicates identical worklog IDs to prevent double-counting', () => {
    const monday = new Date(2026, 9, 19);
    const weekDays = getWeekDays(monday);

    const rawWorklogs = [
      {
        id: '101',
        issueKey: 'DEV-1',
        started: '2026-10-19T09:00:00.000Z',
        timeSpentSeconds: 3600
      },
      {
        id: '101', // Duplicate ID
        issueKey: 'DEV-1',
        started: '2026-10-19T09:00:00.000Z',
        timeSpentSeconds: 3600
      }
    ];

    const result = aggregateWorklogsByWeek(rawWorklogs, weekDays);
    assert.equal(result.totalWorklogsCount, 1);
    assert.equal(result.weekTotalSeconds, 3600);
  });

  it('handles empty week gracefully with all 7 days present', () => {
    const monday = new Date(2026, 9, 19);
    const weekDays = getWeekDays(monday);

    const result = aggregateWorklogsByWeek([], weekDays);
    assert.equal(result.hasAnyWorklogs, false);
    assert.equal(result.totalWorklogsCount, 0);
    assert.equal(result.weekTotalSeconds, 0);
    assert.equal(result.formattedWeekTotal, '0h 00m');
    assert.equal(result.weekDays.length, 7);

    result.weekDays.forEach((d) => {
      assert.equal(d.worklogCount, 0);
      assert.equal(d.totalDurationSeconds, 0);
      assert.equal(d.formattedTotal, '0h 00m');
      assert.deepEqual(d.worklogs, []);
    });
  });
});

describe('WorklogUtils - Issue status', () => {
  it('passes the issue status through and drops empty statuses', () => {
    const weekDays = getWeekDays(new Date(2026, 9, 19));
    const result = aggregateWorklogsByWeek([
      { id: '1', issueKey: 'A-1', started: '2026-10-19T09:00:00', timeSpentSeconds: 60, issueStatus: { name: 'Done', categoryKey: 'done' } },
      { id: '2', issueKey: 'A-2', started: '2026-10-19T10:00:00', timeSpentSeconds: 60 },
      { id: '3', issueKey: 'A-3', started: '2026-10-19T11:00:00', timeSpentSeconds: 60, issueStatus: { name: '' } }
    ], weekDays);

    const [first, second, third] = result.weekDays[0].worklogs;
    assert.deepEqual(first.issueStatus, { name: 'Done', categoryKey: 'done' });
    assert.equal(second.issueStatus, null);
    assert.equal(third.issueStatus, null);
    assert.equal(result.weekTotalSeconds, 180);
  });
});

describe('WorklogUtils - Worklog duration badge', () => {
  it('always shows hours and two-digit minutes', () => {
    const weekDays = getWeekDays(new Date(2026, 9, 19));
    const durations = [3600, 2700, 5400, 300, 45900, 0];
    const result = aggregateWorklogsByWeek(
      durations.map((seconds, i) => ({ id: String(i), issueKey: 'A-1', started: `2026-10-19T0${i}:00:00`, timeSpentSeconds: seconds })),
      weekDays
    );

    assert.deepEqual(
      result.weekDays[0].worklogs.map((wl) => wl.formattedDuration),
      ['1h 00m', '0h 45m', '1h 30m', '0h 05m', '12h 45m', '0h 00m']
    );
  });
});

