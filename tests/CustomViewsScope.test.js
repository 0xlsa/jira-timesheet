process.env.TZ = 'Europe/London';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JiraClient } from '../src/jira/JiraClient.js';
import { JiraCloudTokenProvider } from '../src/auth/JiraCloudTokenProvider.js';
import { JiraPatProvider } from '../src/auth/JiraPatProvider.js';
import { buildActiveIssuesJql } from '../src/jira/activeIssues.js';
import { loadActiveIssues } from '../src/worklog/weeklyWorklogService.js';
import { createSettingsStore, normalizeSettings, customViewsForSite } from '../src/settings/settingsStore.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';
import { buildCustomViewJql, CUSTOM_VIEW_RESULT_LIMIT } from '../src/jira/customViews.js';

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const ME = { accountId: 'me-123', displayName: 'Dev Me', emailAddress: 'dev@example.com' };
const OTHER = { accountId: 'other-456', displayName: 'Someone Else', emailAddress: 'someone@example.com' };

const status = (id, name, key = 'indeterminate') => ({ id, name, statusCategory: { key } });
const noWorklogs = { startAt: 0, maxResults: 20, total: 0, worklogs: [] };

/** Jira's issues, and who they belong to. */
const MINE_IN_PROGRESS = { id: '10001', key: 'KAN-1', fields: { summary: 'Mine', status: status('3', 'In Progress'), assignee: ME, reporter: OTHER, worklog: noWorklogs } };
const REPORTED_BACKLOG = { id: '10002', key: 'KAN-2', fields: { summary: 'Reported, in the backlog', status: status('10000', 'Backlog', 'new'), assignee: OTHER, reporter: ME, worklog: noWorklogs } };
const OTHERS_IN_PROGRESS = { id: '10003', key: 'KAN-3', fields: { summary: 'Someone else\'s', status: status('3', 'In Progress'), assignee: OTHER, reporter: OTHER, worklog: noWorklogs } };

const REPORTED_JQL = buildCustomViewJql({ conditions: [{ field: { id: 'reporter', name: 'Reporter' }, operator: 'equals', values: [{ currentUser: true, label: 'Me' }] }] });
const IN_PROGRESS_JQL = buildCustomViewJql({ conditions: [{ field: { id: 'status', name: 'Status' }, operator: 'equals', values: [{ id: '3', label: 'In Progress' }] }] });

/**
 * A fake Jira that answers each JQL with its own issues, as Jira would for this user: Active
 * Issues' search (whatever its dates) the user's issue in progress; Reporter = Me the reported one;
 * Status = In Progress both issues in progress. Each issue has only the fields asked for, as Jira
 * does. `extra` adds total, isLast, or nextPageToken to the view searches' answers. GET /field
 * answers `fieldList` (or fails with `fieldStatus`). Every request is recorded.
 */
function fakeJira({ extra = {}, status: searchStatus = 200, fieldList = [], fieldStatus = 200 } = {}) {
  const requests = [];
  const answers = (jql) => (jql === REPORTED_JQL ? [REPORTED_BACKLOG]
    : jql === IN_PROGRESS_JQL ? [MINE_IN_PROGRESS, OTHERS_IN_PROGRESS]
    : /^\(assignee = currentUser\(\)/.test(jql) || /^assignee = currentUser\(\)/.test(jql) ? [MINE_IN_PROGRESS]
    : []);
  const fetchFn = async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith('/myself')) return jsonResponse(200, ME);
    requests.push(url);
    if (url.pathname.endsWith('/field')) return fieldStatus === 200 ? jsonResponse(200, fieldList) : jsonResponse(fieldStatus, { errorMessages: ['No fields'] });
    if (searchStatus !== 200) return jsonResponse(searchStatus, { errorMessages: ['You can\'t search this.'] });
    const jql = url.searchParams.get('jql');
    const asked = url.searchParams.get('fields').split(',');
    const issues = answers(jql).map((issue) => ({ id: issue.id, key: issue.key, fields: Object.fromEntries(asked.filter((f) => f in issue.fields).map((f) => [f, issue.fields[f]])) }));
    const isView = jql === REPORTED_JQL || jql === IN_PROGRESS_JQL;
    return jsonResponse(200, { issues, ...(url.pathname.includes('/3/') ? { isLast: true } : { startAt: 0, total: issues.length }), ...(isView ? extra : {}) });
  };
  return { fetchFn, requests, searches: () => requests.filter((url) => /\/search/.test(url.pathname)) };
}

