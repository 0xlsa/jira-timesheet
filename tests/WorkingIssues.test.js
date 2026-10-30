process.env.TZ = 'Europe/London';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument, toHtml } from './support/fakeDom.js';
import { buildActiveIssuesJql, isInProgress, hasWorklogInWeek } from '../src/jira/activeIssues.js';
import { JiraClient } from '../src/jira/JiraClient.js';
import { JiraCloudTokenProvider } from '../src/auth/JiraCloudTokenProvider.js';
import { JiraPatProvider } from '../src/auth/JiraPatProvider.js';
import { loadActiveIssues, logWork } from '../src/worklog/weeklyWorklogService.js';
import { openWorklogEditor } from '../src/ui/worklogEditor.js';
import { toNewWorklogForm } from '../src/worklog/worklogEdit.js';
import { createWorkingIssuesLoader } from '../src/worklog/workingIssuesLoader.js';
import { renderWeek, renderWorkingIssues } from '../src/ui/weekView.js';
import { h } from '../src/ui/dom.js';
import { buildEmptyWeek, getWeekRange } from '../src/worklog/worklogUtils.js';

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// The selected week in these tests: Monday 26 October to Sunday 1 November 2026. Europe/London is
// on GMT (UTC+0) that week; summer time ended on Sunday 25 October.
const WEEK = getWeekRange(new Date(2026, 9, 26));

describe('Active issues - query and checks', () => {
  it('finds in-progress issues assigned to the current user and issues with their worklogs in the buffered days, in one query', () => {
    assert.equal(buildActiveIssuesJql('2026-10-25', '2026-11-02'),
      '(assignee = currentUser() AND statusCategory = "In Progress") OR ' +
      '(worklogAuthor = currentUser() AND worklogDate >= "2026-10-25" AND worklogDate <= "2026-11-02") ORDER BY updated DESC');
  });

  it('treats any status in the In Progress category as in progress, whatever its name', () => {
    assert.equal(isInProgress({ name: 'In Progress', categoryKey: 'indeterminate' }), true);
    assert.equal(isInProgress({ name: 'In Review', categoryKey: 'indeterminate' }), true);
    assert.equal(isInProgress({ name: 'Done', categoryKey: 'done' }), false);
    assert.equal(isInProgress({ name: 'To Do', categoryKey: 'new' }), false);
    assert.equal(isInProgress({ name: 'Waiting', categoryKey: '' }), false);
    assert.equal(isInProgress(null), false);
  });

  it('checks worklogs by their local start date, inclusive at both ends of the week', () => {
    const inWeek = (started) => hasWorklogInWeek([{ started }], '2026-10-26', '2026-11-01');
    assert.equal(inWeek('2026-10-26T00:00:00.000+0000'), true, 'Monday at midnight');
    assert.equal(inWeek('2026-11-01T23:59:00.000+0000'), true, 'Sunday just before midnight');
    assert.equal(inWeek('2026-10-25T23:59:00.000+0000'), false, 'the Sunday before');
    assert.equal(inWeek('2026-11-02T00:00:00.000+0000'), false, 'the Monday after');
    // Jira gives the worklog's own offset; the day is the one it falls on in local time.
    assert.equal(inWeek('2026-10-26T00:30:00.000+0100'), false, '25 October, 23:30 in London');
    assert.equal(inWeek('2026-11-01T23:30:00.000-0500'), false, '2 November, 04:30 in London');
    assert.equal(inWeek('2026-11-02T00:30:00.000+0200'), true, '1 November, 22:30 in London');
  });

  it('ignores worklogs without a usable start, and needs only one worklog in the week', () => {
    assert.equal(hasWorklogInWeek([{}, { started: 'not a date' }], '2026-10-26', '2026-11-01'), false);
    assert.equal(hasWorklogInWeek([], '2026-10-26', '2026-11-01'), false);
    assert.equal(hasWorklogInWeek([{ started: '2026-10-20T09:00:00.000+0100' }, { started: '2026-10-28T09:00:00.000+0000' }], '2026-10-26', '2026-11-01'), true);
  });
});

const ME = { accountId: 'me', displayName: 'Dev' };
const OTHER = { accountId: 'other', displayName: 'Someone Else' };
const STATUSES = {
  'To Do': 'new',
  'In Progress': 'indeterminate',
  'In Review': 'indeterminate',
  Done: 'done'
};

let nextWorklogId = 1;
/** A worklog on the given local date ("2026-10-28") at 09:00 UTC, by `author`. */
const worklog = (date, author = ME) => ({ id: String(nextWorklogId++), started: `${date}T09:00:00.000+0000`, timeSpentSeconds: 3600, author });

/** An issue for the fake Jira: assigned to `assignee`, in `status`, with `worklogs`. */
const issue = (key, status, { assignee = ME, worklogs = [] } = {}) => ({ key, status, assignee, worklogs });

/**
 * A fake Jira that evaluates the active issues JQL: in progress and assigned to ME, or with a
 * worklog by ME on the buffered dates (by each worklog's date in its own offset, as a server in
 * UTC would). /myself answers ME, and isn't counted in `requests` but in `identityRequests`. It returns
 * at most 20 worklogs per issue in the search, like Jira, and the rest from /issue/{key}/worklog.
 * Search results come in pages of `pageSize`: nextPageToken on Cloud, startAt on Data Center.
 */
