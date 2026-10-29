process.env.TZ = 'Europe/London';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument, toHtml } from './support/fakeDom.js';
import { WORKING_STATUS_NAMES, selectWorkingStatuses, buildWorkingIssuesJql } from '../src/jira/workingStatuses.js';
import { JiraClient } from '../src/jira/JiraClient.js';
import { JiraCloudTokenProvider } from '../src/auth/JiraCloudTokenProvider.js';
import { JiraPatProvider } from '../src/auth/JiraPatProvider.js';
import { loadWorkingIssues, logWork } from '../src/worklog/weeklyWorklogService.js';
import { openWorklogEditor } from '../src/ui/worklogEditor.js';
import { toNewWorklogForm } from '../src/worklog/worklogEdit.js';
import { createWorkingIssuesLoader } from '../src/worklog/workingIssuesLoader.js';
import { renderWeek, renderWorkingIssues } from '../src/ui/weekView.js';
import { h } from '../src/ui/dom.js';
import { buildEmptyWeek } from '../src/worklog/worklogUtils.js';

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Status list entries as `GET /status` returns them. IDs differ per site; In Progress is 3 on a
// live Jira Cloud site, where To Do, In Review, and Done are project-scoped with site-specific IDs.
const status = (id, name, categoryKey) => ({ id, name, statusCategory: { key: categoryKey } });
const SITE_STATUSES = [
  status('10000', 'To Do', 'new'),
  status('3', 'In Progress', 'indeterminate'),
  status('10001', 'In Review', 'indeterminate'),
  status('10002', 'Done', 'done')
];

const IN_PROGRESS = { names: ['In Progress'] };

describe('Working issues - statuses', () => {
  it('lists In Progress issues', () => {
    assert.deepEqual(WORKING_STATUS_NAMES, ['In Progress']);
  });

  it('finds the status by name, whatever its ID, under the site\'s spelling', () => {
    assert.deepEqual(selectWorkingStatuses(SITE_STATUSES), IN_PROGRESS);
    assert.deepEqual(selectWorkingStatuses([status('99', 'in progress', 'indeterminate')]), { names: ['in progress'] });
    assert.deepEqual(selectWorkingStatuses([status('41', '  In Progress ', 'indeterminate')]), IN_PROGRESS);
  });

  it('lists a name once when several statuses share it (one per project)', () => {
    const perProject = [status('3', 'In Progress', 'indeterminate'), status('10107', 'In Progress', 'indeterminate')];
    assert.deepEqual(selectWorkingStatuses(perProject), IN_PROGRESS);
  });

  it('keeps only the wanted names the site has', () => {
    assert.deepEqual(selectWorkingStatuses(SITE_STATUSES, ['In Progress', 'Testing', 'In Review']), { names: ['In Progress', 'In Review'] });
  });

  it('explains when the site has none of the statuses', () => {
    const result = selectWorkingStatuses([status('1', 'Open', 'new'), status('6', 'Closed', 'done')]);
    assert.equal(result.names, undefined);
    assert.match(result.reason, /no status named In Progress/);
    assert.ok(selectWorkingStatuses([]).reason);
    assert.ok(selectWorkingStatuses(null).reason);
  });

  it('builds the JQL for the current user\'s issues in those statuses, with names quoted', () => {
    assert.equal(buildWorkingIssuesJql(['In Progress']),
      'assignee = currentUser() AND status in ("In Progress") ORDER BY updated DESC');
    assert.equal(buildWorkingIssuesJql(['In Progress', 'Waiting "QA" \\ Vendor']),
      'assignee = currentUser() AND status in ("In Progress", "Waiting \\"QA\\" \\\\ Vendor") ORDER BY updated DESC');
  });
});

/**
 * A fake Jira: a status list, and a search that applies the JQL's assignee and status conditions
 * to `issues` (each with an `assignee` account) and returns them in pages of `pageSize`. Cloud
 * pages with nextPageToken, Data Center / Server with startAt. Records every request.
 */
