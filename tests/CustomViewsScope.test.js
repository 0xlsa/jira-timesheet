process.env.TZ = 'Europe/London';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JiraClient } from '../src/jira/JiraClient.js';
import { JiraCloudTokenProvider } from '../src/auth/JiraCloudTokenProvider.js';
import { JiraPatProvider } from '../src/auth/JiraPatProvider.js';
import { buildActiveIssuesJql } from '../src/jira/activeIssues.js';
import { loadActiveIssues } from '../src/worklog/weeklyWorklogService.js';
import { createWorkingIssuesLoader } from '../src/worklog/workingIssuesLoader.js';
import { createSettingsStore, normalizeSettings, customViewsForSite } from '../src/settings/settingsStore.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';
import { matchesView, requiredViewFields, valueOptions } from '../src/jira/customViews.js';

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const ME = { accountId: 'me-123', displayName: 'Dev Me', emailAddress: 'dev@example.com' };
const OTHER = { accountId: 'other-456', displayName: 'Someone Else', emailAddress: 'someone@example.com' };

/** Issues as Jira's search returns them, in progress and assigned to the user unless said otherwise. */
const ISSUES = [
  { id: '10001', key: 'KAN-1', fields: {
    summary: 'One', status: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } }, assignee: ME,
    priority: { id: '2', name: 'High' }, reporter: OTHER, customfield_10050: OTHER, customfield_10100: { id: '10200', value: 'Platform' },
    worklog: { startAt: 0, maxResults: 20, total: 0, worklogs: [] }
  } },
  { id: '10002', key: 'KAN-2', fields: {
    summary: 'Two', status: { id: '4', name: 'In Review', statusCategory: { key: 'indeterminate' } }, assignee: ME,
    priority: { id: '3', name: 'Medium' }, reporter: ME, customfield_10050: ME, customfield_10100: null,
    worklog: { startAt: 0, maxResults: 20, total: 0, worklogs: [] }
  } }
];

/**
 * A fake Jira: /myself answers ME, the search answers ISSUES with only the fields asked for (as
 * Jira does), and GET /field answers `fieldList`. Every request is recorded.
 */
function fakeJira({ fieldList = [], fieldStatus = 200 } = {}) {
  const requests = [];
  const fetchFn = async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith('/myself')) return jsonResponse(200, ME);
    requests.push(url);
    if (url.pathname.endsWith('/field')) return fieldStatus === 200 ? jsonResponse(200, fieldList) : jsonResponse(fieldStatus, { errorMessages: ['No fields'] });
    const asked = url.searchParams.get('fields').split(',');
    return jsonResponse(200, {
      issues: ISSUES.map((issue) => ({ id: issue.id, key: issue.key, fields: Object.fromEntries(asked.filter((f) => f in issue.fields).map((f) => [f, issue.fields[f]])) })),
      total: ISSUES.length,
      startAt: 0,
      isLast: true
    });
  };
  return { fetchFn, requests, searches: () => requests.filter((url) => /\/search/.test(url.pathname)) };
}

const cloud = (jira) => new JiraClient('https://acme.atlassian.net', new JiraCloudTokenProvider('dev@example.com', 'token'), { fetchFn: jira.fetchFn });
const server = (jira) => new JiraClient('https://jira.example.com', new JiraPatProvider('pat'), { fetchFn: jira.fetchFn });
const SINCE = new Date('2026-10-30T15:30:00.000Z');
const UNTIL = new Date('2026-11-13T15:30:00.000Z');
const QA = [{ id: 'customfield_10050', name: 'QA Assignee' }];