function fakeJira({ issues = [], pageSize = 50, searchStatus = 200, worklogStatus = 200 } = {}) {
  const requests = [];
  const identityRequests = [];
  const toFields = (item) => ({
    summary: `Summary of ${item.key}`,
    status: { name: item.status, statusCategory: { key: STATUSES[item.status] } },
    assignee: item.assignee,
    worklog: { startAt: 0, maxResults: 20, total: item.worklogs.length, worklogs: item.worklogs.slice(0, 20) }
  });
  const idOf = (key) => String(10000 + Number(key.split('-')[1]));

  const fetchFn = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith('/myself')) {
      identityRequests.push({ url, options });
      return jsonResponse(200, ME);
    }
    requests.push({ url, options });

    const worklogPath = /\/issue\/([^/]+)\/worklog$/.exec(url.pathname);
    if (worklogPath) {
      if (worklogStatus !== 200) return jsonResponse(worklogStatus, { errorMessages: ['Worklogs unavailable'] });
      const item = issues.find((i) => i.key === decodeURIComponent(worklogPath[1]));
      const startAt = Number(url.searchParams.get('startAt'));
      const max = Number(url.searchParams.get('maxResults'));
      return jsonResponse(200, { startAt, maxResults: max, total: item.worklogs.length, worklogs: item.worklogs.slice(startAt, startAt + max) });
    }

    if (searchStatus !== 200) return jsonResponse(searchStatus, { errorMessages: ['Search failed'] });
    const jql = url.searchParams.get('jql');
    const [, from, to] = /worklogDate >= "([\d-]+)" AND worklogDate <= "([\d-]+)"/.exec(jql);
    const matching = issues.filter((item) =>
      (item.assignee === ME && STATUSES[item.status] === 'indeterminate') ||
      item.worklogs.some((wl) => wl.author === ME && wl.started.slice(0, 10) >= from && wl.started.slice(0, 10) <= to));

    const startAt = Number(url.searchParams.get('startAt') || url.searchParams.get('nextPageToken') || 0);
    const page = matching.slice(startAt, startAt + pageSize);
    const next = startAt + page.length;
    return jsonResponse(200, {
      issues: page.map((item) => ({ id: idOf(item.key), key: item.key, fields: toFields(item) })),
      startAt,
      total: matching.length,
      ...(next < matching.length ? { nextPageToken: String(next) } : { isLast: true })
    });
  };
  return { fetchFn, requests, identityRequests };
}

const cloudClient = (jira) => new JiraClient('https://acme.atlassian.net', new JiraCloudTokenProvider('dev@example.com', 'token'), { fetchFn: jira.fetchFn });
const serverClient = (jira) => new JiraClient('https://jira.example.com', new JiraPatProvider('pat-token'), { fetchFn: jira.fetchFn });
const activeIssues = (client) => client.getActiveIssues(WEEK.monday, WEEK.sunday);
const keysOf = (issues) => issues.map((i) => i.issueKey);
const worklogRequests = (jira) => jira.requests.filter((r) => /\/worklog$/.test(r.url.pathname));