function fakeJira({ statuses = SITE_STATUSES, issues = [], pageSize = 50, statusListStatus = 200, searchStatus = 200, currentUser = 'me' } = {}) {
  const requests = [];
  const fetchFn = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    requests.push({ url, options });
    if (url.pathname.endsWith('/status')) {
      return jsonResponse(statusListStatus, statusListStatus === 200 ? statuses : { errorMessages: ['Nope'] });
    }
    if (searchStatus !== 200) return jsonResponse(searchStatus, { errorMessages: ['Search failed'] });

    const jql = url.searchParams.get('jql');
    const wanted = [...jql.match(/status in \((.*)\)/)[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].toLowerCase());
    const matching = issues.filter((issue) =>
      (!/assignee = currentUser\(\)/.test(jql) || issue.assignee === currentUser) &&
      wanted.includes(issue.fields.status.name.toLowerCase()));

    const startAt = Number(url.searchParams.get('startAt') || url.searchParams.get('nextPageToken') || 0);
    const page = matching.slice(startAt, startAt + pageSize);
    const next = startAt + page.length;
    return jsonResponse(200, {
      issues: page.map(({ assignee, ...issue }) => issue),
      startAt,
      total: matching.length,
      ...(next < matching.length ? { nextPageToken: String(next) } : { isLast: true })
    });
  };
  return { fetchFn, requests };
}

const cloudClient = (jira) => new JiraClient('https://acme.atlassian.net', new JiraCloudTokenProvider('dev@example.com', 'token'), { fetchFn: jira.fetchFn });
const serverClient = (jira) => new JiraClient('https://jira.example.com', new JiraPatProvider('pat-token'), { fetchFn: jira.fetchFn });

const issue = (key, statusName, { assignee = 'me', categoryKey = 'indeterminate', fields = {} } = {}) => ({
  id: String(10000 + Number(key.split('-')[1])),
  key,
  assignee,
  fields: { summary: `Summary of ${key}`, status: { name: statusName, statusCategory: { key: categoryKey } }, ...fields }
});