const cloud = (jira) => new JiraClient('https://acme.atlassian.net', new JiraCloudTokenProvider('dev@example.com', 'token'), { fetchFn: jira.fetchFn });
const server = (jira) => new JiraClient('https://jira.example.com', new JiraPatProvider('pat'), { fetchFn: jira.fetchFn });
const SINCE = new Date('2026-10-30T15:30:00.000Z');
const UNTIL = new Date('2026-11-13T15:30:00.000Z');
const keys = (issues) => issues.map((issue) => issue.issueKey);

describe('Custom views - Active Issues stays the same', () => {
  for (const [edition, makeClient, path] of [['Jira Cloud', cloud, '/rest/api/3/search/jql'], ['Data Center / Server', server, '/rest/api/2/search']]) {
    it(`asks ${edition} exactly the query and fields it asked before custom views`, async () => {
      const jira = fakeJira();
      await makeClient(jira).getActiveIssues(SINCE, UNTIL);
      const [search] = jira.searches();
      assert.equal(search.pathname, path);
      assert.equal(search.searchParams.get('jql'), buildActiveIssuesJql('2026-10-29', '2026-11-14', []));
      assert.equal(search.searchParams.get('fields'), 'summary,status,assignee,worklog');
      assert.equal(search.searchParams.get('maxResults'), '50');
    });
  }

  it('builds the same JQL as ever', () => {
    assert.equal(buildActiveIssuesJql('2026-10-29', '2026-11-14', []),
      '(assignee = currentUser() AND statusCategory = "In Progress") OR (worklogAuthor = currentUser() AND worklogDate >= "2026-10-29" AND worklogDate <= "2026-11-14") ORDER BY updated DESC');
    assert.equal(buildActiveIssuesJql('2026-10-29', '2026-11-14', [], { includeLogged: false }),
      'assignee = currentUser() AND statusCategory = "In Progress" ORDER BY updated DESC');
  });

  it('lists the same issues whether or not views searched Jira meanwhile', async () => {
    const jira = fakeJira();
    const client = cloud(jira);
    const before = await client.getActiveIssues(SINCE, UNTIL);
    await client.searchCustomViewIssues(REPORTED_JQL);
    await client.searchCustomViewIssues(IN_PROGRESS_JQL);
    assert.deepEqual(await client.getActiveIssues(SINCE, UNTIL), before);
    assert.deepEqual(keys(before), ['KAN-1']);
  });

  it('asks nothing about custom views: loadActiveIssues() passes only its own options', async () => {
    const calls = [];
    const client = { getActiveIssues: async (since, until, options) => { calls.push(options); return []; } };
    await loadActiveIssues(client, { includeRecentlyLogged: false, assignmentFields: [{ id: 'customfield_10050' }] });
    assert.deepEqual(Object.keys(calls[0]).sort(), ['assignmentFields', 'includeLogged', 'signal']);
  });
});