describe('JiraClient - active issues', () => {
  for (const [edition, makeClient, path] of [['Jira Cloud', cloudClient, '/rest/api/3/search/jql'], ['Data Center / Server', serverClient, '/rest/api/2/search']]) {
    it(`searches once on ${edition}, by the selected week with a day either side, for summary, status, and worklogs`, async () => {
      const jira = fakeJira();
      await activeIssues(makeClient(jira));

      assert.equal(jira.requests.length, 1);
      const { pathname, searchParams } = jira.requests[0].url;
      assert.equal(pathname, path);
      assert.equal(searchParams.get('jql'), buildActiveIssuesJql('2026-10-25', '2026-11-02'));
      assert.equal(searchParams.get('fields'), 'summary,status,assignee,worklog');
    });
  }

  it('includes an In Progress issue with no worklogs, without asking for its worklogs', async () => {
    const jira = fakeJira({ issues: [issue('KAN-12', 'In Progress')] });
    assert.deepEqual(await activeIssues(cloudClient(jira)), [{
      issueId: '10012',
      issueKey: 'KAN-12',
      issueSummary: 'Summary of KAN-12',
      issueStatus: { name: 'In Progress', categoryKey: 'indeterminate' },
      inProgress: true,
      loggedThisWeek: false
    }]);
    assert.equal(worklogRequests(jira).length, 0);
  });

  it('includes any status in the In Progress category, such as In Review', async () => {
    const jira = fakeJira({ issues: [issue('KAN-11', 'In Review')] });
    assert.deepEqual(keysOf(await activeIssues(cloudClient(jira))), ['KAN-11']);
  });

  it('includes Done and To Do issues with a worklog in the selected week', async () => {
    const jira = fakeJira({
      issues: [
        issue('KAN-8', 'Done', { worklogs: [worklog('2026-10-27')] }),
        issue('KAN-14', 'To Do', { worklogs: [worklog('2026-11-01')] })
      ]
    });
    const found = await activeIssues(serverClient(jira));
    assert.deepEqual(keysOf(found), ['KAN-8', 'KAN-14']);
    assert.ok(found.every((i) => i.inProgress === false && i.loggedThisWeek === true));
  });

  it('leaves out issues whose worklogs are all outside the week, unless they are in progress', async () => {
    const jira = fakeJira({
      issues: [
        issue('KAN-7', 'Done', { worklogs: [worklog('2026-10-20'), worklog('2026-11-03')] }),
        // Found by the search's buffer day, but the worklog is on the Sunday before the week.
        issue('KAN-9', 'Done', { worklogs: [worklog('2026-10-25')] }),
        issue('KAN-10', 'To Do', { worklogs: [worklog('2026-11-02')] }),
        issue('KAN-13', 'In Progress', { worklogs: [worklog('2026-10-20')] })
      ]
    });
    assert.deepEqual(keysOf(await activeIssues(cloudClient(jira))), ['KAN-13']);
  });

  it('counts the week\'s first and last days', async () => {
    const jira = fakeJira({
      issues: [
        issue('KAN-1', 'Done', { worklogs: [worklog('2026-10-26')] }),
        issue('KAN-2', 'Done', { worklogs: [worklog('2026-11-01')] })
      ]
    });
    assert.deepEqual(keysOf(await activeIssues(cloudClient(jira))), ['KAN-1', 'KAN-2']);
  });

  it('lists an issue that is in progress and has work logged this week once, with both reasons', async () => {
    const jira = fakeJira({ issues: [issue('KAN-12', 'In Progress', { worklogs: [worklog('2026-10-27'), worklog('2026-10-28')] })] });
    const found = await activeIssues(cloudClient(jira));
    assert.deepEqual(keysOf(found), ['KAN-12']);
    assert.equal(found[0].inProgress, true);
    assert.equal(found[0].loggedThisWeek, true);
  });

  it('marks an in-progress issue with worklogs only outside the week as not logged this week', async () => {
    const jira = fakeJira({ issues: [issue('KAN-13', 'In Progress', { worklogs: [worklog('2026-10-20'), worklog('2026-11-02')] })] });
    const [found] = await activeIssues(cloudClient(jira));
    assert.equal(found.inProgress, true);
    assert.equal(found.loggedThisWeek, false);
  });

  it('reads an issue\'s full worklog list only when the search\'s 20 don\'t include one in the week', async () => {
    const lastWeek = () => Array.from({ length: 20 }, () => worklog('2026-10-20'));
    const jira = fakeJira({
      issues: [
        // In progress, the week's worklog is the 21st: needs the full list.
        issue('KAN-12', 'In Progress', { worklogs: [...lastWeek(), worklog('2026-10-29')] }),
        // In progress, the week's worklog is among the first 20: settled without a request.
        issue('KAN-13', 'In Progress', { worklogs: [worklog('2026-10-27'), ...lastWeek()] }),
        // Done, the same: settled without a request.
        issue('KAN-8', 'Done', { worklogs: [worklog('2026-10-28'), ...lastWeek()] })
      ]
    });
    const found = await activeIssues(cloudClient(jira));
    assert.deepEqual(found.map((i) => [i.issueKey, i.inProgress, i.loggedThisWeek]),
      [['KAN-12', true, true], ['KAN-13', true, true], ['KAN-8', false, true]]);
    assert.deepEqual(worklogRequests(jira).map((r) => r.url.pathname), ['/rest/api/3/issue/KAN-12/worklog']);
  });

  it('lists an issue with several worklogs this week once', async () => {
    const jira = fakeJira({
      issues: [
        issue('KAN-8', 'Done', { worklogs: ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].map((d) => worklog(d)) }),
        issue('KAN-12', 'In Progress', { worklogs: ['2026-10-27', '2026-10-30'].map((d) => worklog(d)) })
      ]
    });
    assert.deepEqual(keysOf(await activeIssues(cloudClient(jira))), ['KAN-12', 'KAN-8']);
  });

  it('keeps an issue once when the search returns it twice (a page boundary moved while paging)', async () => {
    const jira = fakeJira({ issues: [issue('KAN-12', 'In Progress')] });
    const twice = async (url, options) => {
      const response = await jira.fetchFn(url, options);
      const body = await response.json();
      return jsonResponse(200, body.issues ? { ...body, issues: [...body.issues, ...body.issues] } : body);
    };
    assert.deepEqual(keysOf(await activeIssues(cloudClient({ fetchFn: twice }))), ['KAN-12']);
  });

  it('includes an issue assigned to someone else that the user logged work on this week, whatever its status', async () => {
    const jira = fakeJira({
      issues: [
        issue('EKB-30899', 'Done', { assignee: OTHER, worklogs: [worklog('2026-10-26')] }),
        issue('EKB-30900', 'In Progress', { assignee: OTHER, worklogs: [worklog('2026-10-27')] }),
        issue('EKB-30901', 'To Do', { assignee: null, worklogs: [worklog('2026-10-28')] })
      ]
    });
    const found = await activeIssues(cloudClient(jira));
    assert.deepEqual(keysOf(found), ['EKB-30899', 'EKB-30900', 'EKB-30901']);
    // In progress for someone else isn't the user's in progress: listed for the worklog only.
    assert.ok(found.every((i) => i.inProgress === false && i.loggedThisWeek === true));
  });

  it('doesn\'t count work logged by someone else, even on an issue assigned to the user', async () => {
    const jira = fakeJira({
      issues: [
        issue('KAN-8', 'Done', { worklogs: [worklog('2026-10-28', OTHER)] }),
        issue('KAN-20', 'Done', { assignee: OTHER, worklogs: [worklog('2026-10-28', OTHER)] }),
        issue('KAN-12', 'In Progress', { worklogs: [worklog('2026-10-28', OTHER)] })
      ]
    });
    const found = await activeIssues(cloudClient(jira));
    assert.deepEqual(keysOf(found), ['KAN-12']);
    assert.equal(found[0].loggedThisWeek, false);
  });

  it('checks the authors of the search\'s worklogs, not only the search: the user\'s worklog in the week must be one worklog', async () => {
    // Jira matches worklogAuthor and worklogDate on any worklogs: the user's last week, someone
    // else's this week. Neither counts on its own.
    const jira = fakeJira({ issues: [issue('KAN-9', 'Done', { assignee: OTHER, worklogs: [worklog('2026-10-20'), worklog('2026-10-28', OTHER)] })] });
    const client = cloudClient({
      fetchFn: async (url, options) => {
        const response = await jira.fetchFn(url, options);
        const body = await response.json();
        if (!body.issues) return jsonResponse(200, body);
        // As Jira would: the search returns it.
        const fields = { summary: 'Summary of KAN-9', status: { name: 'Done', statusCategory: { key: 'done' } }, assignee: OTHER,
          worklog: { startAt: 0, maxResults: 20, total: 2, worklogs: [worklog('2026-10-20'), worklog('2026-10-28', OTHER)] } };
        return jsonResponse(200, { ...body, issues: [{ id: '10009', key: 'KAN-9', fields }], isLast: true });
      }
    });
    assert.deepEqual(await activeIssues(client), []);
  });

  it('excludes an issue assigned to someone else with no work by the user this week', async () => {
    const jira = fakeJira({
      issues: [
        issue('KAN-6', 'In Progress', { assignee: OTHER }),
        issue('KAN-7', 'Done', { assignee: OTHER, worklogs: [worklog('2026-10-20')] }),
        issue('KAN-21', 'Done', { worklogs: [worklog('2026-10-28')] })
      ]
    });
    assert.deepEqual(keysOf(await activeIssues(cloudClient(jira))), ['KAN-21']);
  });

  it('asks Jira who the user is once, even while the week\'s worklogs ask too', async () => {
    const jira = fakeJira({ issues: [issue('KAN-12', 'In Progress')] });
    const client = cloudClient(jira);
    await Promise.all([activeIssues(client), client.getCurrentUser()]);
    assert.equal(jira.identityRequests.length, 1);
  });

  it('lists in-progress issues first, then the others logged this week', async () => {
    const jira = fakeJira({
      issues: [
        issue('KAN-8', 'Done', { worklogs: [worklog('2026-10-27')] }),
        issue('KAN-12', 'In Progress'),
        issue('KAN-14', 'To Do', { worklogs: [worklog('2026-10-28')] }),
        issue('KAN-11', 'In Review')
      ]
    });
    assert.deepEqual(keysOf(await activeIssues(cloudClient(jira))), ['KAN-12', 'KAN-11', 'KAN-8', 'KAN-14']);
  });

  it('reads all the worklogs of an issue with more than the search includes, and only of that issue', async () => {
    // 21 worklogs: the search includes the first 20 (last week); the one this week is the 21st.
    const many = [...Array.from({ length: 20 }, () => worklog('2026-10-20')), worklog('2026-10-29')];
    const jira = fakeJira({
      issues: [
        issue('KAN-9', 'Done', { worklogs: many }),
        issue('KAN-8', 'Done', { worklogs: [worklog('2026-10-27')] })
      ]
    });
    assert.deepEqual(keysOf(await activeIssues(serverClient(jira))), ['KAN-9', 'KAN-8']);
    assert.deepEqual(worklogRequests(jira).map((r) => r.url.pathname), ['/rest/api/2/issue/KAN-9/worklog']);
  });

  it('collects every page of results on Jira Cloud and on Data Center / Server', async () => {
    const issues = Array.from({ length: 120 }, (_, n) => issue(`KAN-${n + 1}`, 'In Progress'));

    const cloud = fakeJira({ issues });
    assert.equal((await activeIssues(cloudClient(cloud))).length, 120);
    assert.deepEqual(cloud.requests.map((r) => r.url.searchParams.get('nextPageToken')), [null, '50', '100']);

    const server = fakeJira({ issues });
    assert.equal((await activeIssues(serverClient(server))).length, 120);
    assert.deepEqual(server.requests.map((r) => r.url.searchParams.get('startAt')), ['0', '50', '100']);
  });

  it('fails, rather than returning part of the list, when the search or a worklog request fails', async () => {
    await assert.rejects(activeIssues(cloudClient(fakeJira({ searchStatus: 500 }))), (err) => err.status === 500);

    // The week's worklog is the 21st, so the issue's full list has to be read.
    const many = [...Array.from({ length: 20 }, () => worklog('2026-10-20')), worklog('2026-10-28')];
    const jira = fakeJira({ worklogStatus: 500, issues: [issue('KAN-12', 'In Progress'), issue('KAN-9', 'Done', { worklogs: many })] });
    await assert.rejects(activeIssues(cloudClient(jira)), (err) =>
      err.status === 500 && /^Jira server returned an internal error \(500\)/.test(err.message));
  });

  it('gives network failures a user-facing message', async () => {
    const client = cloudClient({ fetchFn: async () => { throw new TypeError('Failed to fetch'); } });
    await assert.rejects(activeIssues(client), (err) => err.errorType === 'NETWORK_ERROR' && /Unable to reach the Jira server/.test(err.message));
  });

  it('stops when cancelled, including while reading an issue\'s worklogs', async () => {
    const many = [...Array.from({ length: 20 }, () => worklog('2026-10-20')), worklog('2026-10-28')];
    const jira = fakeJira({ issues: [issue('KAN-9', 'Done', { worklogs: many })] });
    const controller = new AbortController();
    const client = cloudClient({
      fetchFn: async (url, options) => {
        if (/\/worklog\?/.test(url)) controller.abort();
        if (options.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        return jira.fetchFn(url, options);
      }
    });
    await assert.rejects(client.getActiveIssues(WEEK.monday, WEEK.sunday, { signal: controller.signal }), { name: 'AbortError' });
  });
});