describe('Custom views - the Jira search stays the same', () => {
  for (const [edition, makeClient] of [['Jira Cloud', cloud], ['Data Center / Server', server]]) {
    it(`asks ${edition} exactly the same query, with or without views`, async () => {
      for (const options of [{}, { assignmentFields: QA }, { includeLogged: false }, { assignmentFields: QA, includeLogged: false }]) {
        const without = fakeJira();
        const withViews = fakeJira();
        await makeClient(without).getActiveIssues(SINCE, UNTIL, options);
        await makeClient(withViews).getActiveIssues(SINCE, UNTIL, { ...options, viewFields: ['priority', 'reporter', 'customfield_10100', 'status', 'assignee'] });
        const jql = (jira) => jira.searches()[0].searchParams.get('jql');
        assert.equal(jql(withViews), jql(without), JSON.stringify(options));
        assert.equal(jql(without), buildActiveIssuesJql('2026-10-29', '2026-11-14', (options.assignmentFields ?? []).map((f) => f.id), { includeLogged: options.includeLogged ?? true }));
        assert.equal(without.searches().length, 1);
        assert.equal(withViews.searches().length, 1, 'one search, never one per view');
      }
    });
  }

  it('makes exactly today\'s request, and returns exactly today\'s issues, without views', async () => {
    const plain = fakeJira();
    const none = fakeJira();
    const plainIssues = await cloud(plain).getActiveIssues(SINCE, UNTIL, { assignmentFields: QA });
    const noneIssues = await cloud(none).getActiveIssues(SINCE, UNTIL, { assignmentFields: QA, viewFields: undefined });
    assert.equal(plain.searches()[0].href, none.searches()[0].href);
    assert.equal(plain.searches()[0].searchParams.get('fields'), 'summary,status,assignee,customfield_10050,worklog');
    assert.deepEqual(noneIssues, plainIssues);
    assert.ok(plainIssues.every((issue) => !('viewFields' in issue)));
  });

  it('adds only the allow-listed fields views need and the search doesn\'t ask for already, once each', async () => {
    const jira = fakeJira();
    await cloud(jira).getActiveIssues(SINCE, UNTIL, {
      assignmentFields: QA,
      viewFields: ['status', 'priority', 'assignee', 'customfield_10050', 'reporter', 'priority', 'customfield_10100', 'summary', 'comment', 'labels', 'worklog', 'customfield_x', 'customfield_10100,labels']
    });
    assert.equal(jira.searches()[0].searchParams.get('fields'), 'summary,status,assignee,customfield_10050,worklog,priority,reporter,customfield_10100');
  });

  it('adds nothing for views on status or assignee, which the search returns already', async () => {
    const jira = fakeJira();
    const issues = await cloud(jira).getActiveIssues(SINCE, UNTIL, { viewFields: ['status', 'assignee'] });
    assert.equal(jira.searches()[0].searchParams.get('fields'), 'summary,status,assignee,worklog');
    assert.deepEqual(issues[0].viewFields, { status: { id: '3', label: 'In Progress' }, assignee: { isCurrentUser: true } });
  });

  it('returns the same issues with views: they only narrow the list on the page', async () => {
    const plain = await cloud(fakeJira()).getActiveIssues(SINCE, UNTIL, { assignmentFields: QA });
    const withViews = await cloud(fakeJira()).getActiveIssues(SINCE, UNTIL, { assignmentFields: QA, viewFields: ['priority'] });
    assert.deepEqual(withViews.map((issue) => issue.issueKey), plain.map((issue) => issue.issueKey));
    const highOnly = { id: 'v', name: 'High', conditions: [{ field: { id: 'priority', name: 'Priority' }, operator: 'equals', values: [{ id: '2', label: 'High' }] }] };
    const shown = withViews.filter((issue) => matchesView(issue, highOnly));
    assert.deepEqual(shown.map((issue) => issue.issueKey), ['KAN-1']);
    assert.ok(shown.every((issue) => withViews.includes(issue)), 'a subset of the loaded issues');
  });

  it('gives each issue the values its views compare, with people reduced to whether they\'re the user', async () => {
    const issues = await cloud(fakeJira()).getActiveIssues(SINCE, UNTIL, {
      assignmentFields: QA,
      viewFields: ['status', 'priority', 'assignee', 'reporter', 'customfield_10050', 'customfield_10100']
    });
    assert.deepEqual(issues.map((issue) => issue.viewFields), [
      { status: { id: '3', label: 'In Progress' }, priority: { id: '2', label: 'High' }, assignee: { isCurrentUser: true }, reporter: { isCurrentUser: false },
        customfield_10050: { isCurrentUser: false }, customfield_10100: { id: '10200', label: 'Platform' } },
      { status: { id: '4', label: 'In Review' }, priority: { id: '3', label: 'Medium' }, assignee: { isCurrentUser: true }, reporter: { isCurrentUser: true },
        customfield_10050: { isCurrentUser: true }, customfield_10100: null }
    ]);
  });

  it('never returns another person\'s identity', async () => {
    const issues = await cloud(fakeJira()).getActiveIssues(SINCE, UNTIL, {
      assignmentFields: QA, viewFields: ['assignee', 'reporter', 'customfield_10050']
    });
    const json = JSON.stringify(issues);
    for (const detail of [OTHER.accountId, OTHER.displayName, OTHER.emailAddress, ME.accountId, ME.emailAddress]) {
      assert.ok(!json.includes(detail), detail);
    }
  });
});

