// Pin a timezone whose clocks change at midnight: Chile goes back one hour at the
// end of Saturday 4 April 2026, inside the week of Monday 30 March.
process.env.TZ = 'America/Santiago';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getWeekRange, buildEmptyWeek } from '../src/worklog/worklogUtils.js';
import {
  loadWeek,
  saveWorklogChanges,
  deleteWorklog,
  replaceWorklogInWeek,
  removeWorklogFromWeek
} from '../src/worklog/weeklyWorklogService.js';

describe('weekly worklog service', () => {
  it('returns Monday 00:00 to Sunday 23:59:59.999, even across a daylight-saving change', () => {
    const { monday, sunday } = getWeekRange(new Date(2026, 2, 30, 15, 30));

    assert.equal(monday.getDate(), 30);
    assert.equal(monday.getHours(), 0);
    assert.equal(sunday.getDate(), 5);
    assert.equal(sunday.getDay(), 0);
    assert.equal(sunday.getHours(), 23);
    assert.equal(sunday.getMilliseconds(), 999);

    // The old background calculation (Monday + 6 × 24h) lands on Saturday this week.
    assert.equal(new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000).getDay(), 6);
  });

  it('builds an empty week with zero totals', () => {
    const week = buildEmptyWeek(new Date(2026, 9, 19), new Date(2026, 9, 21));
    assert.equal(week.weekDays.length, 7);
    assert.equal(week.formattedWeekTotal, '0h 00m');
    assert.equal(week.weekDays[2].isToday, true);
  });

  it('fetches the week range from the client and aggregates by day', async () => {
    let requestedRange = null;
    const client = {
      async getWorklogsForDateRange(start, end) {
        requestedRange = { start, end };
        return {
          user: { displayName: 'Dev' },
          worklogs: [
            { id: '1', issueKey: 'A-1', started: '2026-10-20T10:00:00', timeSpentSeconds: 3600 },
            { id: '2', issueKey: 'A-2', started: '2026-10-25T09:00:00', timeSpentSeconds: 1800 }
          ]
        };
      }
    };

    const week = await loadWeek(client, { monday: new Date(2026, 9, 19, 12), now: new Date(2026, 9, 21) });

    assert.equal(requestedRange.start.getHours(), 0);
    assert.equal(requestedRange.end.getDate(), 25);
    assert.equal(week.user.displayName, 'Dev');
    assert.equal(week.formattedWeekTotal, '1h 30m');
    assert.equal(week.weekDays[1].worklogCount, 1);
    assert.equal(week.weekDays[6].worklogCount, 1);
  });
});

describe('weekly worklog service - editing', () => {
  const sourceWorklogs = [
    { id: '1', issueId: '100', issueKey: 'A-1', issueSummary: 'One', started: '2026-10-20T10:00:00', timeSpentSeconds: 3600, comment: { type: 'doc', content: [] } },
    { id: '2', issueId: '200', issueKey: 'A-2', issueSummary: 'Two', started: '2026-10-20T14:00:00', timeSpentSeconds: 1800, comment: 'Keep me' },
    { id: '3', issueId: '300', issueKey: 'A-3', issueSummary: 'Three', started: '2026-10-22T09:00:00', timeSpentSeconds: 5400 }
  ];
  const now = new Date(2026, 9, 21);
  const load = () => loadWeek({ async getWorklogsForDateRange() { return { user: {}, worklogs: sourceWorklogs }; } }, { monday: new Date(2026, 9, 19), now });

  it('keeps the source worklogs for editing', async () => {
    const week = await load();
    assert.equal(week.sourceWorklogs, sourceWorklogs);
  });

  it('saves through the client by issue and worklog ID, using the values Jira stored', async () => {
    const calls = [];
    const client = {
      async updateWorklog(issue, id, changes) {
        calls.push({ issue, id, changes });
        return { id, started: '2026-10-20T10:00:00.000-0300', timeSpentSeconds: 7200, timeSpent: '2h', comment: 'Keep me' };
      }
    };

    const updated = await saveWorklogChanges(client, sourceWorklogs[1], { timeSpentSeconds: 7200 });

    assert.deepEqual(calls, [{ issue: '200', id: '2', changes: { timeSpentSeconds: 7200 } }]);
    assert.equal(updated.id, '2');
    assert.equal(updated.issueKey, 'A-2');
    assert.equal(updated.timeSpentSeconds, 7200);
    assert.equal(updated.comment, 'Keep me');
  });

  it('keeps the comment Jira omits from the response when it was cleared', async () => {
    const client = { async updateWorklog() { return { id: '2' }; } };
    const updated = await saveWorklogChanges(client, sourceWorklogs[1], { comment: '' });
    assert.equal(updated.comment, '');
  });

  it('passes save errors through unchanged', async () => {
    const client = { async updateWorklog() { const e = new Error('No permission'); e.errorType = 'FORBIDDEN'; throw e; } };
    await assert.rejects(saveWorklogChanges(client, sourceWorklogs[0], { timeSpentSeconds: 60 }), /No permission/);
  });

  it('recalculates day totals, the week total, and counts after an update', async () => {
    const week = await load();
    assert.equal(week.weekDays[1].formattedTotal, '1h 30m');
    assert.equal(week.formattedWeekTotal, '3h 00m');

    const updated = replaceWorklogInWeek(week, { ...sourceWorklogs[1], timeSpentSeconds: 9000 }, now);

    assert.equal(updated.weekDays[1].formattedTotal, '3h 30m');
    assert.equal(updated.weekDays[1].worklogCount, 2);
    assert.equal(updated.formattedWeekTotal, '5h 00m');
    assert.equal(updated.totalWorklogsCount, 3);
    assert.equal(updated.weekDays[2].isToday, true);
    // The loaded week is not modified.
    assert.equal(week.formattedWeekTotal, '3h 00m');
  });

  it('moves an updated worklog to its new day, or out of the week', async () => {
    const week = await load();

    const moved = replaceWorklogInWeek(week, { ...sourceWorklogs[1], started: '2026-10-23T08:00:00' }, now);
    assert.equal(moved.weekDays[1].worklogCount, 1);
    assert.equal(moved.weekDays[4].worklogCount, 1);
    assert.equal(moved.weekDays[4].worklogs[0].id, '2');
    assert.equal(moved.formattedWeekTotal, '3h 00m');

    const left = replaceWorklogInWeek(week, { ...sourceWorklogs[1], started: '2026-10-27T08:00:00' }, now);
    assert.equal(left.totalWorklogsCount, 2);
    assert.equal(left.formattedWeekTotal, '2h 30m');
  });

  it('removes a deleted worklog and recalculates', async () => {
    const week = await load();
    const updated = removeWorklogFromWeek(week, '3', now);
    assert.equal(updated.weekDays[3].worklogCount, 0);
    assert.equal(updated.weekDays[3].formattedTotal, '0h 00m');
    assert.equal(updated.formattedWeekTotal, '1h 30m');
    assert.equal(updated.totalWorklogsCount, 2);
    assert.equal(updated.sourceWorklogs.length, 2);
  });

  it('deletes through the client by issue and worklog ID', async () => {
    const calls = [];
    await deleteWorklog({ async deleteWorklog(issue, id) { calls.push([issue, id]); } }, sourceWorklogs[2]);
    assert.deepEqual(calls, [['300', '3']]);
  });
});