describe('JiraClient - working issues', () => {
  it('reads the status list from REST API v3 on Jira Cloud and v2 on Data Center / Server', async () => {
    const cloud = fakeJira();
    assert.deepEqual(await cloudClient(cloud).getWorkingStatuses(), IN_PROGRESS);
    assert.equal(cloud.requests[0].url.pathname, '/rest/api/3/status');

    const server = fakeJira();
    assert.deepEqual(await serverClient(server).getWorkingStatuses(), IN_PROGRESS);
    assert.equal(server.requests[0].url.pathname, '/rest/api/2/status');
  });

  it('fails with the HTTP status when the status list cannot be read', async () => {
    await assert.rejects(cloudClient(fakeJira({ statusListStatus: 403 })).getWorkingStatuses(), (err) => err.status === 403 && /403/.test(err.message));
  });

  it('gives network failures a user-facing message', async () => {
    const client = cloudClient({ fetchFn: async () => { throw new TypeError('Failed to fetch'); } });
    await assert.rejects(client.getWorkingStatuses(), (err) => err.errorType === 'NETWORK_ERROR' && /Unable to reach the Jira server/.test(err.message));
  });

  for (const [edition, makeClient, path] of [['Jira Cloud', cloudClient, '/rest/api/3/search/jql'], ['Data Center / Server', serverClient, '/rest/api/2/search']]) {
    it(`searches by assignee and status in JQL on ${edition}, asking only for summary and status`, async () => {
      const jira = fakeJira();
      await makeClient(jira).getWorkingIssues(IN_PROGRESS);

      const { pathname, searchParams } = jira.requests[0].url;
      assert.equal(pathname, path);
      assert.equal(searchParams.get('jql'), 'assignee = currentUser() AND status in ("In Progress") ORDER BY updated DESC');
      assert.equal(searchParams.get('fields'), 'summary,status');
    });
  }

  it('includes an assigned In Progress issue that has no scheduled dates or estimate', async () => {
    const jira = fakeJira({ issues: [issue('DC-1', 'In Progress', { fields: { customfield_11200: '2026-10-27', timetracking: { originalEstimate: '2d' } } })] });
    assert.deepEqual(await serverClient(jira).getWorkingIssues(IN_PROGRESS), [{
      issueId: '10001',
      issueKey: 'DC-1',
      issueSummary: 'Summary of DC-1',
      issueStatus: { name: 'In Progress', categoryKey: 'indeterminate' }
    }]);
  });

  it('includes each configured status, and excludes other users\' issues and other statuses', async () => {
    const jira = fakeJira({
      issues: [
        issue('KAN-12', 'In Progress'),
        issue('KAN-13', 'In Progress'),
        issue('KAN-6', 'In Progress', { assignee: 'someone-else' }),
        issue('KAN-11', 'In Review'),
        issue('KAN-14', 'To Do', { categoryKey: 'new' }),
        issue('KAN-7', 'Done', { categoryKey: 'done' })
      ]
    });
    const found = await cloudClient(jira).getWorkingIssues(IN_PROGRESS);
    assert.deepEqual(found.map((i) => i.issueKey), ['KAN-12', 'KAN-13']);

    // With more configured statuses, each is included.
    const wider = await cloudClient(jira).getWorkingIssues({ names: ['In Progress', 'In Review'] });
    assert.deepEqual(wider.map((i) => i.issueKey), ['KAN-12', 'KAN-13', 'KAN-11']);
  });

  it('drops anything Jira returns in another status', async () => {
    const client = cloudClient({
      fetchFn: async () => jsonResponse(200, { isLast: true, issues: [issue('KAN-12', 'In Progress'), issue('KAN-7', 'Done'), { id: '5', key: 'KAN-5', fields: {} }] })
    });
    assert.deepEqual((await client.getWorkingIssues(IN_PROGRESS)).map((i) => i.issueKey), ['KAN-12']);
  });

  it('collects every page of results on Jira Cloud and on Data Center / Server', async () => {
    const issues = Array.from({ length: 120 }, (_, n) => issue(`KAN-${n + 1}`, 'In Progress'));

    const cloud = fakeJira({ issues });
    assert.equal((await cloudClient(cloud).getWorkingIssues(IN_PROGRESS)).length, 120);
    assert.deepEqual(cloud.requests.map((r) => r.url.searchParams.get('nextPageToken')), [null, '50', '100']);

    const server = fakeJira({ issues });
    assert.equal((await serverClient(server).getWorkingIssues(IN_PROGRESS)).length, 120);
    assert.deepEqual(server.requests.map((r) => r.url.searchParams.get('startAt')), ['0', '50', '100']);
  });

  it('fails with the HTTP status when the search fails', async () => {
    await assert.rejects(cloudClient(fakeJira({ searchStatus: 500 })).getWorkingIssues(IN_PROGRESS), (err) => err.status === 500);
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    const jira = fakeJira();
    const client = cloudClient({
      fetchFn: async (url, options) => {
        controller.abort();
        if (options.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
        return jira.fetchFn(url, options);
      }
    });
    await assert.rejects(client.getWorkingIssues(IN_PROGRESS, { signal: controller.signal }), { name: 'AbortError' });
  });
});

describe('Weekly service - loadWorkingIssues', () => {
  it('looks the statuses up, then searches', async () => {
    const calls = [];
    const client = {
      getWorkingStatuses: async () => { calls.push('statuses'); return IN_PROGRESS; },
      getWorkingIssues: async (statuses) => { calls.push(['issues', statuses]); return []; }
    };
    assert.deepEqual(await loadWorkingIssues(client), { workingStatuses: IN_PROGRESS, issues: [] });
    assert.deepEqual(calls, ['statuses', ['issues', IN_PROGRESS]]);
  });

  it('reuses statuses found earlier', async () => {
    const client = {
      getWorkingStatuses: async () => assert.fail('Statuses should not be looked up again'),
      getWorkingIssues: async () => []
    };
    assert.deepEqual((await loadWorkingIssues(client, { workingStatuses: IN_PROGRESS })).issues, []);
  });

  it('does not search, and returns no issue list, when the site has none of the statuses', async () => {
    const unavailable = { reason: 'This Jira site has no status named In Progress.' };
    const client = {
      getWorkingStatuses: async () => unavailable,
      getWorkingIssues: async () => assert.fail('Should not search without a status')
    };
    assert.deepEqual(await loadWorkingIssues(client), { workingStatuses: unavailable, issues: null });
  });
});

describe('Working issues loader', () => {
  /** A client whose searches wait until resolved by hand, in any order. */
  function controllableClient(site = 'https://acme.atlassian.net') {
    const pending = [];
    let statusLookups = 0;
    return {
      baseUrl: site,
      deploymentType: 'cloud',
      pending,
      get statusLookups() { return statusLookups; },
      getWorkingStatuses: async () => { statusLookups++; return IN_PROGRESS; },
      getWorkingIssues: (statuses, { signal }) => new Promise((resolve, reject) => {
        pending.push({ resolve, reject, signal });
      })
    };
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const quietLoader = (states) => createWorkingIssuesLoader((state) => states.push(state), { logError: () => {} });

  it('reports loading, then the issues with the statuses searched', async () => {
    const states = [];
    const client = controllableClient();
    const done = quietLoader(states).refresh(client);
    await tick();
    client.pending[0].resolve([{ issueKey: 'KAN-12' }]);
    await done;
    assert.deepEqual(states, [{ status: 'loading' }, { status: 'ready', issues: [{ issueKey: 'KAN-12' }], statusNames: ['In Progress'] }]);
  });

  it('never lets an older load replace a newer one (changing weeks, Sync)', async () => {
    const states = [];
    const client = controllableClient();
    const loader = quietLoader(states);

    const first = loader.refresh(client);
    await tick();
    const second = loader.refresh(client, { refreshStatuses: true });
    await tick();

    assert.equal(client.pending[0].signal.aborted, true, 'the older search is cancelled');
    client.pending[1].resolve([{ issueKey: 'NEW-1' }]);
    // The cancelled search answering late changes nothing.
    client.pending[0].resolve([{ issueKey: 'OLD-1' }]);
    await Promise.all([first, second]);

    assert.deepEqual(states.at(-1).issues, [{ issueKey: 'NEW-1' }]);
    assert.equal(states.filter((s) => s.status === 'ready').length, 1);
  });

  it('reuses the statuses until Sync, Retry, or a change of site asks for them again', async () => {
    const client = controllableClient();
    const loader = quietLoader([]);
    const run = async (c, options) => {
      const done = loader.refresh(c, options);
      await tick();
      c.pending.at(-1).resolve([]);
      await done;
    };

    await run(client);
    await run(client);
    assert.equal(client.statusLookups, 1);
    await run(client, { refreshStatuses: true });
    assert.equal(client.statusLookups, 2);

    const otherSite = controllableClient('https://other.atlassian.net');
    await run(otherSite);
    assert.equal(otherSite.statusLookups, 1);
  });

  it('reports a failure as an error, and looks the statuses up again next time', async () => {
    const states = [];
    const client = controllableClient();
    const loader = quietLoader(states);

    const failing = loader.refresh(client);
    await tick();
    client.pending[0].reject(Object.assign(new Error('Jira returned a server error (500).'), { status: 500 }));
    await failing;
    assert.deepEqual(states.at(-1), { status: 'error', message: 'Jira returned a server error (500).' });

    const retry = loader.refresh(client);
    await tick();
    client.pending[1].resolve([]);
    await retry;
    assert.equal(client.statusLookups, 2);
    assert.deepEqual(states.at(-1), { status: 'ready', issues: [], statusNames: ['In Progress'] });
  });

  it('reports a site without the statuses as unavailable, not as zero issues', async () => {
    const states = [];
    const client = { baseUrl: 'https://jira.example.com', deploymentType: 'server', getWorkingStatuses: async () => ({ reason: 'No status named In Progress.' }) };
    await quietLoader(states).refresh(client);
    assert.deepEqual(states, [{ status: 'loading' }, { status: 'unavailable', message: 'No status named In Progress.' }]);
  });

  it('cancels a load in flight when cleared, and reports nothing for it', async () => {
    const states = [];
    const client = controllableClient();
    const loader = quietLoader(states);
    const done = loader.refresh(client);
    await tick();
    loader.clear();
    client.pending[0].resolve([{ issueKey: 'KAN-12' }]);
    await done;
    assert.equal(client.pending[0].signal.aborted, true);
    assert.deepEqual(states, [{ status: 'loading' }, null]);
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
    { issueId: '1', issueKey: 'KAN-12', issueSummary: 'Test <Chrome>', issueStatus: { name: 'In Progress', categoryKey: 'indeterminate' } },
    { issueId: '2', issueKey: 'KAN-13', issueSummary: 'Write the README', issueStatus: null }
  ];

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
      workingIssues: { state: { status: 'ready', issues: [], statusNames: ['In Progress'] }, expanded: false }
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

  it('counts the issues, says what they are filtered by, and links them to Jira', () => {
    const section = renderSection({ status: 'ready', issues: readyIssues, statusNames: ['In Progress'] });
    assert.equal(section.querySelector('.working-issues-count').textContent, '2');
    assert.equal(section.querySelector('.working-issues-subtitle').textContent, '2 In Progress, assigned to you');

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

  it('shows 0 and no list when no issues match', () => {
    const section = renderSection({ status: 'ready', issues: [], statusNames: ['In Progress'] });
    assert.equal(section.querySelector('.working-issues-count').textContent, '0');
    assert.equal(section.querySelector('.working-issues-subtitle').textContent, 'No In Progress issues assigned to you');
    assert.equal(section.querySelector('.working-issues-list'), null);
  });

  it('names every status searched', () => {
    const section = renderSection({ status: 'ready', issues: [], statusNames: ['In Progress', 'In Review'] });
    assert.equal(section.querySelector('.working-issues-subtitle').textContent, 'No In Progress or In Review issues assigned to you');
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

  it('explains a site without the statuses, without a count', () => {
    const section = renderSection({ status: 'unavailable', message: 'This Jira site has no status named In Progress.' });
    assert.equal(section.querySelector('.working-issues-count'), null);
    assert.equal(section.querySelector('.working-issues-subtitle').textContent, 'No matching status on this Jira site');
    assert.match(section.querySelector('.working-issues-message').textContent, /no status named In Progress/);
    assert.equal(section.querySelector('.working-issues-retry'), null);
    assert.ok(section.classList.contains('is-unavailable'));
  });

  it('expands and collapses from the header button', () => {
    const toggles = [];
    const section = renderSection({ status: 'ready', issues: readyIssues, statusNames: ['In Progress'] }, { expanded: false, onToggle: (expanded) => toggles.push(expanded) });
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
    renderWorkingIssues(section, { state: { status: 'ready', issues: readyIssues, statusNames: ['In Progress'] }, expanded: true });
    assert.equal(section.querySelector('.working-issues-toggle'), toggle);
    assert.equal(section.querySelector('.working-issues-count').textContent, '2');
    assert.equal(section.querySelector('.working-issues-spinner'), null);
  });

  it('puts a log work (+) button at the end of every row, labelled for its issue', () => {
    const section = renderSection({ status: 'ready', issues: readyIssues, statusNames: ['In Progress'] }, { onLogWork: () => {} });
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
    const section = renderSection({ status: 'ready', issues: readyIssues, statusNames: ['In Progress'] });
    assert.equal(section.querySelector('.working-issue-log-btn'), null);
  });

  it('calls back with the row\'s issue, and the click goes no further than the button', () => {
    const logged = [];
    const toggles = [];
    const section = renderSection({ status: 'ready', issues: readyIssues, statusNames: ['In Progress'] },
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
    renderWorkingIssues(section, { state: { status: 'ready', issues: readyIssues, statusNames: ['In Progress'] }, expanded: true, onLogWork: (issue) => logged.push(issue.issueKey) });
    section.querySelector('.working-issue-log-btn[data-issue-key="KAN-12"]').click();
    assert.deepEqual(logged, ['KAN-12']);
  });

  describe('logging work from a row, through the Log work panel', () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    /** Clicks a row's + button and opens the Log work panel the way the page does (startLogWorkOnIssue). */
    function openFromRow(issueKey, selectedDateKey, onSave) {
      let root;
      const closed = [];
      const section = renderSection({ status: 'ready', issues: readyIssues, statusNames: ['In Progress'] }, {
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