describe('Custom views - Status values come from every issue listed', () => {
  // A workflow like the one reported: Demo, In Progress, and Verify in the In Progress category, and
  // Selected for Development in To Do, listed only through the user's recent worklog.
  const recent = new Date(UNTIL.getTime() - 2 * 86400000).toISOString().replace('Z', '+0000');
  const status = (id, name, key) => ({ id, name, statusCategory: { key } });
  const RAW = [
    { id: '1', key: 'P-1', status: status('10100', 'Demo', 'indeterminate'), worklogs: [] },
    { id: '2', key: 'P-2', status: status('3', 'In Progress', 'indeterminate'), worklogs: [] },
    { id: '3', key: 'P-3', status: status('10101', 'Verify', 'indeterminate'), worklogs: [] },
    { id: '4', key: 'P-4', status: status('10102', 'Selected for Development', 'new'), worklogs: [{ id: 'w1', started: recent, timeSpentSeconds: 3600, author: ME }] }
  ];
  function workflowJira() {
    const fetchFn = async (rawUrl) => {
      const url = new URL(rawUrl);
      if (url.pathname.endsWith('/myself')) return jsonResponse(200, ME);
      const logged = url.searchParams.get('jql').includes('worklogAuthor');
      const asked = url.searchParams.get('fields').split(',');
      const found = RAW.filter((item) => item.status.statusCategory.key === 'indeterminate' || logged);
      return jsonResponse(200, {
        issues: found.map((item) => {
          const all = { summary: item.key, assignee: ME, status: item.status, worklog: { startAt: 0, maxResults: 20, total: item.worklogs.length, worklogs: item.worklogs } };
          return { id: item.id, key: item.key, fields: Object.fromEntries(asked.filter((f) => f in all).map((f) => [f, all[f]])) };
        }),
        total: found.length, startAt: 0, isLast: true
      });
    };
    return { fetchFn };
  }

  for (const [edition, makeClient] of [['Jira Cloud', cloud], ['Data Center / Server', server]]) {
    it(`offers on ${edition} the status of every issue listed, including one listed only through a recent worklog`, async () => {
      const issues = await makeClient(workflowJira()).getActiveIssues(SINCE, UNTIL, { viewFields: ['status'] });
      assert.deepEqual(issues.map((issue) => issue.issueStatus.name), ['Demo', 'In Progress', 'Verify', 'Selected for Development']);
      assert.deepEqual(valueOptions(issues, { id: 'status', kind: 'option' }), [
        { id: '10100', label: 'Demo' }, { id: '3', label: 'In Progress' }, { id: '10102', label: 'Selected for Development' }, { id: '10101', label: 'Verify' }
      ]);
    });
  }

  it('offers exactly the statuses of the issues listed, never more, never fewer', async () => {
    for (const includeLogged of [true, false]) {
      const issues = await cloud(workflowJira()).getActiveIssues(SINCE, UNTIL, { includeLogged, viewFields: ['status'] });
      const listed = [...new Set(issues.map((issue) => issue.issueStatus.name))].sort();
      assert.deepEqual(valueOptions(issues, { id: 'status', kind: 'option' }).map((option) => option.label).sort(), listed, String(includeLogged));
    }
  });
});

