process.env.TZ = 'Europe/London';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import {
  parseUserPickerFields, normalizeAssignmentFields, normalizeAssignmentFieldsBySite, assignmentFieldClause,
  withDuplicateHints, USER_PICKER_SCHEMA, MAX_ASSIGNMENT_FIELDS
} from '../src/jira/assignmentFields.js';
import { buildActiveIssuesJql } from '../src/jira/activeIssues.js';
import { JiraClient } from '../src/jira/JiraClient.js';
import { JiraCloudTokenProvider } from '../src/auth/JiraCloudTokenProvider.js';
import { JiraPatProvider } from '../src/auth/JiraPatProvider.js';
import { loadActiveIssues } from '../src/worklog/weeklyWorklogService.js';
import { createWorkingIssuesLoader } from '../src/worklog/workingIssuesLoader.js';
import { createSettingsStore, normalizeSettings, assignmentFieldsForSite } from '../src/settings/settingsStore.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';
import {
  createAssignmentFieldsSettings, NOT_CONNECTED_MESSAGE, NO_FIELDS_MESSAGE, FIELDS_UNAVAILABLE_MESSAGE, SAVE_FAILED_MESSAGE
} from '../src/ui/assignmentFieldsSettings.js';
import { getWeekRange } from '../src/worklog/worklogUtils.js';

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Fields as GET /field returns them (Cloud and Data Center / Server share this shape).
const userPicker = (id, name, extra = {}) => ({
  id, key: id, name, custom: true, orderable: true, navigable: true, searchable: true,
  clauseNames: [`cf[${id.split('_')[1]}]`, name],
  schema: { type: 'user', custom: USER_PICKER_SCHEMA, customId: Number(id.split('_')[1]) },
  ...extra
});
const QA = userPicker('customfield_10050', 'QA Assignee');
const REVIEWER = userPicker('customfield_10060', 'Reviewer');
const REVIEWER_TOO = userPicker('customfield_10070', 'reviewer');
const FIELDS = [
  { id: 'assignee', name: 'Assignee', custom: false, searchable: true, schema: { type: 'user', system: 'assignee' } },
  { id: 'reporter', name: 'Reporter', custom: false, searchable: true, schema: { type: 'user', system: 'reporter' } },
  { id: 'summary', name: 'Summary', custom: false, searchable: true, schema: { type: 'string', system: 'summary' } },
  REVIEWER,
  QA,
  { id: 'customfield_10080', name: 'Watchers team', custom: true, searchable: true,
    schema: { type: 'array', items: 'user', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:multiuserpicker', customId: 10080 } },
  { id: 'customfield_10090', name: 'Team', custom: true, searchable: true,
    schema: { type: 'group', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:grouppicker', customId: 10090 } },
  { id: 'customfield_10100', name: 'Story Points', custom: true, searchable: true,
    schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float', customId: 10100 } },
  userPicker('customfield_10110', 'Hidden user', { searchable: false }),
  { ...userPicker('customfield_10120', 'Third-party user'), schema: { type: 'user', custom: 'com.example.plugin:userfield', customId: 10120 } },
  REVIEWER_TOO
];

describe('Additional assignment fields - discovering fields', () => {
  it('offers only searchable single-user custom fields, by name', () => {
    assert.deepEqual(parseUserPickerFields(FIELDS), [
      { id: 'customfield_10050', name: 'QA Assignee' },
      { id: 'customfield_10060', name: 'Reviewer' },
      { id: 'customfield_10070', name: 'reviewer' }
    ]);
  });

  it('leaves out Assignee and other system fields, multi-user, group, number, unsearchable, and other plugins\' fields', () => {
    const ids = parseUserPickerFields(FIELDS).map((field) => field.id);
    for (const id of ['assignee', 'reporter', 'summary', 'customfield_10080', 'customfield_10090', 'customfield_10100', 'customfield_10110', 'customfield_10120']) {
      assert.ok(!ids.includes(id), id);
    }
  });

  it('ignores fields without an ID or name, and lists each ID once', () => {
    assert.deepEqual(parseUserPickerFields([QA, { ...QA, name: 'Copy' }, { ...QA, id: '' }, { ...QA, id: 'customfield_x' }, { ...QA, id: 'customfield_1', name: '  ' }, null]),
      [{ id: 'customfield_10050', name: 'QA Assignee' }]);
  });

  it('rejects a response that is not a list rather than reporting no fields', () => {
    assert.throws(() => parseUserPickerFields({ errorMessages: [] }), /unexpected/);
    assert.throws(() => parseUserPickerFields(null), /unexpected/);
  });

  it('tells fields with the same name apart by their ID', () => {
    assert.deepEqual(withDuplicateHints(parseUserPickerFields(FIELDS)).map((field) => [field.name, field.hint]), [
      ['QA Assignee', ''],
      ['Reviewer', 'customfield_10060'],
      ['reviewer', 'customfield_10070']
    ]);
  });
});

describe('Additional assignment fields - query', () => {
  const NO_FIELDS = '(assignee = currentUser() AND statusCategory = "In Progress") OR ' +
    '(worklogAuthor = currentUser() AND worklogDate >= "2026-10-25" AND worklogDate <= "2026-11-02") ORDER BY updated DESC';

  it('keeps the existing query exactly when no fields are configured', () => {
    assert.equal(buildActiveIssuesJql('2026-10-25', '2026-11-02'), NO_FIELDS);
    assert.equal(buildActiveIssuesJql('2026-10-25', '2026-11-02', []), NO_FIELDS);
  });

  it('adds one field to the assignee condition, by its cf[] clause', () => {
    assert.equal(buildActiveIssuesJql('2026-10-25', '2026-11-02', ['customfield_10050']),
      '((assignee = currentUser() OR cf[10050] = currentUser()) AND statusCategory = "In Progress") OR ' +
      '(worklogAuthor = currentUser() AND worklogDate >= "2026-10-25" AND worklogDate <= "2026-11-02") ORDER BY updated DESC');
  });

  it('combines several fields with OR, keeping the standard assignee', () => {
    assert.match(buildActiveIssuesJql('2026-10-25', '2026-11-02', ['customfield_10050', 'customfield_10060']),
      /^\(\(assignee = currentUser\(\) OR cf\[10050\] = currentUser\(\) OR cf\[10060\] = currentUser\(\)\) AND statusCategory = "In Progress"\) OR /);
  });

  it('never puts anything but a custom field number into the query', () => {
    assert.equal(assignmentFieldClause('customfield_10050'), 'cf[10050]');
    for (const id of ['assignee', 'QA Assignee', 'customfield_1) OR (1=1', 'cf[10050]', '']) {
      assert.throws(() => assignmentFieldClause(id), /Not a custom field ID/, id);
    }
  });
});

// The fake Jira: /myself is ME; /field lists FIELDS (or fails); the search evaluates the active
// issues JQL, including cf[] clauses, against `issues`.
const ME = { accountId: 'me', displayName: 'Dev', name: 'dev', key: 'dev' };
const OTHER = { accountId: 'other', displayName: 'Someone Else', name: 'other', key: 'other' };
const WEEK = getWeekRange(new Date(2026, 9, 26));

function fakeJira({ issues = [], fieldStatus = 200, fieldBody = FIELDS, v3FieldMissing = false } = {}) {
  const requests = [];
  const fetchFn = async (rawUrl) => {
    const url = new URL(rawUrl);
    requests.push(url);
    if (url.pathname.endsWith('/myself')) return jsonResponse(200, ME);
    if (url.pathname.endsWith('/field')) {
      if (v3FieldMissing && url.pathname.includes('/api/3/')) return jsonResponse(404, { errorMessages: ['Not found'] });
      return fieldStatus === 200 ? jsonResponse(200, fieldBody) : jsonResponse(fieldStatus, { errorMessages: ['Fields unavailable'] });
    }
    const jql = url.searchParams.get('jql');
    const fieldNumbers = [...jql.matchAll(/cf\[(\d+)\] = currentUser\(\)/g)].map((m) => `customfield_${m[1]}`);
    const matching = issues.filter((issue) => issue.category === 'indeterminate' &&
      (issue.assignee === ME || fieldNumbers.some((id) => issue.fields?.[id] === ME)));
    return jsonResponse(200, {
      issues: matching.map((issue) => ({
        id: issue.id, key: issue.key,
        fields: {
          summary: `Summary of ${issue.key}`,
          status: { name: 'In Progress', statusCategory: { key: issue.category } },
          assignee: issue.assignee ?? null,
          ...Object.fromEntries(url.searchParams.get('fields').split(',').filter((f) => f.startsWith('customfield_'))
            .map((f) => [f, issue.fields?.[f] ?? null])),
          worklog: { startAt: 0, maxResults: 20, total: 0, worklogs: [] }
        }
      })),
      isLast: true, startAt: 0, total: matching.length
    });
  };
  return { fetchFn, requests, searches: () => requests.filter((u) => /\/search/.test(u.pathname)) };
}
const cloudClient = (jira) => new JiraClient('https://acme.atlassian.net', new JiraCloudTokenProvider('dev@example.com', 'token'), { fetchFn: jira.fetchFn });
const serverClient = (jira) => new JiraClient('https://jira.example.com', new JiraPatProvider('pat-token'), { fetchFn: jira.fetchFn });

describe('Additional assignment fields - Jira client', () => {
  it('reads the fields from /rest/api/3/field on Cloud and /rest/api/2/field on Data Center / Server', async () => {
    const cloud = fakeJira();
    assert.deepEqual((await cloudClient(cloud).getUserPickerFields()).map((f) => f.id), ['customfield_10050', 'customfield_10060', 'customfield_10070']);
    assert.deepEqual(cloud.requests.map((u) => u.pathname), ['/rest/api/3/field']);

    const server = fakeJira();
    assert.equal((await serverClient(server).getUserPickerFields()).length, 3);
    assert.deepEqual(server.requests.map((u) => u.pathname), ['/rest/api/2/field']);
  });

  it('falls back to v2 on Cloud when v3 is missing, as the other requests do', async () => {
    const jira = fakeJira({ v3FieldMissing: true });
    assert.equal((await cloudClient(jira).getUserPickerFields()).length, 3);
    assert.deepEqual(jira.requests.map((u) => u.pathname), ['/rest/api/3/field', '/rest/api/2/field']);
  });

  it('rejects with a status when Jira refuses, and on an unusable response, instead of returning no fields', async () => {
    await assert.rejects(cloudClient(fakeJira({ fieldStatus: 500 })).getUserPickerFields(), (err) => err.status === 500);
    await assert.rejects(serverClient(fakeJira({ fieldStatus: 403 })).getUserPickerFields(), (err) => err.status === 403);
    await assert.rejects(cloudClient(fakeJira({ fieldBody: { unexpected: true } })).getUserPickerFields(), /unexpected/);
  });

  it('rejects with a user-facing message when Jira cannot be reached', async () => {
    const client = new JiraClient('https://acme.atlassian.net', new JiraCloudTokenProvider('dev@example.com', 'token'),
      { fetchFn: async () => { throw new TypeError('Failed to fetch'); } });
    await assert.rejects(client.getUserPickerFields(), (err) => err instanceof Error && err.message.length > 0 && !err.status);
  });

  const issues = [
    { id: '1', key: 'KAN-1', category: 'indeterminate', assignee: ME },
    { id: '2', key: 'KAN-2', category: 'indeterminate', assignee: OTHER, fields: { customfield_10050: ME } },
    { id: '3', key: 'KAN-3', category: 'indeterminate', assignee: ME, fields: { customfield_10050: ME, customfield_10060: ME } },
    { id: '4', key: 'KAN-4', category: 'indeterminate', assignee: null, fields: { customfield_10060: ME } },
    { id: '5', key: 'KAN-5', category: 'indeterminate', assignee: OTHER, fields: { customfield_10050: OTHER } }
  ];
  const inProgressKeys = (list) => list.filter((issue) => issue.inProgress).map((issue) => issue.issueKey);

  it('without fields, lists only Assignee issues, with the existing query and fields', async () => {
    const jira = fakeJira({ issues });
    assert.deepEqual(inProgressKeys(await cloudClient(jira).getActiveIssues(WEEK.monday, WEEK.sunday)), ['KAN-1', 'KAN-3']);
    const [search] = jira.searches();
    assert.equal(search.searchParams.get('fields'), 'summary,status,assignee,worklog');
    assert.doesNotMatch(search.searchParams.get('jql'), /cf\[/);
  });

  it('with one field, also lists issues where that field is the user', async () => {
    const jira = fakeJira({ issues });
    const found = await cloudClient(jira).getActiveIssues(WEEK.monday, WEEK.sunday, { assignmentFields: [{ id: 'customfield_10050', name: 'QA Assignee' }] });
    assert.deepEqual(inProgressKeys(found), ['KAN-1', 'KAN-2', 'KAN-3']);
    const [search] = jira.searches();
    assert.equal(search.searchParams.get('fields'), 'summary,status,assignee,customfield_10050,worklog');
    assert.match(search.searchParams.get('jql'), /\(assignee = currentUser\(\) OR cf\[10050\] = currentUser\(\)\)/);
  });

  it('with several fields, lists issues matching any of them, each once', async () => {
    const found = await serverClient(fakeJira({ issues })).getActiveIssues(WEEK.monday, WEEK.sunday,
      { assignmentFields: [{ id: 'customfield_10050', name: 'QA Assignee' }, { id: 'customfield_10060', name: 'Reviewer' }] });
    assert.deepEqual(inProgressKeys(found), ['KAN-1', 'KAN-2', 'KAN-3', 'KAN-4']);
    // KAN-3 matches Assignee and both fields.
    assert.equal(found.filter((issue) => issue.issueKey === 'KAN-3').length, 1);
  });

  it('never counts an issue whose fields name someone else as the user\'s', async () => {
    const found = await cloudClient(fakeJira({ issues })).getActiveIssues(WEEK.monday, WEEK.sunday, { assignmentFields: [{ id: 'customfield_10050', name: 'QA Assignee' }] });
    assert.ok(!found.some((issue) => issue.issueKey === 'KAN-5'));
  });

  it('passes the fields through the service and the loader, and reloads when they change', async () => {
    const calls = [];
    const client = { baseUrl: 'https://acme.atlassian.net', deploymentType: 'cloud', getActiveIssues: async (start, end, options) => { calls.push(options); return []; } };
    await loadActiveIssues(client, { monday: WEEK.monday });
    await loadActiveIssues(client, { monday: WEEK.monday, assignmentFields: [{ id: 'customfield_10050' }] });
    assert.deepEqual(calls.map((options) => Object.keys(options)), [['signal'], ['signal', 'assignmentFields']]);

    calls.length = 0;
    const loader = createWorkingIssuesLoader(() => {}, { logError: () => {} });
    await loader.refresh(client, { monday: WEEK.monday });
    await loader.refresh(client, { monday: WEEK.monday });
    assert.equal(calls.length, 1, 'the same week and fields are not loaded again');
    await loader.refresh(client, { monday: WEEK.monday, assignmentFields: [{ id: 'customfield_10050' }] });
    assert.equal(calls.length, 2, 'other fields load again');
    assert.deepEqual(calls[1].assignmentFields, [{ id: 'customfield_10050' }]);
  });
});

describe('Additional assignment fields - settings storage', () => {
  const CLOUD = 'cloud|https://acme.atlassian.net';
  const SERVER = 'server|https://jira.example.com';

  it('has none for existing users with nothing stored', () => {
    const settings = normalizeSettings({ jiraBaseUrl: 'https://acme.atlassian.net', token: 't', email: 'e' });
    assert.deepEqual(settings.assignmentFieldsBySite, {});
    assert.deepEqual(assignmentFieldsForSite(settings, CLOUD), []);
    assert.deepEqual(assignmentFieldsForSite(null, CLOUD), []);
  });

  it('saves each Jira site\'s fields apart and restores them', async () => {
    const storage = createMemoryStorageArea();
    const store = createSettingsStore(storage);
    await store.saveAssignmentFields(CLOUD, [{ id: 'customfield_10050', name: 'QA Assignee' }]);
    await store.saveAssignmentFields(SERVER, [{ id: 'customfield_20000', name: 'Reviewer' }]);

    // Reopened: a new store over the same storage.
    const settings = await createSettingsStore(storage).load();
    assert.deepEqual(assignmentFieldsForSite(settings, CLOUD), [{ id: 'customfield_10050', name: 'QA Assignee' }]);
    assert.deepEqual(assignmentFieldsForSite(settings, SERVER), [{ id: 'customfield_20000', name: 'Reviewer' }]);
    assert.deepEqual(assignmentFieldsForSite(settings, 'cloud|https://other.atlassian.net'), []);
  });

  it('removes a site\'s entry when its last field goes, keeping the others', async () => {
    const storage = createMemoryStorageArea();
    const store = createSettingsStore(storage);
    await store.saveAssignmentFields(CLOUD, [{ id: 'customfield_10050', name: 'QA Assignee' }]);
    await store.saveAssignmentFields(SERVER, [{ id: 'customfield_20000', name: 'Reviewer' }]);
    await store.saveAssignmentFields(CLOUD, []);
    assert.deepEqual((await storage.get('assignmentFieldsBySite')).assignmentFieldsBySite, { [SERVER]: [{ id: 'customfield_20000', name: 'Reviewer' }] });
  });

  it('keeps the fields when the connection and Public Holidays are saved', async () => {
    const storage = createMemoryStorageArea();
    const store = createSettingsStore(storage);
    await store.saveAssignmentFields(CLOUD, [{ id: 'customfield_10050', name: 'QA Assignee' }]);
    await store.save({
      deploymentType: 'cloud', email: 'dev@example.com',
      baseUrlsByType: { cloud: 'https://acme.atlassian.net', server: '' }, tokensByType: { cloud: 'token', server: '' },
      publicHolidays: { enabled: false, countryCode: '' }
    });
    assert.deepEqual(assignmentFieldsForSite(await store.load(), CLOUD), [{ id: 'customfield_10050', name: 'QA Assignee' }]);
  });

  it('stores only valid field IDs, once each, with a name to show', () => {
    assert.deepEqual(normalizeAssignmentFields([
      { id: 'customfield_1', name: ' QA ' }, { id: 'customfield_1', name: 'Again' }, { id: 'assignee', name: 'Assignee' },
      { id: 'customfield_2' }, { name: 'No ID' }, null, 'customfield_3'
    ]), [{ id: 'customfield_1', name: 'QA' }, { id: 'customfield_2', name: 'customfield_2' }]);
    assert.equal(normalizeAssignmentFields(Array.from({ length: 20 }, (_, i) => ({ id: `customfield_${i + 1}`, name: `F${i}` }))).length, MAX_ASSIGNMENT_FIELDS);
    assert.deepEqual(normalizeAssignmentFieldsBySite({ [CLOUD]: [{ id: 'bad' }], '': [{ id: 'customfield_1' }], [SERVER]: 'x' }), {});
    assert.deepEqual(normalizeAssignmentFieldsBySite([]), {});
  });

  it('rejects saving without a site', async () => {
    await assert.rejects(createSettingsStore(createMemoryStorageArea()).saveAssignmentFields('', []), /site/);
  });
});

describe('Additional assignment fields - Settings section', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  const SITE = 'cloud|https://acme.atlassian.net';
  const AVAILABLE = parseUserPickerFields(FIELDS);

  function setup({ fields = [], loadFields = async () => AVAILABLE, onChange } = {}) {
    const elements = {
      list: h('ul', { class: 'hidden' }),
      addButton: h('button', { type: 'button', 'aria-expanded': 'false' }),
      menu: h('ul', { role: 'menu', class: 'hidden' }),
      status: h('div', { class: 'hidden' })
    };
    h('div', {}, ...Object.values(elements));
    const saves = [];
    const section = createAssignmentFieldsSettings(elements, {
      onChange: onChange ?? (async (site, list) => { saves.push({ site, fields: list }); })
    });
    let loads = 0;
    section.show({ site: SITE, fields, loadFields: async () => { loads++; return loadFields(); } });
    return { ...elements, section, saves, loadCount: () => loads };
  }

  const options = (view) => view.menu.querySelectorAll('[role="menuitem"]').map((item) => item.textContent);
  const chosen = (view) => view.list.querySelectorAll('.assignment-field').map((item) => item.querySelector('.assignment-field-name').textContent);

  it('shows nothing chosen and disables Add field without a saved connection', () => {
    const view = setup();
    view.section.show(null);
    assert.equal(view.addButton.disabled, true);
    assert.equal(view.status.textContent, NOT_CONNECTED_MESSAGE);
    assert.equal(view.list.children.length, 0);
  });

  it('shows the saved fields, by name, each with a remove button', () => {
    const view = setup({ fields: [{ id: 'customfield_10050', name: 'QA Assignee' }] });
    assert.deepEqual(chosen(view), ['QA Assignee']);
    assert.equal(view.list.classList.contains('hidden'), false);
    assert.equal(view.list.querySelector('.assignment-field-remove').getAttribute('aria-label'), 'Remove QA Assignee');
    assert.equal(view.addButton.disabled, false);
  });

  it('opens a menu of the site\'s fields not chosen yet, and saves a chosen one by ID', async () => {
    const view = setup({ fields: [{ id: 'customfield_10050', name: 'QA Assignee' }] });
    view.addButton.click();
    await flush();
    assert.equal(view.addButton.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(options(view), ['Reviewercustomfield_10060', 'reviewercustomfield_10070']);
    assert.equal(document.activeElement, view.menu.querySelector('[role="menuitem"]'));

    view.menu.querySelector('[data-field-id="customfield_10060"]').click();
    await flush();
    assert.deepEqual(view.saves, [{ site: SITE, fields: [{ id: 'customfield_10050', name: 'QA Assignee' }, { id: 'customfield_10060', name: 'Reviewer' }] }]);
    assert.deepEqual(chosen(view), ['QA Assignee', 'Reviewer']);
    assert.equal(view.addButton.getAttribute('aria-expanded'), 'false');
    assert.equal(view.menu.classList.contains('hidden'), true);
    assert.equal(document.activeElement, view.addButton);
  });

  it('shows the field ID beside a chosen field whose name another field shares', async () => {
    const view = setup({ fields: [{ id: 'customfield_10060', name: 'Reviewer' }] });
    view.addButton.click();
    await flush();
    const hint = view.list.querySelector('.assignment-field-id');
    assert.equal(hint?.textContent, 'customfield_10060');
    assert.equal(view.list.querySelector('.assignment-field-remove').getAttribute('aria-label'), 'Remove Reviewer (customfield_10060)');
  });

  it('removes a field, saving the rest, and moves focus to the next remove button', async () => {
    const view = setup({ fields: [{ id: 'customfield_10050', name: 'QA Assignee' }, { id: 'customfield_10060', name: 'Reviewer' }] });
    view.list.querySelector('[data-action="remove-field"][data-field-id="customfield_10050"]').click();
    await flush();
    assert.deepEqual(view.saves, [{ site: SITE, fields: [{ id: 'customfield_10060', name: 'Reviewer' }] }]);
    assert.deepEqual(chosen(view), ['Reviewer']);
    assert.equal(document.activeElement, view.list.querySelector('[data-action="remove-field"]'));

    view.list.querySelector('[data-action="remove-field"]').click();
    await flush();
    assert.deepEqual(view.saves.at(-1), { site: SITE, fields: [] });
    assert.equal(view.list.classList.contains('hidden'), true);
    assert.equal(document.activeElement, view.addButton);
  });

  it('says so, with Try again, when the fields can\'t be loaded, instead of showing no fields', async () => {
    let fail = true;
    const view = setup({ loadFields: async () => { if (fail) throw new Error('Jira answered 500.'); return AVAILABLE; } });
    view.addButton.click();
    await flush();
    assert.match(view.status.textContent, new RegExp(`^${FIELDS_UNAVAILABLE_MESSAGE.replace(/[.()]/g, '\\$&')} Jira answered 500\\.`));
    assert.doesNotMatch(view.status.textContent, new RegExp(NO_FIELDS_MESSAGE));
    assert.equal(view.status.classList.contains('is-error'), true);
    assert.equal(view.menu.classList.contains('hidden'), true);

    fail = false;
    view.status.querySelector('[data-action="retry-fields"]').click();
    await flush();
    assert.equal(view.status.classList.contains('hidden'), true);
    assert.equal(options(view).length, 3);
  });

  it('says when the site has no other user fields to add', async () => {
    const view = setup({ loadFields: async () => [] });
    view.addButton.click();
    await flush();
    assert.equal(view.status.textContent, NO_FIELDS_MESSAGE);
    assert.equal(view.menu.classList.contains('hidden'), true);
  });

  it('loads the field list once per visit, and again on the next one', async () => {
    const view = setup();
    view.addButton.click();
    await flush();
    view.addButton.click();
    view.addButton.click();
    await flush();
    assert.equal(view.loadCount(), 1);
    view.section.show({ site: SITE, fields: [], loadFields: async () => AVAILABLE });
    assert.equal(view.menu.classList.contains('hidden'), true);
  });

  it('puts the list back and says so when saving fails', async () => {
    const view = setup({ fields: [{ id: 'customfield_10050', name: 'QA Assignee' }], onChange: async () => { throw new Error('quota'); } });
    view.list.querySelector('[data-action="remove-field"]').click();
    await flush();
    assert.deepEqual(chosen(view), ['QA Assignee']);
    assert.equal(view.status.textContent, SAVE_FAILED_MESSAGE);
  });

  it('closes the menu with Escape (not Settings) and with a click elsewhere, and moves with the arrow keys', async () => {
    const view = setup();
    view.addButton.click();
    await flush();
    const items = view.menu.querySelectorAll('[role="menuitem"]');
    items[0].dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
    assert.equal(document.activeElement, items[1]);
    items[1].dispatchEvent({ type: 'keydown', key: 'ArrowUp' });
    assert.equal(document.activeElement, items[0]);
    items[0].dispatchEvent({ type: 'keydown', key: 'ArrowUp' });
    assert.equal(document.activeElement, items[2], 'wraps around');

    let reachedDrawer = false;
    view.menu.parentNode.addEventListener('keydown', () => { reachedDrawer = true; });
    items[2].dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(view.menu.classList.contains('hidden'), true);
    assert.equal(document.activeElement, view.addButton);
    assert.equal(reachedDrawer, false);

    view.addButton.click();
    await flush();
    assert.equal(view.addButton.getAttribute('aria-expanded'), 'true');
    h('div').click();
    assert.equal(view.addButton.getAttribute('aria-expanded'), 'false');
  });

  it('is placed in Settings before Public Holidays, with About still last', () => {
    const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
    const form = html.slice(html.indexOf('<form id="settingsForm"'), html.indexOf('</form>'));
    assert.ok(form.indexOf('id="connectionSection"') < form.indexOf('id="assignmentFieldsTitle"'));
    assert.ok(form.indexOf('id="assignmentFieldsTitle"') < form.indexOf('id="publicHolidaysEnabled"'));
    assert.match(form, /Also show issues assigned to you through these Jira user fields\./);
    assert.match(form, /<button type="button" id="assignmentFieldsAddBtn"[^>]*aria-haspopup="menu"[^>]*aria-controls="assignmentFieldsMenu"/s);
    assert.ok(html.indexOf('id="aboutSection"') > html.indexOf('</form>'));
  });
});