describe('Custom views - their own Jira search', () => {
  for (const [edition, makeClient, path] of [['Jira Cloud', cloud, '/rest/api/3/search/jql'], ['Data Center / Server', server, '/rest/api/2/search']]) {
    it(`asks ${edition} once, for the view's JQL and its first ${CUSTOM_VIEW_RESULT_LIMIT} issues`, async () => {
      const jira = fakeJira();
      await makeClient(jira).searchCustomViewIssues(REPORTED_JQL);
      const searches = jira.searches();
      assert.equal(searches.length, 1);
      assert.equal(searches[0].pathname, path);
      assert.equal(searches[0].searchParams.get('jql'), 'reporter = currentUser() ORDER BY updated DESC, key DESC');
      assert.equal(searches[0].searchParams.get('maxResults'), '20');
      assert.equal(searches[0].searchParams.get('fields'), 'summary,status');
      assert.equal(searches[0].searchParams.get('nextPageToken'), null);
      if (path.includes('/2/')) assert.equal(searches[0].searchParams.get('startAt'), '0');
    });
  }

  it('finds a reported issue Active Issues doesn\'t list: not assigned, not in progress, no recent worklog', async () => {
    const client = cloud(fakeJira());
    const active = await client.getActiveIssues(SINCE, UNTIL);
    const { issues } = await client.searchCustomViewIssues(REPORTED_JQL);
    assert.deepEqual(keys(issues), ['KAN-2']);
    assert.ok(!keys(active).includes('KAN-2'));
  });

  it('finds every issue in a status, someone else\'s too: no Active Issues restriction', async () => {
    const { issues } = await server(fakeJira()).searchCustomViewIssues(IN_PROGRESS_JQL);
    assert.deepEqual(keys(issues), ['KAN-1', 'KAN-3']);
  });

  it('lists exactly what Jira returns for the user: Jira\'s permissions decide, nothing is added', async () => {
    const { issues } = await cloud(fakeJira()).searchCustomViewIssues(REPORTED_JQL);
    assert.deepEqual(issues, [{ issueId: '10002', issueKey: 'KAN-2', issueSummary: 'Reported, in the backlog', issueStatus: issues[0].issueStatus }]);
    assert.equal(issues[0].issueStatus.name, 'Backlog');
  });

  it('never reads a person: the rows have the issue\'s key, summary, and status only', async () => {
    const jira = fakeJira();
    // Even a Jira that sends people anyway.
    const leaky = { fetchFn: async (url) => {
      const response = await jira.fetchFn(url);
      const body = await response.json();
      for (const issue of body.issues ?? []) issue.fields = { ...issue.fields, assignee: OTHER, reporter: OTHER };
      return jsonResponse(response.status, body);
    } };
    const { issues } = await cloud(leaky).searchCustomViewIssues(REPORTED_JQL);
    assert.doesNotMatch(JSON.stringify(issues), /other-456|Someone Else|someone@example\.com|me-123/);
  });

  it('says how many match on Data Center / Server, and that more match than it lists', async () => {
    const result = await server(fakeJira({ extra: { total: 147 } })).searchCustomViewIssues(REPORTED_JQL);
    assert.deepEqual({ total: result.total, hasMore: result.hasMore }, { total: 147, hasMore: true });
    const exact = await server(fakeJira({ extra: { total: 1 } })).searchCustomViewIssues(REPORTED_JQL);
    assert.deepEqual({ total: exact.total, hasMore: exact.hasMore }, { total: 1, hasMore: false });
  });

  it('says only that more match on Jira Cloud, whose search has no total', async () => {
    const more = await cloud(fakeJira({ extra: { isLast: false, nextPageToken: 'next' } })).searchCustomViewIssues(REPORTED_JQL);
    assert.deepEqual({ total: more.total, hasMore: more.hasMore }, { total: null, hasMore: true });
    const last = await cloud(fakeJira()).searchCustomViewIssues(REPORTED_JQL);
    assert.deepEqual({ total: last.total, hasMore: last.hasMore }, { total: null, hasMore: false });
  });

  it('never asks for another page, however many match', async () => {
    for (const [makeClient, extra] of [[cloud, { isLast: false, nextPageToken: 'next' }], [server, { total: 5000 }]]) {
      const jira = fakeJira({ extra });
      await makeClient(jira).searchCustomViewIssues(REPORTED_JQL);
      assert.equal(jira.searches().length, 1);
    }
  });

  it('keeps an issue Jira returns twice once', async () => {
    const twice = { fetchFn: async () => jsonResponse(200, { issues: [REPORTED_BACKLOG, REPORTED_BACKLOG], isLast: true }) };
    assert.deepEqual(keys((await cloud(twice).searchCustomViewIssues(REPORTED_JQL)).issues), ['KAN-2']);
  });

  it('rejects with Jira\'s status when Jira refuses the search', async () => {
    await assert.rejects(cloud(fakeJira({ status: 400 })).searchCustomViewIssues(REPORTED_JQL), (err) => err.status === 400);
    await assert.rejects(server(fakeJira({ status: 401 })).searchCustomViewIssues(REPORTED_JQL), (err) => err.status === 401);
  });
});

