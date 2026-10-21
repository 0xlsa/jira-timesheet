// Pin a timezone whose clocks change at midnight: Chile goes back one hour at the
// end of Saturday 4 April 2026, inside the week of Monday 30 March.
process.env.TZ = 'America/Santiago';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getWeekRange, buildEmptyWeek } from '../src/worklog/worklogUtils.js';
import { loadWeek } from '../src/worklog/weeklyWorklogService.js';

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
