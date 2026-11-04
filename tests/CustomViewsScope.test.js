process.env.TZ = 'Europe/London';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JiraClient } from '../src/jira/JiraClient.js';
import { JiraCloudTokenProvider } from '../src/auth/JiraCloudTokenProvider.js';
import { JiraPatProvider } from '../src/auth/JiraPatProvider.js';
import { buildActiveIssuesJql } from '../src/jira/activeIssues.js';
import { loadActiveIssues } from '../src/worklog/weeklyWorklogService.js';
import { createSettingsStore, normalizeSettings, customViewsForSite, customViewOrderForSite } from '../src/settings/settingsStore.js';
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

const REPORTED_JQL = buildCustomViewJql({ conditions: [{ field: { id: 'reporter', name: 'Reporter' }, operator: 'in', values: [{ currentUser: true, label: 'Me' }] }] });
const IN_PROGRESS_JQL = buildCustomViewJql({ conditions: [{ field: { id: 'status', name: 'Status' }, operator: 'in', values: [{ id: '3', label: 'In Progress' }] }] });

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
      assert.equal(searches[0].searchParams.get('jql'), 'reporter in (currentUser()) ORDER BY updated DESC, key DESC');
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

describe('Custom views - custom user fields (such as QA Assignee)', () => {
  const PICKER = 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker';
  const FIELDS = [
    { id: 'customfield_13931', name: 'QA Assignee', custom: true, searchable: true, schema: { type: 'user', custom: PICKER } },
    { id: 'customfield_10600', name: 'Development Lead', custom: true, searchable: true, schema: { type: 'user', custom: PICKER } },
    { id: 'customfield_13802', name: 'Doc reviewers', custom: true, searchable: true, schema: { type: 'array', items: 'user', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:multiuserpicker' } },
    { id: 'customfield_14000', name: 'Hidden Picker', custom: true, searchable: false, schema: { type: 'user', custom: PICKER } },
    { id: 'assignee', name: 'Assignee', custom: false, searchable: true, schema: { type: 'user', system: 'assignee' } },
    { id: 'customfield_11300', name: 'Assigned Team', custom: true, navigable: true, searchable: true, schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } },
    { id: 'customfield_12000', name: 'Components (multi)', custom: true, searchable: true, schema: { type: 'array', items: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:multiselect' } }
  ];

  for (const [edition, makeClient, path] of [['Jira Cloud', cloud, '/rest/api/3/field'], ['Data Center / Server', server, '/rest/api/2/field']]) {
    it(`lists ${edition}'s searchable single-user fields and single-select fields, from one GET /field`, async () => {
      const jira = fakeJira({ fieldList: FIELDS });
      const { singleSelect, userPickers } = await makeClient(jira).getCustomViewFields();
      assert.deepEqual(userPickers, [{ id: 'customfield_10600', name: 'Development Lead' }, { id: 'customfield_13931', name: 'QA Assignee' }]);
      assert.deepEqual(singleSelect.map((field) => field.id), ['customfield_11300']);
      assert.deepEqual(jira.requests.map((url) => url.pathname), [path]);
    });
  }

  it('finds an issue assigned to the user only through a custom user field, outside Active', async () => {
    const QA_ONLY = { id: '10009', key: 'KAN-9', fields: { summary: 'QA it', status: status('10413', 'Selected for Development', 'new'), assignee: OTHER, customfield_13931: ME } };
    const asked = [];
    const fetchFn = async (rawUrl) => {
      const url = new URL(rawUrl);
      if (url.pathname.endsWith('/myself')) return jsonResponse(200, ME);
      const jql = url.searchParams.get('jql');
      asked.push(jql);
      const issues = jql.includes('cf[13931] in (currentUser())') ? [QA_ONLY] : jql.startsWith('(assignee = currentUser()') ? [MINE_IN_PROGRESS] : [];
      return jsonResponse(200, { issues, isLast: true });
    };
    const client = cloud({ fetchFn });
    const qa = { field: { id: 'customfield_13931', name: 'QA Assignee' }, operator: 'in', values: [{ currentUser: true, label: 'Me' }] };
    const selected = { field: { id: 'status', name: 'Status' }, operator: 'in', values: [{ id: '10413', label: 'Selected for Development' }] };
    const allowed = { userFieldIds: ['customfield_13931'] };

    const active = await client.getActiveIssues(SINCE, UNTIL);
    const alone = await client.searchCustomViewIssues(buildCustomViewJql({ conditions: [qa] }, allowed));
    const withStatus = await client.searchCustomViewIssues(buildCustomViewJql({ conditions: [selected, qa] }, allowed));
    assert.deepEqual(keys(active), ['KAN-1']);
    assert.deepEqual(keys(alone.issues), ['KAN-9']);
    assert.deepEqual(keys(withStatus.issues), ['KAN-9']);
    assert.ok(asked.includes('cf[13931] in (currentUser()) ORDER BY updated DESC, key DESC'));
    assert.ok(asked.includes('status in (10413) AND cf[13931] in (currentUser()) ORDER BY updated DESC, key DESC'));
    // Never the person: rows have the issue's key, summary, and status only.
    assert.doesNotMatch(JSON.stringify(alone.issues), /me-123|Dev Me|other-456/);
  });
});

describe('Custom views - In and Not in against Jira, with no implicit conditions', () => {
  // Issues as Jira holds them: status and priority IDs, people by who they are (me or someone else),
  // a QA user field, and a team. SECRET is one the user can't browse.
  const PENDING = '10100';
  const VERIFY = '10200';
  const DEVELOPMENT = '10300';
  const DATA = [
    { key: 'KAN-1', status: DEVELOPMENT, priority: '2', assignee: 'me', reporter: 'other', qa: 'other', team: 'Sega' },
    { key: 'KAN-2', status: DEVELOPMENT, priority: '3', assignee: 'other', reporter: 'other', qa: 'me', team: null },
    { key: 'KAN-3', status: PENDING, priority: '2', assignee: 'other', reporter: 'me', qa: null, team: 'Devops' },
    { key: 'KAN-4', status: VERIFY, priority: '1', assignee: null, reporter: 'other', qa: 'other', team: 'Sega' },
    { key: 'KAN-5', status: '10400', priority: null, assignee: 'other', reporter: 'other', qa: null, team: null },
    { key: 'SECRET-1', status: DEVELOPMENT, priority: '1', assignee: 'other', reporter: 'other', qa: 'other', team: null, hidden: true }
  ];
  const FIELD = { status: 'status', priority: 'priority', assignee: 'assignee', reporter: 'reporter', 'cf[13931]': 'qa', 'cf[11300]': 'team' };

  /** Evaluates the JQL views generate, as Jira would: clauses with AND, IN / NOT IN, IS EMPTY. */
  function matches(issue, jql) {
    const where = jql.replace(/ ORDER BY .*$/, '');
    return where.split(' AND ').every((clause) => {
      const value = (list) => list.split(', ').map((item) => (item === 'currentUser()' ? 'me' : item.replace(/^"(.*)"$/, '$1')));
      let m = /^\((\S+) not in \((.*)\) OR (\S+) is EMPTY\)$/.exec(clause);
      if (m) {
        const actual = issue[FIELD[m[1]]];
        return actual === null || !value(m[2]).includes(actual);
      }
      m = /^(\S+) (in|not in) \((.*)\)$/.exec(clause);
      if (!m) throw new Error(`Unexpected clause: ${clause}`);
      const actual = issue[FIELD[m[1]]];
      // Jira's own NOT IN: an empty field never matches.
      if (actual === null) return false;
      return m[2] === 'in' ? value(m[3]).includes(actual) : !value(m[3]).includes(actual);
    });
  }

  function evaluatingJira() {
    const asked = [];
    const fetchFn = async (rawUrl) => {
      const url = new URL(rawUrl);
      const jql = url.searchParams.get('jql');
      asked.push(jql);
      // Jira's permissions decide: issues the user can't browse are never returned.
      const issues = DATA.filter((issue) => !issue.hidden && matches(issue, jql))
        .map((issue) => ({ id: issue.key, key: issue.key, fields: { summary: issue.key, status: { id: issue.status, name: issue.status } } }));
      return jsonResponse(200, { issues, startAt: 0, total: issues.length });
    };
    return { fetchFn, asked };
  }

  const condition = (id, operator, values) => ({ field: { id, name: id }, operator, values });
  const ids = (list) => list.map((id) => ({ id, label: id }));
  const me = [{ currentUser: true, label: 'Me' }];
  const QA = { userFieldIds: ['customfield_13931'] };
  async function run(conditions, context = {}) {
    const jira = evaluatingJira();
    const { issues } = await server(jira).searchCustomViewIssues(buildCustomViewJql({ conditions }, context));
    return { keys: keys(issues), jql: jira.asked[0] };
  }

  it('Status Not in Pending, Verify finds issues in every other status, whoever they belong to', async () => {
    const { keys: found, jql } = await run([condition('status', 'notIn', ids([PENDING, VERIFY]))]);
    assert.deepEqual(found, ['KAN-1', 'KAN-2', 'KAN-5']);
    assert.ok(found.includes('KAN-2') && found.includes('KAN-5'), 'assigned to someone else');
    assert.equal(jql, `status not in (${PENDING}, ${VERIFY}) ORDER BY updated DESC, key DESC`);
  });

  it('Status In Development finds matching issues whatever their assignee', async () => {
    assert.deepEqual((await run([condition('status', 'in', ids([DEVELOPMENT]))])).keys, ['KAN-1', 'KAN-2']);
  });

  it('restricts to the user only through a user condition chosen explicitly', async () => {
    assert.deepEqual((await run([condition('status', 'in', ids([DEVELOPMENT])), condition('assignee', 'in', me)])).keys, ['KAN-1']);
    assert.deepEqual((await run([condition('status', 'in', ids([DEVELOPMENT])), condition('customfield_13931', 'in', me)], QA)).keys, ['KAN-2']);
  });

  it('intersects Status Not in with Assignee In Me', async () => {
    assert.deepEqual((await run([condition('status', 'notIn', ids([PENDING, VERIFY])), condition('assignee', 'in', me)])).keys, ['KAN-1']);
  });

  it('Not in Me also finds issues with nobody in the field', async () => {
    assert.deepEqual((await run([condition('assignee', 'notIn', me)])).keys, ['KAN-2', 'KAN-3', 'KAN-4', 'KAN-5'], 'KAN-4 is unassigned');
    assert.deepEqual((await run([condition('customfield_13931', 'notIn', me)], QA)).keys, ['KAN-1', 'KAN-3', 'KAN-4', 'KAN-5'], 'KAN-3 and KAN-5 have no QA');
    assert.deepEqual((await run([condition('priority', 'notIn', ids(['1', '2']))])).keys, ['KAN-2', 'KAN-5'], 'KAN-5 has no priority');
    assert.deepEqual((await run([condition('customfield_11300', 'notIn', [{ id: 'Sega', label: 'Sega' }])])).keys, ['KAN-2', 'KAN-3', 'KAN-5']);
  });

  it('In on a custom user field and a select field, combined with Priority', async () => {
    assert.deepEqual((await run([condition('priority', 'in', ids(['2', '3'])), condition('customfield_13931', 'in', me)], QA)).keys, ['KAN-2']);
    assert.deepEqual((await run([condition('customfield_11300', 'in', [{ id: 'Sega', label: 'Sega' }]), condition('reporter', 'notIn', me)])).keys, ['KAN-1', 'KAN-4']);
  });

  it('lists only what Jira returns: an issue the user can\'t browse never appears', async () => {
    const { keys: found } = await run([condition('status', 'in', ids([DEVELOPMENT]))]);
    assert.ok(!found.includes('SECRET-1'));
  });
});

describe('Custom views - Jira sorts before it limits', () => {
  it('asks Jira for its first 20 issues in the view\'s order, keeping the total', async () => {
    const requests = [];
    const fetchFn = async (rawUrl) => {
      requests.push(new URL(rawUrl));
      return jsonResponse(200, { issues: [REPORTED_BACKLOG], startAt: 0, total: 147 });
    };
    const view = { conditions: [{ field: { id: 'reporter', name: 'Reporter' }, operator: 'in', values: [{ currentUser: true, label: 'Me' }] }], orderBy: { field: 'priority', direction: 'ASC' } };
    const result = await server({ fetchFn }).searchCustomViewIssues(buildCustomViewJql(view));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get('jql'), 'reporter in (currentUser()) ORDER BY priority ASC, key ASC');
    assert.equal(requests[0].searchParams.get('maxResults'), '20');
    assert.equal(requests[0].searchParams.get('startAt'), '0');
    assert.deepEqual({ total: result.total, hasMore: result.hasMore }, { total: 147, hasMore: true });
  });

  it('lists the issues in Jira\'s order, never sorting them again', async () => {
    const order = [OTHERS_IN_PROGRESS, MINE_IN_PROGRESS, REPORTED_BACKLOG];
    const fetchFn = async () => jsonResponse(200, { issues: order, isLast: true });
    const { issues } = await cloud({ fetchFn }).searchCustomViewIssues('status in (3) ORDER BY key DESC');
    assert.deepEqual(keys(issues), ['KAN-3', 'KAN-1', 'KAN-2']);
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
  const view = (id, name, orderBy = { field: 'updated', direction: 'DESC' }) => ({ id, name, conditions: [{ field: { id: 'status', name: 'Status' }, operator: 'in', values: [{ id: '3', label: 'In Progress' }] }], orderBy });

  describe('tab order', () => {
    const order = (settings, site = SITE) => customViewOrderForSite(settings, site);

    it('saves a site\'s order on its own, keeping the views exactly as stored', async () => {
      const area = createMemoryStorageArea();
      const store = createSettingsStore(area);
      const views = [view('a', 'One'), view('b', 'Two'), view('c', 'Three')];
      await store.saveCustomViews(SITE, views);
      const { customViewsBySite: before } = await area.get(['customViewsBySite']);
      await store.saveCustomViewOrder(SITE, ['c', 'a', 'b']);
      const { customViewsBySite: after, customViewOrderBySite } = await area.get(['customViewsBySite', 'customViewOrderBySite']);
      assert.deepEqual(after, before, 'the views aren\'t rewritten');
      assert.deepEqual(customViewOrderBySite, { [SITE]: ['c', 'a', 'b'] });
      assert.deepEqual(order(await store.load()), ['c', 'a', 'b'], 'and read back after a reload');
    });

    it('keeps each site\'s order apart, and never touches another\'s, nor other settings', async () => {
      const area = createMemoryStorageArea({ customViewOrderBySite: { [OTHER_SITE]: ['x', 'y'] }, showRecentlyLoggedIssues: true });
      const store = createSettingsStore(area);
      await store.saveCustomViewOrder(SITE, ['b', 'a']);
      const settings = await store.load();
      assert.deepEqual(order(settings), ['b', 'a']);
      assert.deepEqual(order(settings, OTHER_SITE), ['x', 'y']);
      assert.equal(settings.showRecentlyLoggedIssues, true);
      assert.deepEqual(order(normalizeSettings({}), 'cloud|https://elsewhere.atlassian.net'), [], 'none saved: as the views are saved');
    });

    it('leaves an order or views saved by another version untouched, refusing to change them', async () => {
      const newer = { version: 3, ids: ['a'] };
      const area = createMemoryStorageArea({ customViewOrderBySite: { [SITE]: newer } });
      await assert.rejects(createSettingsStore(area).saveCustomViewOrder(SITE, ['b', 'a']), /another version/);
      assert.deepEqual((await area.get(['customViewOrderBySite'])).customViewOrderBySite[SITE], newer);
      const newerViews = createMemoryStorageArea({ customViewsBySite: { [SITE]: { version: 9, views: [] } } });
      await assert.rejects(createSettingsStore(newerViews).saveCustomViewOrder(SITE, ['a']), /another version/);
      assert.equal((await newerViews.get(['customViewOrderBySite'])).customViewOrderBySite, undefined);
    });

    it('refuses an order that isn\'t valid IDs, each once, or no site', async () => {
      const area = createMemoryStorageArea();
      const store = createSettingsStore(area);
      for (const ids of [['a', 'a'], ['bad id!'], ['all'], 'a,b', ['1', '2', '3', '4', '5', '6']]) {
        await assert.rejects(store.saveCustomViewOrder(SITE, ids), /isn't valid/, JSON.stringify(ids));
      }
      await assert.rejects(store.saveCustomViewOrder('', ['a']), /site is required/);
      assert.deepEqual(await area.get(null), {});
    });
  });

  it('saves five views for a site, and reads them back in order', async () => {
    const store = createSettingsStore(createMemoryStorageArea());
    const five = ['One', 'Two', 'Three', 'Four', 'Five'].map((name, i) => view(`v${i}`, name));
    await store.saveCustomViews(SITE, five);
    assert.deepEqual(customViewsForSite(await store.load(), SITE).views.map((v) => v.name), ['One', 'Two', 'Three', 'Four', 'Five']);
  });

  it('saves a site\'s views, and reads them back', async () => {
    const store = createSettingsStore(createMemoryStorageArea());
    await store.saveCustomViews(SITE, [view('a', 'Development Queue')]);
    const settings = await store.load();
    assert.deepEqual(customViewsForSite(settings, SITE), { version: 1, views: [view('a', 'Development Queue')] });
    assert.deepEqual(customViewsForSite(settings, OTHER_SITE), { version: 1, views: [] });
  });

  it('reads views saved with Equals or Is one of as In, keeping their values, order, ID, and name', async () => {
    const stored = { version: 1, views: [{ id: 'old', name: 'Old one', orderBy: { field: 'duedate', direction: 'ASC' }, conditions: [
      { field: { id: 'status', name: 'Status' }, operator: 'isOneOf', values: [{ id: '3', label: 'In Progress' }, { id: '4', label: 'In Review' }] },
      { field: { id: 'reporter', name: 'Reporter' }, operator: 'equals', values: [{ currentUser: true, label: 'Me' }] }
    ] }] };
    const otherEntry = { version: 9, views: [{ from: 'a newer version' }] };
    const area = createMemoryStorageArea({ customViewsBySite: { [SITE]: stored, [OTHER_SITE]: otherEntry } });
    const store = createSettingsStore(area);
    const [view] = customViewsForSite(await store.load(), SITE).views;
    assert.deepEqual({ id: view.id, name: view.name, orderBy: view.orderBy }, { id: 'old', name: 'Old one', orderBy: { field: 'duedate', direction: 'ASC' } });
    assert.deepEqual(view.conditions.map((c) => [c.field.id, c.operator, c.values.map((v) => v.id ?? 'me')]), [['status', 'in', ['3', '4']], ['reporter', 'in', ['me']]]);
    // Saved again (with In), and the newer version's entry left as it was.
    await store.saveCustomViews(SITE, [view]);
    const { customViewsBySite } = await area.get(['customViewsBySite']);
    assert.deepEqual(customViewsBySite[SITE].views[0].conditions.map((c) => c.operator), ['in', 'in']);
    assert.deepEqual(customViewsBySite[OTHER_SITE], otherEntry);
  });

  it('saves each view\'s order, and reads a view saved without one as Updated descending', async () => {
    const store = createSettingsStore(createMemoryStorageArea());
    await store.saveCustomViews(SITE, [view('a', 'By priority', { field: 'priority', direction: 'ASC' }), view('b', 'Default')]);
    assert.deepEqual(customViewsForSite(await store.load(), SITE).views.map((v) => v.orderBy), [{ field: 'priority', direction: 'ASC' }, { field: 'updated', direction: 'DESC' }]);
    const old = createSettingsStore(createMemoryStorageArea({ customViewsBySite: { [SITE]: { version: 1, views: [{ id: 'x', name: 'Old', conditions: view('x', 'Old').conditions }] } } }));
    assert.deepEqual(customViewsForSite(await old.load(), SITE).views[0].orderBy, { field: 'updated', direction: 'DESC' });
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

  it('refuses invalid views, more than five, or no site, saving nothing', async () => {
    const area = createMemoryStorageArea();
    const store = createSettingsStore(area);
    await assert.rejects(store.saveCustomViews(SITE, [{ id: 'a', name: 'Active', conditions: [] }]), /aren't valid/);
    const six = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((name, i) => view(`v${i}`, name));
    await assert.rejects(store.saveCustomViews(SITE, six), /aren't valid/);
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