describe('Custom views - Jira\'s suggestions for a custom field\'s values', () => {
  function suggestionsJira(body, responseStatus = 200) {
    const requests = [];
    return { requests, fetchFn: async (rawUrl) => { requests.push(new URL(rawUrl)); return jsonResponse(responseStatus, body); } };
  }

  it('asks GET /jql/autocompletedata/suggestions for the field\'s number and what was typed', async () => {
    for (const [makeClient, path] of [[cloud, '/rest/api/3/jql/autocompletedata/suggestions'], [server, '/rest/api/2/jql/autocompletedata/suggestions']]) {
      const jira = suggestionsJira({ results: [{ value: 'Platform', displayName: '<b>Pl</b>atform' }] });
      assert.deepEqual(await makeClient(jira).getFieldValueSuggestions('customfield_10100', 'Pl'), [{ id: 'Platform', label: 'Platform' }]);
      assert.equal(jira.requests[0].pathname, path);
      assert.equal(jira.requests[0].searchParams.get('fieldName'), 'cf[10100]');
      assert.equal(jira.requests[0].searchParams.get('fieldValue'), 'Pl');
    }
  });

  it('asks only for custom fields, without a request otherwise', async () => {
    const jira = suggestionsJira({ results: [] });
    await assert.rejects(cloud(jira).getFieldValueSuggestions('status', ''), /custom fields/);
    await assert.rejects(cloud(jira).getFieldValueSuggestions('customfield_1 OR x', ''), /custom fields/);
    assert.equal(jira.requests.length, 0);
  });

  it('rejects when Jira can\'t be asked', async () => {
    await assert.rejects(server(suggestionsJira({}, 500)).getFieldValueSuggestions('customfield_10100'), (err) => err.status === 500);
  });
});

describe('Custom views - apart from Active Issues\' loading', () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('searches through their own module, which never uses Active Issues\' loader', () => {
    assert.doesNotMatch(source('../src/jira/customViewSearch.js'), /import |fetch\(/);
    for (const path of ['../src/worklog/workingIssuesLoader.js', '../src/worklog/weeklyWorklogService.js', '../src/jira/activeIssues.js']) {
      assert.doesNotMatch(source(path), /customView|viewFields/, path);
    }
  });

  it('leaves Active Issues\' calls on the page as they were', () => {
    const options = source('../options.js');
    assert.equal(options.match(/workingIssues\.refresh\(/g).length, 2);
    assert.doesNotMatch(options, /viewFields|hasCustomViews/);
    assert.match(options, /includeRecentlyLogged: settings\.showRecentlyLoggedIssues\n/);
    assert.match(options, /includeRecentlyLogged: savedSettings\?\.showRecentlyLoggedIssues === true,\n\s*keepShown\n/);
  });

  it('never fetches from the rules, the editor, or the view', () => {
    for (const path of ['../src/jira/customViews.js', '../src/ui/customViewEditor.js', '../src/ui/weekView.js']) {
      assert.doesNotMatch(source(path), /\bfetch\(|searchIssues\(|from '[^']*(JiraClient|weeklyWorklogService|workingIssuesLoader|activeIssues)\.js'/, path);
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
    await assert.rejects(store.saveCustomViews(SITE, [{ id: 'a', name: 'Active', conditions: [] }]), /aren't valid/);
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

  it('never searches issues for them', async () => {
    const jira = listsJira({ '/rest/api/2/status': { body: STATUSES }, '/rest/api/2/priority': { body: [] } });
    await server(jira).getStatuses();
    await server(jira).getPriorities();
    assert.ok(jira.requests.every((url) => !/\/search/.test(url.pathname)));
  });
});