describe('Custom views - custom fields from Jira (GET /field)', () => {
  const FIELDS = [
    { id: 'customfield_10100', name: 'Team', custom: true, navigable: true, schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } },
    { id: 'customfield_10050', name: 'QA Assignee', custom: true, searchable: true, schema: { type: 'user', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker' } }
  ];

  it('lists the single-select fields, from the same request as the user picker fields', async () => {
    const jira = fakeJira({ fieldList: FIELDS });
    const client = cloud(jira);
    assert.deepEqual(await client.getSingleSelectFields(), [{ id: 'customfield_10100', name: 'Team', kind: 'option', type: 'select' }]);
    assert.deepEqual(await client.getUserPickerFields(), [{ id: 'customfield_10050', name: 'QA Assignee' }]);
    assert.deepEqual(jira.requests.map((url) => url.pathname), ['/rest/api/3/field', '/rest/api/3/field']);
  });

  it('asks Data Center / Server on REST API v2', async () => {
    const jira = fakeJira({ fieldList: FIELDS });
    await server(jira).getSingleSelectFields();
    assert.equal(jira.requests[0].pathname, '/rest/api/2/field');
  });

  it('rejects, never answering an empty list, when the fields can\'t be read', async () => {
    await assert.rejects(cloud(fakeJira({ fieldStatus: 500 })).getSingleSelectFields(), (err) => err.status === 500);
  });
});

describe('Custom views - the existing loading path', () => {
  const recordingClient = (calls) => ({ baseUrl: 'https://acme.atlassian.net', deploymentType: 'cloud', getActiveIssues: async (start, end, options) => { calls.push(options); return [{ issueKey: 'KAN-1' }]; } });

  it('passes the views\' fields to the same search, and nothing without views', async () => {
    const calls = [];
    await loadActiveIssues(recordingClient(calls), { viewFields: [] });
    await loadActiveIssues(recordingClient(calls), { viewFields: ['priority'] });
    assert.equal('viewFields' in calls[0], false);
    assert.deepEqual(calls[1].viewFields, ['priority']);
  });

  it('loads again when the views need other fields, and not when they don\'t', async () => {
    const calls = [];
    const states = [];
    const loader = createWorkingIssuesLoader((state) => states.push(state), { logError: () => {} });
    const client = recordingClient(calls);
    await loader.refresh(client, {});
    await loader.refresh(client, {});
    await loader.refresh(client, { viewFields: ['priority'] });
    await loader.refresh(client, { viewFields: ['priority'] });
    await loader.refresh(client, { viewFields: ['priority', 'reporter'] });
    assert.equal(calls.length, 3);
    assert.deepEqual(states.filter((s) => s.status === 'ready').map((s) => s.viewFields), [undefined, ['priority'], ['priority', 'reporter']]);
    assert.deepEqual(states[1], { status: 'ready', issues: [{ issueKey: 'KAN-1' }], includeRecentlyLogged: true }, 'unchanged without views');
  });

  it('is the only loader: no other module asks Jira for issues for views', () => {
    for (const path of ['../src/jira/customViews.js', '../src/ui/customViewEditor.js', '../src/ui/weekView.js']) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /\bfetch\(|searchIssues\(|from '[^']*(JiraClient|weeklyWorklogService|workingIssuesLoader|activeIssues)\.js'/, path);
    }
    const options = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
    assert.equal(options.match(/workingIssues\.refresh\(/g).length, 2, 'the two existing calls, nothing new');
    assert.doesNotMatch(options, /getActiveIssues\(|loadActiveIssues\(|searchIssues\(/);
  });

  it('asks for the fields the saved views compare', () => {
    assert.deepEqual(requiredViewFields([{ conditions: [{ field: { id: 'customfield_10100' } }] }]), ['customfield_10100']);
  });
});

describe('Custom views - storage per Jira site', () => {
  const SITE = 'cloud|https://acme.atlassian.net';
  const OTHER_SITE = 'server|https://jira.example.com';
  const view = (id, name) => ({ id, name, conditions: [{ field: { id: 'status', name: 'Status' }, operator: 'equals', values: [{ id: '3', label: 'In Progress' }] }] });

  it('saves a site\'s views, and reads them back', async () => {
    const store = createSettingsStore(createMemoryStorageArea());
    await store.saveCustomViews(SITE, [view('a', 'Development Queue')]);
    const settings = await store.load();
    assert.deepEqual(customViewsForSite(settings, SITE), { version: 1, views: [view('a', 'Development Queue')] });
    assert.deepEqual(customViewsForSite(settings, OTHER_SITE), { version: 1, views: [] });
  });

  it('never touches another site\'s entry, even one it can\'t read', async () => {
    const otherEntry = { version: 7, views: [{ anything: 'from a newer version' }] };
    const area = createMemoryStorageArea({ customViewsBySite: { [OTHER_SITE]: otherEntry } });
    const store = createSettingsStore(area);
    await store.saveCustomViews(SITE, [view('a', 'Queue')]);
    await store.saveCustomViews(SITE, []);
    const { customViewsBySite } = await area.get(['customViewsBySite']);
    assert.deepEqual(customViewsBySite, { [OTHER_SITE]: otherEntry });
  });

  it('leaves a site\'s views saved by another version untouched, refusing to change them', async () => {
    const entry = { version: 2, views: [{ id: 'x', future: true }] };
    const area = createMemoryStorageArea({ customViewsBySite: { [SITE]: entry } });
    const store = createSettingsStore(area);
    assert.deepEqual(customViewsForSite(await store.load(), SITE), { version: 1, views: [], unsupported: true });
    await assert.rejects(store.saveCustomViews(SITE, [view('a', 'Queue')]), /another version of Timesheet for Jira/);
    assert.deepEqual((await area.get(['customViewsBySite'])).customViewsBySite[SITE], entry);
  });

  it('refuses invalid views, more than two, or no site, saving nothing', async () => {
    const area = createMemoryStorageArea();
    const store = createSettingsStore(area);
    await assert.rejects(store.saveCustomViews(SITE, [{ id: 'a', name: 'All', conditions: [] }]), /aren't valid/);
    await assert.rejects(store.saveCustomViews(SITE, [view('a', 'One'), view('b', 'Two'), view('c', 'Three')]), /aren't valid/);
    await assert.rejects(store.saveCustomViews('', [view('a', 'One')]), /site is required/);
    assert.deepEqual(await area.get(null), {});
  });

  it('reads no views when nothing is stored', () => {
    assert.deepEqual(normalizeSettings({}).customViewsBySite, {});
  });
});

describe('Custom views - Jira\'s lists of statuses and priorities (no issue search)', () => {
  /** A fake Jira answering by path; anything else is 404. Records every request. */
  function listsJira(routes) {
    const requests = [];
    const fetchFn = async (rawUrl) => {
      const url = new URL(rawUrl);
      requests.push(url);
      const route = routes[`${url.pathname}${url.search}`] ?? routes[url.pathname];
      return route ? jsonResponse(route.status ?? 200, route.body) : jsonResponse(404, { errorMessages: ['Not found'] });
    };
    return { fetchFn, requests };
  }
  const STATUSES = [{ id: '3', name: 'In Progress' }, { id: '10413', name: 'Selected for Development', statusCategory: { key: 'new' } }];

  it('lists the statuses: GET /status on REST API v3 on Cloud, v2 on Data Center / Server', async () => {
    for (const [makeClient, path] of [[cloud, '/rest/api/3/status'], [server, '/rest/api/2/status']]) {
      const jira = listsJira({ [path]: { body: STATUSES } });
      assert.deepEqual(await makeClient(jira).getStatuses(), [{ id: '3', label: 'In Progress' }, { id: '10413', label: 'Selected for Development' }]);
      assert.deepEqual(jira.requests.map((url) => url.pathname), [path]);
    }
  });

  it('lists the priorities on Cloud with GET /priority/search, page by page', async () => {
    const jira = listsJira({
      '/rest/api/3/priority/search?startAt=0&maxResults=100': { body: { values: [{ id: '1', name: 'Highest' }], isLast: false } },
      '/rest/api/3/priority/search?startAt=1&maxResults=100': { body: { values: [{ id: '3', name: 'Medium' }], isLast: true } }
    });
    assert.deepEqual(await cloud(jira).getPriorities(), [{ id: '1', label: 'Highest' }, { id: '3', label: 'Medium' }]);
    assert.equal(jira.requests.length, 2);
  });

  it('lists the priorities with GET /priority where /priority/search doesn\'t exist', async () => {
    const dc = listsJira({ '/rest/api/2/priority': { body: [{ id: '10000', name: 'P1' }, { id: '2', name: 'High' }] } });
    assert.deepEqual(await server(dc).getPriorities(), [{ id: '2', label: 'High' }, { id: '10000', label: 'P1' }]);
    assert.deepEqual(dc.requests.map((url) => url.pathname), ['/rest/api/2/priority']);
    const oldCloud = listsJira({ '/rest/api/3/priority': { body: [{ id: '2', name: 'High' }] } });
    assert.deepEqual(await cloud(oldCloud).getPriorities(), [{ id: '2', label: 'High' }]);
    assert.ok(oldCloud.requests.some((url) => url.pathname === '/rest/api/3/priority'));
  });

  it('rejects, never answering an empty list, when Jira refuses', async () => {
    await assert.rejects(server(listsJira({ '/rest/api/2/status': { status: 500, body: {} } })).getStatuses(), (err) => err.status === 500);
    await assert.rejects(cloud(listsJira({ '/rest/api/3/priority/search': { status: 403, body: {} } })).getPriorities(), (err) => err.status === 403);
  });

  it('never searches issues for them: the scope stays the one search of My Active Issues', async () => {
    const jira = listsJira({ '/rest/api/2/status': { body: STATUSES }, '/rest/api/2/priority': { body: [] } });
    await server(jira).getStatuses();
    await server(jira).getPriorities();
    assert.ok(jira.requests.every((url) => !/\/search/.test(url.pathname)));
  });
});