describe('Weekly service - loadActiveIssues', () => {
  it('asks for the selected week, Monday to the end of Sunday', async () => {
    const calls = [];
    const client = { getActiveIssues: async (start, end, options) => { calls.push({ start, end, options }); return []; } };
    const signal = new AbortController().signal;
    assert.deepEqual(await loadActiveIssues(client, { monday: new Date(2026, 9, 19), signal }), []);
    assert.equal(calls[0].start.getTime(), new Date(2026, 9, 19).getTime());
    assert.equal(calls[0].end.getTime(), new Date(2026, 9, 25, 23, 59, 59, 999).getTime());
    assert.equal(calls[0].options.signal, signal);
  });
});

describe('Active issues loader', () => {
  /** A client whose loads wait until resolved by hand, in any order. */
  function controllableClient(site = 'https://acme.atlassian.net') {
    const pending = [];
    return {
      baseUrl: site,
      deploymentType: 'cloud',
      pending,
      getActiveIssues: (start, end, { signal }) => new Promise((resolve, reject) => {
        pending.push({ start, resolve, reject, signal });
      })
    };
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const quietLoader = (states) => createWorkingIssuesLoader((state) => states.push(state), { logError: () => {} });
  const LAST_WEEK = getWeekRange(new Date(2026, 9, 19));

  it('reports loading, then the issues', async () => {
    const states = [];
    const client = controllableClient();
    const done = quietLoader(states).refresh(client, WEEK);
    await tick();
    client.pending[0].resolve([{ issueKey: 'KAN-12', inProgress: true }]);
    await done;
    assert.deepEqual(states, [{ status: 'loading' }, { status: 'ready', issues: [{ issueKey: 'KAN-12', inProgress: true }] }]);
  });

  it('never lets an older week\'s load replace a newer one', async () => {
    const states = [];
    const client = controllableClient();
    const loader = quietLoader(states);

    const first = loader.refresh(client, LAST_WEEK);
    await tick();
    const second = loader.refresh(client, WEEK);
    await tick();

    assert.equal(client.pending[0].signal.aborted, true, 'the older load is cancelled');
    assert.equal(client.pending[1].start.getDate(), 26);
    client.pending[1].resolve([{ issueKey: 'NEW-1' }]);
    // The cancelled load answering late changes nothing.
    client.pending[0].resolve([{ issueKey: 'OLD-1' }]);
    await Promise.all([first, second]);

    assert.deepEqual(states.at(-1).issues, [{ issueKey: 'NEW-1' }]);
    assert.equal(states.filter((s) => s.status === 'ready').length, 1);
  });

  it('doesn\'t reload the week it shows or is loading, unless forced (Sync, Retry, a worklog change)', async () => {
    const client = controllableClient();
    const loader = quietLoader([]);

    const done = loader.refresh(client, WEEK);
    await loader.refresh(client, WEEK);
    await tick();
    assert.equal(client.pending.length, 1, 'the week already loading');
    client.pending[0].resolve([]);
    await done;

    await loader.refresh(client, WEEK);
    assert.equal(client.pending.length, 1, 'the week already shown');

    const forced = loader.refresh(client, { ...WEEK, force: true });
    await tick();
    assert.equal(client.pending.length, 2);
    client.pending[1].resolve([]);
    await forced;

    const otherWeek = loader.refresh(client, LAST_WEEK);
    await tick();
    assert.equal(client.pending.length, 3, 'another week');
    client.pending[2].resolve([]);
    await otherWeek;

    const otherSite = controllableClient('https://other.atlassian.net');
    const onOtherSite = loader.refresh(otherSite, LAST_WEEK);
    await tick();
    assert.equal(otherSite.pending.length, 1, 'the same week on another site');
    otherSite.pending[0].resolve([]);
    await onOtherSite;
  });

  it('reports a failure as an error, not as an empty list, and loads the week again next time', async () => {
    const states = [];
    const client = controllableClient();
    const loader = quietLoader(states);

    const failing = loader.refresh(client, WEEK);
    await tick();
    client.pending[0].reject(Object.assign(new Error('Jira returned a server error (500).'), { status: 500 }));
    await failing;
    assert.deepEqual(states.at(-1), { status: 'error', message: 'Jira returned a server error (500).' });

    const again = loader.refresh(client, WEEK);
    await tick();
    assert.equal(client.pending.length, 2);
    client.pending[1].resolve([]);
    await again;
    assert.deepEqual(states.at(-1), { status: 'ready', issues: [] });
  });

  it('cancels a load in flight when cleared, reports nothing for it, and loads again afterwards', async () => {
    const states = [];
    const client = controllableClient();
    const loader = quietLoader(states);
    const done = loader.refresh(client, WEEK);
    await tick();
    loader.clear();
    client.pending[0].resolve([{ issueKey: 'KAN-12' }]);
    await done;
    assert.equal(client.pending[0].signal.aborted, true);
    assert.deepEqual(states, [{ status: 'loading' }, null]);

    const again = loader.refresh(client, WEEK);
    await tick();
    assert.equal(client.pending.length, 2);
    client.pending[1].resolve([]);
    await again;
  });
});

// Issues the user logged work on are listed only in the weeks of those worklogs; in-progress issues
// assigned to the user are listed every week, whatever their worklogs.
describe('My Active Issues - across weeks', () => {
  let restoreDocument;
  before(() => {
    restoreDocument = installFakeDocument();
  });
  after(() => restoreDocument());

  const OCTOBER = getWeekRange(new Date(2026, 9, 19));
  const NOVEMBER = getWeekRange(new Date(2026, 10, 9));
  const REPORTED = getWeekRange(new Date(2026, 10, 30));

  // KAN-1: In Progress, no worklogs. KAN-2: In Review (In Progress category), logged in October
  // and November. KAN-3: Done, logged in October only. KAN-4: Done, logged in October and
  // November. KAN-5: To Do, logged in November only.
  const sampleIssues = () => [
    issue('KAN-1', 'In Progress'),
    issue('KAN-2', 'In Review', { worklogs: [worklog('2026-10-20'), worklog('2026-11-10')] }),
    issue('KAN-3', 'Done', { worklogs: [worklog('2026-10-21'), worklog('2026-10-22')] }),
    issue('KAN-4', 'Done', { worklogs: [worklog('2026-10-23'), worklog('2026-11-12')] }),
    issue('KAN-5', 'To Do', { worklogs: [worklog('2026-11-13')] })
  ];

  /** The panel's rows and badge for a ready state, as the user sees them. */
  const panel = (state) => {
    const section = document.createElement('section');
    renderWorkingIssues(section, { state, expanded: true });
    return {
      keys: section.querySelectorAll('.working-issue').map((row) => row.querySelector('.issue-key-badge').textContent),
      badge: section.querySelector('.working-issues-count').textContent
    };
  };
  const weekOf = async (week, issues = sampleIssues()) =>
    keysOf(await cloudClient(fakeJira({ issues })).getActiveIssues(week.monday, week.sunday));

  it('keeps an in-progress issue in a week with no worklogs', async () => {
    assert.ok((await weekOf(REPORTED)).includes('KAN-1'));
  });

  it('lists a Done issue in the October week it was logged in', async () => {
    assert.ok((await weekOf(OCTOBER)).includes('KAN-3'));
  });

  it('leaves that Done issue out of November weeks, and lists it again with a November worklog', async () => {
    assert.ok(!(await weekOf(NOVEMBER)).includes('KAN-3'));
    assert.ok(!(await weekOf(REPORTED)).includes('KAN-3'));

    const loggedAgain = sampleIssues().map((item) =>
      item.key === 'KAN-3' ? { ...item, worklogs: [...item.worklogs, worklog('2026-11-11')] } : item);
    assert.ok((await weekOf(NOVEMBER, loggedAgain)).includes('KAN-3'));
  });

  it('lists an issue logged in October and November in both weeks', async () => {
    assert.ok((await weekOf(OCTOBER)).includes('KAN-4'));
    assert.ok((await weekOf(NOVEMBER)).includes('KAN-4'));
    assert.ok(!(await weekOf(REPORTED)).includes('KAN-4'));
  });

  it('lists each week exactly, with only in-progress issues in the reported week', async () => {
    assert.deepEqual(await weekOf(OCTOBER), ['KAN-1', 'KAN-2', 'KAN-3', 'KAN-4']);
    assert.deepEqual(await weekOf(NOVEMBER), ['KAN-1', 'KAN-2', 'KAN-4', 'KAN-5']);
    assert.deepEqual(await weekOf(REPORTED), ['KAN-1', 'KAN-2']);
  });

  it('lists an issue that is in progress and logged in the week once', async () => {
    const found = await cloudClient(fakeJira({ issues: sampleIssues() })).getActiveIssues(NOVEMBER.monday, NOVEMBER.sunday);
    const kan2 = found.filter((i) => i.issueKey === 'KAN-2');
    assert.equal(kan2.length, 1);
    assert.equal(kan2[0].inProgress, true);
    assert.equal(kan2[0].loggedThisWeek, true);
  });

  it('refreshes the list for each week navigated to, with the badge counting the rows', async () => {
    const jira = fakeJira({ issues: sampleIssues() });
    const states = [];
    const loader = createWorkingIssuesLoader((state) => states.push(state), { logError: () => {} });
    const client = cloudClient(jira);

    const expected = [
      [OCTOBER, ['KAN-1', 'KAN-2', 'KAN-3', 'KAN-4']],
      [NOVEMBER, ['KAN-1', 'KAN-2', 'KAN-4', 'KAN-5']],
      [REPORTED, ['KAN-1', 'KAN-2']],
      [OCTOBER, ['KAN-1', 'KAN-2', 'KAN-3', 'KAN-4']]
    ];
    for (const [week, keys] of expected) {
      await loader.refresh(client, week);
      const state = states.at(-1);
      assert.equal(state.status, 'ready');
      assert.deepEqual(panel(state), { keys, badge: String(keys.length) });
    }
    // One search per week navigated to, each by that week's days.
    const searched = jira.requests.map((r) => /worklogDate >= "([\d-]+)"/.exec(r.url.searchParams.get('jql') || '')?.[1]).filter(Boolean);
    assert.deepEqual(searched, ['2026-10-18', '2026-11-08', '2026-11-29', '2026-10-18']);
  });

  it('drops an issue the user logged work on in one week when another week is selected, and keeps the in-progress ones', async () => {
    const jira = fakeJira({
      issues: [
        issue('EKB-30835', 'In Progress'),
        issue('EKB-30899', 'In Review', { assignee: OTHER, worklogs: [{ ...worklog('2026-10-26'), timeSpentSeconds: 5400 }] }),
        issue('EKB-30900', 'Done', { assignee: OTHER, worklogs: [worklog('2026-10-27', OTHER)] })
      ]
    });
    const states = [];
    const loader = createWorkingIssuesLoader((state) => states.push(state), { logError: () => {} });
    const client = cloudClient(jira);
    const nextWeek = getWeekRange(new Date(2026, 10, 2));

    await loader.refresh(client, WEEK);
    assert.deepEqual(panel(states.at(-1)), { keys: ['EKB-30835', 'EKB-30899'], badge: '2' });
    await loader.refresh(client, nextWeek);
    assert.deepEqual(panel(states.at(-1)), { keys: ['EKB-30835'], badge: '1' });
    await loader.refresh(client, WEEK);
    assert.deepEqual(panel(states.at(-1)), { keys: ['EKB-30835', 'EKB-30899'], badge: '2' });
  });

  it('never shows an earlier week\'s issues once another week is selected, however late they arrive', async () => {
    const jira = fakeJira({ issues: sampleIssues() });
    // Holds the October search until released, so it answers after the newer week's.
    let releaseOctober;
    const octoberHeld = new Promise((resolve) => { releaseOctober = resolve; });
    const client = new JiraClient('https://acme.atlassian.net', new JiraCloudTokenProvider('dev@example.com', 'token'), {
      fetchFn: async (url, options) => {
        if (String(url).includes(encodeURIComponent('"2026-10-18"'))) await octoberHeld;
        return jira.fetchFn(url, options);
      }
    });
    const states = [];
    const loader = createWorkingIssuesLoader((state) => states.push(state), { logError: () => {} });

    const october = loader.refresh(client, OCTOBER);
    const reported = loader.refresh(client, REPORTED);
    await reported;
    assert.ok(jira.requests.every((r) => !r.url.searchParams.get('jql')?.includes('"2026-10-18"')), 'October still unanswered');
    releaseOctober();
    await october;

    const ready = states.filter((s) => s?.status === 'ready');
    assert.equal(ready.length, 1);
    assert.deepEqual(panel(states.at(-1)), { keys: ['KAN-1', 'KAN-2'], badge: '2' });
    assert.ok(!states.some((s) => s?.status === 'error'), 'the cancelled load reports nothing');
  });
});

describe('WeekView - My Active Issues section', () => {
  let restoreDocument;
  before(() => {
    restoreDocument = installFakeDocument();
  });
  after(() => restoreDocument());

  const MONDAY = new Date(2026, 9, 26);
  const readyIssues = [
    { issueId: '1', issueKey: 'KAN-12', issueSummary: 'Test <Chrome>', issueStatus: { name: 'In Progress', categoryKey: 'indeterminate' }, inProgress: true, loggedThisWeek: false },
    { issueId: '2', issueKey: 'KAN-13', issueSummary: 'Write the README', issueStatus: null, inProgress: true, loggedThisWeek: false }
  ];
  const doneIssue = { issueId: '3', issueKey: 'KAN-8', issueSummary: 'Build the weekly overview', issueStatus: { name: 'Done', categoryKey: 'done' }, inProgress: false, loggedThisWeek: true };

  /** Issues as getActiveIssues() returns them: `inProgress` in progress, the next `loggedOnly` only logged this week, and `both` of the in-progress ones also logged. */
  const activeList = ({ inProgress, loggedOnly, both = 0 }) => [
    ...Array.from({ length: inProgress }, (_, n) => ({
      issueId: String(100 + n), issueKey: `IP-${n + 1}`, issueSummary: 'In progress', issueStatus: { name: 'In Progress', categoryKey: 'indeterminate' },
      inProgress: true, loggedThisWeek: n < both
    })),
    ...Array.from({ length: loggedOnly }, (_, n) => ({
      issueId: String(200 + n), issueKey: `LG-${n + 1}`, issueSummary: 'Logged', issueStatus: { name: 'Done', categoryKey: 'done' },
      inProgress: false, loggedThisWeek: true
    }))
  ];
  const shown = (section) => ({
    subtitle: section.querySelector('.working-issues-subtitle').textContent,
    badge: section.querySelector('.working-issues-count').textContent,
    rows: section.querySelectorAll('.working-issue').length,
    keys: new Set(section.querySelectorAll('.working-issue').map((row) => row.querySelector('.issue-key-badge').textContent)).size
  });

  const renderSection = (state, options = {}) => {
    const section = document.createElement('section');
    renderWorkingIssues(section, { state, expanded: true, baseUrl: 'https://jira.example.com/', ...options });
    return section;
  };

  it('sits between the weekday cards and the selected-day panel', () => {
    const container = document.createElement('div');
    renderWeek(container, buildEmptyWeek(MONDAY), {
      selectedDateKey: '2026-10-26', onSelectDay: () => {},
      workingIssues: { state: { status: 'loading' }, expanded: true }
    });
    assert.deepEqual(container.childNodes.map((node) => node.className.split(' ')[0]), ['week-strip', 'working-issues', 'day-panel']);
    assert.equal(container.childNodes[1].id, 'workingIssues');
  });

  it('is titled My Active Issues, visibly and for assistive technology', () => {
    const container = document.createElement('div');
    renderWeek(container, buildEmptyWeek(MONDAY), {
      selectedDateKey: '2026-10-26', onSelectDay: () => {},
      workingIssues: { state: { status: 'ready', issues: [] }, expanded: false }
    });
    const section = container.querySelector('#workingIssues');
    assert.equal(section.getAttribute('aria-label'), 'My Active Issues');
    assert.equal(section.querySelector('.working-issues-title').textContent, 'My Active Issues');
    assert.doesNotMatch(toHtml(section), /Working Issues/);
  });

  it('is left out without My Active Issues options', () => {
    const container = document.createElement('div');
    renderWeek(container, buildEmptyWeek(MONDAY), { selectedDateKey: '2026-10-26', onSelectDay: () => {} });
    assert.equal(container.querySelector('.working-issues'), null);
  });

  it('shows a spinner and a loading message while retrieving', () => {
    const section = renderSection({ status: 'loading' });
    assert.equal(section.querySelector('.working-issues-subtitle').textContent, 'Retrieving issues from Jira…');
    assert.ok(section.querySelector('.working-issues-spinner'));
    assert.equal(section.querySelector('.working-issues-count'), null);
  });

  it('counts the issues, describes what is listed, and links them to Jira', () => {
    const section = renderSection({ status: 'ready', issues: readyIssues });
    assert.equal(section.querySelector('.working-issues-count').textContent, '2');
    assert.equal(section.querySelector('.working-issues-subtitle').textContent, '2 issues · In progress and recently logged');

    const html = toHtml(section);
    assert.match(html, /<a href="https:\/\/jira.example.com\/browse\/KAN-12" target="_blank" rel="noopener noreferrer" class="issue-key-badge"/);
    assert.match(html, /Test &lt;Chrome&gt;/);
    assert.match(html, /class="issue-status status-category-indeterminate"/);
    assert.equal(section.querySelectorAll('.working-issue').length, 2);
    // No dates: they're not part of the filter.
    assert.doesNotMatch(html, /<time|schedul|overlap/i);
    // Parts left out (spinner, error message) leave nothing behind.
    assert.doesNotMatch(html, />false</);
  });

  // The badge counts the issues listed, each once, whatever the reasons it's listed for.
  it('shows 9 for 6 in-progress issues and 3 others logged this week, with no overlap', () => {
    assert.deepEqual(shown(renderSection({ status: 'ready', issues: activeList({ inProgress: 6, loggedOnly: 3 }) })),
      { subtitle: '9 issues · In progress and recently logged', badge: '9', rows: 9, keys: 9 });
  });

  it('shows 7 for 6 in-progress issues and 3 logged this week, 2 of them in progress', () => {
    assert.deepEqual(shown(renderSection({ status: 'ready', issues: activeList({ inProgress: 6, loggedOnly: 1, both: 2 }) })),
      { subtitle: '7 issues · In progress and recently logged', badge: '7', rows: 7, keys: 7 });
  });

  it('always shows as many in the badge as the issues listed', () => {
    const cases = [
      [{ inProgress: 2, loggedOnly: 0 }, 2],
      [{ inProgress: 2, loggedOnly: 0, both: 2 }, 2],
      [{ inProgress: 0, loggedOnly: 1 }, 1],
      [{ inProgress: 0, loggedOnly: 0 }, 0]
    ];
    for (const [counts, total] of cases) {
      assert.deepEqual(shown(renderSection({ status: 'ready', issues: activeList(counts) })),
        { subtitle: `${total} ${total === 1 ? 'issue' : 'issues'} · In progress and recently logged`, badge: String(total), rows: total, keys: total });
    }
  });

  it('shows an issue it is given twice once, and counts it once', () => {
    const [inProgress, logged] = [activeList({ inProgress: 1, loggedOnly: 0, both: 1 })[0], doneIssue];
    const section = renderSection({ status: 'ready', issues: [inProgress, logged, { ...inProgress }, { ...logged, issueId: '' }] });
    assert.deepEqual(shown(section), { subtitle: '2 issues · In progress and recently logged', badge: '2', rows: 2, keys: 2 });
  });

  it('counts what Jira returns: each issue once in the list and in each reason, however many worklogs it has', async () => {
    const jira = fakeJira({
      issues: [
        ...Array.from({ length: 4 }, (_, n) => issue(`KAN-${n + 1}`, 'In Progress')),
        // In progress and logged this week, with several worklogs each
        issue('KAN-5', 'In Progress', { worklogs: [worklog('2026-10-27'), worklog('2026-10-28')] }),
        issue('KAN-6', 'In Review', { worklogs: [worklog('2026-10-26'), worklog('2026-10-29'), worklog('2026-11-01')] }),
        // Only logged this week
        issue('KAN-7', 'Done', { worklogs: [worklog('2026-10-30'), worklog('2026-10-30')] })
      ]
    });
    const issues = await activeIssues(cloudClient(jira));
    assert.deepEqual(shown(renderSection({ status: 'ready', issues })),
      { subtitle: '7 issues · In progress and recently logged', badge: '7', rows: 7, keys: 7 });
  });

  it('leads the subtitle with the badge count, singular for one issue, and no tooltip', () => {
    for (const [issues, expected] of [
      [activeList({ inProgress: 3, loggedOnly: 2, both: 1 }), '5 issues · In progress and recently logged'],
      [[doneIssue], '1 issue · In progress and recently logged'],
      [[], '0 issues · In progress and recently logged']
    ]) {
      const section = renderSection({ status: 'ready', issues });
      const subtitle = section.querySelector('.working-issues-subtitle');
      assert.equal(subtitle.textContent, expected);
      assert.ok(subtitle.textContent.startsWith(`${section.querySelector('.working-issues-count').textContent} `));
      assert.equal(subtitle.getAttribute('title'), null);
    }
  });

  it('shows no list for a week with nothing to show', () => {
    const section = renderSection({ status: 'ready', issues: [] });
    assert.equal(section.querySelector('.working-issues-list'), null);
  });

  it('gives an issue logged this week the same row and + button as an in-progress one', () => {
    const section = renderSection({ status: 'ready', issues: [doneIssue] }, { onLogWork: () => {} });
    const row = section.querySelector('.working-issue');
    assert.deepEqual(row.childNodes.map((n) => n.className), ['issue-key-badge', 'working-issue-summary', 'working-issue-status', 'working-issue-log-btn']);
    assert.match(toHtml(row), /status-category-done/);
  });

  it('shows a request failure as an error with Retry, not as zero issues', () => {
    let retries = 0;
    const section = renderSection({ status: 'error', message: 'Jira returned a server error (500).' }, { onRetry: () => retries++ });
    assert.equal(section.querySelector('.working-issues-count'), null);
    assert.equal(section.querySelector('.working-issues-subtitle').textContent, "Couldn't retrieve issues from Jira");
    assert.match(section.querySelector('.working-issues-message').textContent, /server error \(500\)/);
    assert.ok(section.classList.contains('is-error'));

    section.querySelector('.working-issues-retry').click();
    assert.equal(retries, 1);
    assert.equal(document.activeElement, section.querySelector('.working-issues-toggle'));
  });

  it('expands and collapses from the header button', () => {
    const toggles = [];
    const section = renderSection({ status: 'ready', issues: readyIssues }, { expanded: false, onToggle: (expanded) => toggles.push(expanded) });
    const toggle = section.querySelector('.working-issues-toggle');
    const body = section.querySelector('.working-issues-body');

    assert.equal(toggle.tagName.toLowerCase(), 'button');
    assert.equal(toggle.getAttribute('aria-controls'), body.id);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.ok(body.classList.contains('hidden'));

    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.ok(!body.classList.contains('hidden'));
    toggle.click();
    assert.deepEqual(toggles, [true, false]);
  });

  it('updates in place, keeping the header button', () => {
    const section = renderSection({ status: 'loading' });
    const toggle = section.querySelector('.working-issues-toggle');
    renderWorkingIssues(section, { state: { status: 'ready', issues: readyIssues }, expanded: true });
    assert.equal(section.querySelector('.working-issues-toggle'), toggle);
    assert.equal(section.querySelector('.working-issues-count').textContent, '2');
    assert.equal(section.querySelector('.working-issues-spinner'), null);
  });

  it('puts a log work (+) button at the end of every row, labelled for its issue', () => {
    const section = renderSection({ status: 'ready', issues: readyIssues }, { onLogWork: () => {} });
    const rows = section.querySelectorAll('.working-issue');
    assert.equal(rows.length, 2);
    for (const [row, { issueKey }] of rows.map((r, i) => [r, readyIssues[i]])) {
      const button = row.childNodes.at(-1);
      assert.equal(button.tagName.toLowerCase(), 'button');
      assert.equal(button.getAttribute('type'), 'button');
      assert.equal(button.className, 'working-issue-log-btn');
      assert.equal(button.getAttribute('aria-label'), `Log work on ${issueKey}`);
      assert.equal(button.getAttribute('title'), 'Log work');
      // The same plus icon as the selected day's add worklog button.
      assert.match(toHtml(button), /<line x1="12" y1="5" x2="12" y2="19"><\/line><line x1="5" y1="12" x2="19" y2="12"><\/line>/);
    }
    // Key link, summary, and status stay in place before it.
    assert.deepEqual(rows[0].childNodes.map((n) => n.className), ['issue-key-badge', 'working-issue-summary', 'working-issue-status', 'working-issue-log-btn']);
  });

  it('styles the button exactly like the selected day\'s add worklog button', () => {
    const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
    for (const state of ['', ':hover', ':focus-visible', ' .icon']) {
      assert.ok(css.includes(`.working-issue-log-btn${state},\n.day-add-btn${state} {`), `shares .day-add-btn${state}`);
    }
  });

  it('leaves the button out until logging work is possible', () => {
    const section = renderSection({ status: 'ready', issues: readyIssues });
    assert.equal(section.querySelector('.working-issue-log-btn'), null);
  });

  it('calls back with the row\'s issue, and the click goes no further than the button', () => {
    const logged = [];
    const toggles = [];
    const section = renderSection({ status: 'ready', issues: readyIssues },
      { onLogWork: (issue) => logged.push(issue), onToggle: (expanded) => toggles.push(expanded) });
    let bubbled = 0;
    section.addEventListener('click', () => bubbled++);

    section.querySelector('.working-issue-log-btn[data-issue-key="KAN-13"]').click();

    assert.deepEqual(logged, [readyIssues[1]]);
    assert.equal(bubbled, 0, 'the row and section see no click');
    assert.deepEqual(toggles, []);
    assert.equal(section.querySelector('.working-issues-toggle').getAttribute('aria-expanded'), 'true');
  });

  it('keeps the buttons working after an in-place update', () => {
    const logged = [];
    const section = renderSection({ status: 'loading' }, { onLogWork: (issue) => logged.push(issue.issueKey) });
    renderWorkingIssues(section, { state: { status: 'ready', issues: readyIssues }, expanded: true, onLogWork: (issue) => logged.push(issue.issueKey) });
    section.querySelector('.working-issue-log-btn[data-issue-key="KAN-12"]').click();
    assert.deepEqual(logged, ['KAN-12']);
  });

  describe('logging work from a row, through the Log work panel', () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    /** Clicks a row's + button and opens the Log work panel the way the page does (startLogWorkOnIssue). */
    function openFromRow(issueKey, selectedDateKey, onSave) {
      let root;
      const closed = [];
      const section = renderSection({ status: 'ready', issues: readyIssues }, {
        onLogWork: (issue) => {
          root = h('aside', { class: 'worklog-editor hidden' });
          openWorklogEditor(root, {
            mode: 'create',
            worklog: issue,
            baseUrl: 'https://jira.example.com',
            initialForm: toNewWorklogForm({ dateKey: selectedDateKey }),
            onSave,
            onClose: (reason) => closed.push(reason)
          });
        }
      });
      section.querySelector(`.working-issue-log-btn[data-issue-key="${issueKey}"]`).click();
      return { root, closed };
    }

    it('opens the panel with the issue filled in and the selected day as the date', () => {
      const { root } = openFromRow('KAN-12', '2026-10-28', async () => {});
      assert.equal(root.querySelector('.editor-title').textContent, 'Log work');
      assert.equal(root.querySelector('.issue-key-badge').textContent, 'KAN-12');
      assert.equal(root.querySelector('#worklogEditDate').value, '2026-10-28');
      assert.equal(root.classList.contains('hidden'), false);
    });

    it('saves a worklog on that issue, then closes', async () => {
      const created = [];
      const client = { createWorklog: async (issueIdOrKey, worklog) => { created.push({ issueIdOrKey, worklog }); return { id: '501', started: '2026-10-28T09:00:00.000+0000' }; } };
      const saved = [];
      const { root, closed } = openFromRow('KAN-12', '2026-10-28', async (values, issue) => {
        saved.push(await logWork(client, issue, values));
      });

      const hours = root.querySelector('#worklogEditHours');
      hours.value = '2';
      hours.dispatchEvent({ type: 'input' });
      root.querySelector('.editor-form').dispatchEvent({ type: 'submit' });
      await flush();

      assert.equal(created.length, 1);
      assert.equal(created[0].issueIdOrKey, '1', 'the issue ID of KAN-12');
      assert.equal(created[0].worklog.timeSpentSeconds, 7200);
      assert.equal(created[0].worklog.started.getDate(), 28);
      assert.equal(saved[0].issueKey, 'KAN-12');
      assert.deepEqual(closed, ['saved']);
    });

    it('still validates the form: no duration, no save', async () => {
      let saves = 0;
      const { root, closed } = openFromRow('KAN-13', '2026-10-28', async () => { saves++; });
      root.querySelector('.editor-form').dispatchEvent({ type: 'submit' });
      await flush();
      assert.equal(saves, 0);
      assert.deepEqual(closed, []);
      assert.notEqual(root.querySelector('[data-error-for="duration"]').textContent, '');
    });
  });
});
