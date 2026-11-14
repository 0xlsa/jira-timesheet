import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDocument } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import { JiraClient } from '../src/jira/JiraClient.js';
import { JiraCloudTokenProvider } from '../src/auth/JiraCloudTokenProvider.js';
import { JiraPatProvider } from '../src/auth/JiraPatProvider.js';
import { openCustomViewEditor } from '../src/ui/customViewEditor.js';
import {
  EPIC_FIELD, EPIC_LINK_TYPE, EPIC_SUGGESTION_LIMIT, SYSTEM_FIELDS, parseEpicSupport, epicLinkFieldId, searchEpicsJql, toEpicValues,
  normalizeCondition, normalizeSiteViews, buildCustomViewJql, validateViewDraft, isViewAvailable, usesCustomField, usesEpic, describeView
} from '../src/jira/customViews.js';

// Shapes as the live sites answered (synthetic keys and names): Data Center's Epic Link is a Jira
// Software custom field found by its type; Cloud has no Epic Link, only `parent`, and epics at
// hierarchy level 1, team-managed projects' own included.
const SELECT_TYPE = 'com.atlassian.jira.plugin.system.customfieldtypes:select';
const DC_FIELDS = [
  { id: 'customfield_10004', name: 'Epic Name', custom: true, searchable: true, schema: { type: 'string', custom: 'com.pyxis.greenhopper.jira:gh-epic-label' } },
  { id: 'customfield_10001', name: 'Epic Link', custom: true, searchable: true, schema: { type: 'any', custom: EPIC_LINK_TYPE } },
  { id: 'customfield_12101', name: 'Parent Link', custom: true, searchable: true, schema: { type: 'any', custom: 'com.atlassian.jpo:jpo-custom-field-parent' } },
  { id: 'customfield_14101', name: 'Story Rank In EPIC', custom: true, navigable: true, searchable: true, schema: { type: 'option', custom: SELECT_TYPE } }
];
const CLOUD_FIELDS = [
  { id: 'parent', name: 'Parent', custom: false, searchable: true, navigable: true },
  { id: 'issuetype', name: 'Issue Type', custom: false, searchable: true, schema: { type: 'issuetype', system: 'issuetype' } }
];
const CLOUD_TYPES = [
  { id: '10002', name: 'Subtask', hierarchyLevel: -1, subtask: true },
  { id: '10009', name: 'Story', hierarchyLevel: 0 },
  { id: '10005', name: 'Epic', hierarchyLevel: 1, scope: { type: 'PROJECT' } },
  { id: '10001', name: 'Epic', hierarchyLevel: 1, scope: { type: 'PROJECT' } },
  { id: '10000', name: 'Epic', hierarchyLevel: 1 }
];

const epic = (id, label) => ({ id, label });
const INFRA = epic('161539', 'EKB-31000 - Platform Infrastructure');
const PROXY = epic('156152', 'EKB-30001 - Customer Environment Proxy');
const epicCondition = (values, operator = 'in') => ({ field: { id: 'epic', name: 'Epic' }, operator, values });
const statusCondition = { field: { id: 'status', name: 'Status' }, operator: 'in', values: [{ id: '10000', label: 'To Do' }, { id: '3', label: 'In Progress' }] };

describe('Epic - the site\'s epic field', () => {
  it('uses Data Center\'s Epic Link field by its type and ID, never its name', () => {
    assert.deepEqual(parseEpicSupport(DC_FIELDS, { deploymentType: 'server', epicIssueTypeIds: ['10000'] }),
      { field: 'customfield_10001', issueTypeIds: ['10000'] });
    // Renamed, or in another language: still found by its type.
    const renamed = DC_FIELDS.map((field) => (field.id === 'customfield_10001' ? { ...field, name: 'Épica' } : field));
    assert.equal(epicLinkFieldId(renamed), 'customfield_10001');
    // A field merely named Epic Link isn't it.
    assert.equal(epicLinkFieldId([{ id: 'customfield_20000', name: 'Epic Link', schema: { type: 'string', custom: 'x:textfield' } }]), null);
    // Several (unusual): the lowest-numbered; one that can't be searched is left out.
    assert.equal(epicLinkFieldId([
      { id: 'customfield_30000', schema: { custom: EPIC_LINK_TYPE } },
      { id: 'customfield_10001', schema: { custom: EPIC_LINK_TYPE }, searchable: false },
      { id: 'customfield_20000', schema: { custom: EPIC_LINK_TYPE } }
    ]), 'customfield_20000');
  });

  it('has no epic field on Data Center without Jira Software', () => {
    assert.equal(parseEpicSupport(DC_FIELDS.filter((field) => field.schema?.custom !== EPIC_LINK_TYPE), { deploymentType: 'server' }), null);
  });

  it('keeps Data Center\'s epic field with no epic issue type when no epic can be seen', () => {
    assert.deepEqual(parseEpicSupport(DC_FIELDS, { deploymentType: 'server', epicIssueTypeIds: [] }), { field: 'customfield_10001', issueTypeIds: [] });
  });

  it('uses Cloud\'s parent, with every epic issue type at hierarchy level 1, never an Epic Link field', () => {
    assert.deepEqual(parseEpicSupport(CLOUD_FIELDS, { deploymentType: 'cloud', issueTypes: CLOUD_TYPES }),
      { field: 'parent', issueTypeIds: ['10005', '10001', '10000'] });
    // Even if a legacy Epic Link field were listed, Cloud searches by parent.
    assert.equal(parseEpicSupport([...CLOUD_FIELDS, DC_FIELDS[1]], { deploymentType: 'cloud', issueTypes: CLOUD_TYPES }).field, 'parent');
    assert.equal(parseEpicSupport(CLOUD_FIELDS.slice(1), { deploymentType: 'cloud', issueTypes: CLOUD_TYPES }), null, 'no parent field');
    assert.throws(() => parseEpicSupport(CLOUD_FIELDS, { deploymentType: 'cloud', issueTypes: { values: [] } }), /issue types/);
    assert.throws(() => parseEpicSupport({}, { deploymentType: 'server' }), /fields/);
  });
});

describe('Epic - conditions and their JQL', () => {
  it('keeps epics by their numeric issue ID, with their key and summary as the label', () => {
    assert.deepEqual(normalizeCondition(epicCondition([INFRA, PROXY, INFRA])), epicCondition([INFRA, PROXY]));
    assert.equal(normalizeCondition(epicCondition([epic('EKB-31000', 'EKB-31000')])), null, 'a key is not an ID');
    assert.equal(normalizeCondition(epicCondition([epic('1 OR 1=1', 'x')])), null);
    assert.equal(normalizeCondition(epicCondition([{ currentUser: true, label: 'Me' }])), null, 'Epic is never Me');
    assert.equal(normalizeCondition(epicCondition([])), null);
  });

  it('searches Data Center\'s Epic Link by its number: one epic, several, and Not in', () => {
    const jql = (condition) => buildCustomViewJql({ conditions: [condition] }, { epicField: 'customfield_10001' });
    assert.equal(jql(epicCondition([INFRA])), 'cf[10001] in (161539) ORDER BY updated DESC, key DESC');
    assert.equal(jql(epicCondition([INFRA, PROXY])), 'cf[10001] in (161539, 156152) ORDER BY updated DESC, key DESC');
    assert.equal(jql(epicCondition([INFRA], 'notIn')), '(cf[10001] not in (161539) OR cf[10001] is EMPTY) ORDER BY updated DESC, key DESC');
  });

  it('searches Cloud\'s parent: one epic, several, and Not in', () => {
    const jql = (condition) => buildCustomViewJql({ conditions: [condition] }, { epicField: 'parent' });
    assert.equal(jql(epicCondition([epic('10003', 'SAM-2 - Market Analysis')])), 'parent in (10003) ORDER BY updated DESC, key DESC');
    assert.equal(jql(epicCondition([epic('10003', 'a'), epic('10007', 'b')])), 'parent in (10003, 10007) ORDER BY updated DESC, key DESC');
    assert.equal(jql(epicCondition([epic('10003', 'a')], 'notIn')), '(parent not in (10003) OR parent is EMPTY) ORDER BY updated DESC, key DESC');
  });

  it('combines Epic with Status (AND), in the view\'s order', () => {
    const view = { conditions: [epicCondition([INFRA]), statusCondition], orderBy: { field: 'priority', direction: 'ASC' } };
    assert.equal(buildCustomViewJql(view, { epicField: 'customfield_10001' }), 'cf[10001] in (161539) AND status in (10000, 3) ORDER BY priority ASC, key ASC');
    assert.equal(buildCustomViewJql(view, { epicField: 'parent' }), 'parent in (161539) AND status in (10000, 3) ORDER BY priority ASC, key ASC');
  });

  it('never guesses the epic field: without the site\'s, or with anything else, there\'s no JQL', () => {
    const view = { conditions: [epicCondition([INFRA])] };
    for (const epicField of [undefined, null, '', 'Epic Link', 'customfield_x', 'cf[10001]', 'parent OR 1=1']) {
      assert.throws(() => buildCustomViewJql(view, { epicField }), /no longer available/, String(epicField));
    }
  });

  it('describes an Epic condition by its epics\' keys and summaries', () => {
    assert.equal(describeView({ conditions: [epicCondition([INFRA, PROXY]), statusCondition] }),
      'Epic in EKB-31000 - Platform Infrastructure, EKB-30001 - Customer Environment Proxy and Status in To Do, In Progress · Updated, descending');
  });
});

describe('Epic - saving views', () => {
  const draft = (conditions) => ({
    name: 'Platform',
    conditions: conditions.map((condition) => ({ ...condition, field: { ...condition.field, kind: 'option' } })),
    orderBy: { field: 'updated', direction: 'DESC' }
  });

  it('saves an Epic condition on a site with an epic field, with other conditions', () => {
    const { errors, view } = validateViewDraft(draft([epicCondition([INFRA, PROXY]), statusCondition]), { views: [], epicField: 'customfield_10001' });
    assert.deepEqual(errors, {});
    assert.deepEqual(view.conditions[0], epicCondition([INFRA, PROXY]));
  });

  it('refuses an Epic condition where the site\'s epic field isn\'t known', () => {
    const { errors, view } = validateViewDraft(draft([epicCondition([INFRA])]), { views: [] });
    assert.equal(view, null);
    assert.match(errors.conditions, /Epic can't be searched/);
  });

  it('asks for at least one epic, and allows Epic once per view', () => {
    assert.equal(validateViewDraft(draft([epicCondition([])]), { views: [], epicField: 'parent' }).errors.byCondition[0].values, 'Choose at least one value.');
    assert.equal(validateViewDraft(draft([epicCondition([INFRA]), epicCondition([PROXY])]), { views: [], epicField: 'parent' }).errors.byCondition[1].field,
      'Another condition already uses this field.');
  });

  it('reads a saved Epic view back as it was, and older views as they were', () => {
    const epicView = { id: 'platform', name: 'Platform', conditions: [epicCondition([INFRA]), statusCondition], orderBy: { field: 'key', direction: 'ASC' } };
    const older = { id: 'reported', name: 'Reported', conditions: [{ field: { id: 'reporter', name: 'Reporter' }, operator: 'equals', values: [{ currentUser: true, label: 'Me' }] }] };
    const { views } = normalizeSiteViews({ version: 1, views: [epicView, older] });
    assert.deepEqual(views[0], epicView);
    assert.deepEqual(views[1].conditions[0].operator, 'in', 'an older operator still reads as before');
  });

  it('needs the site\'s fields for a view with Epic, and knows when the site has none', () => {
    const view = { conditions: [epicCondition([INFRA])] };
    const context = { assignmentFieldIds: [], singleSelectFieldIds: null };
    assert.equal(usesEpic(view), true);
    assert.equal(usesEpic({ conditions: [statusCondition] }), false);
    assert.equal(usesCustomField([view]), true, 'the fields are read, for the epic field');
    assert.equal(usesCustomField([{ conditions: [statusCondition] }]), false);
    assert.equal(isViewAvailable(view, { ...context, epicField: undefined }), true, 'while not known');
    assert.equal(isViewAvailable(view, { ...context, epicField: 'parent' }), true);
    assert.equal(isViewAvailable(view, { ...context, epicField: null }), false, 'the site has no epics');
    assert.equal(isViewAvailable({ conditions: [statusCondition] }, { ...context, epicField: null }), true, 'other views are unaffected');
  });
});

describe('Epic - finding the epics to choose', () => {
  it('lists the most recently updated epics when nothing is typed', () => {
    assert.equal(searchEpicsJql('', ['10000']), 'issuetype in (10000) ORDER BY updated DESC');
    assert.equal(searchEpicsJql('   ', ['10005', '10001', '10000']), 'issuetype in (10005, 10001, 10000) ORDER BY updated DESC');
  });

  it('searches summaries for the typed words, the last as the start of a word', () => {
    assert.equal(searchEpicsJql('Platform Infra', ['10000']), 'issuetype in (10000) AND summary ~ "Platform Infra*" ORDER BY updated DESC');
    assert.equal(searchEpicsJql('migração', ['10000']), 'issuetype in (10000) AND summary ~ "migração*" ORDER BY updated DESC');
  });

  it('searches a partial key as the Log work panel does: the key and one digit longer', () => {
    assert.equal(searchEpicsJql('ekb-3100', ['10000']),
      'issuetype in (10000) AND key in ("EKB-3100", "EKB-31000", "EKB-31001", "EKB-31002", "EKB-31003", "EKB-31004", "EKB-31005", "EKB-31006", "EKB-31007", "EKB-31008", "EKB-31009") ORDER BY key ASC');
  });

  it('lets nothing typed change the query: only letters and digits reach the text search', () => {
    assert.equal(searchEpicsJql('") OR project = SECRET OR summary ~ ("', ['10000']),
      'issuetype in (10000) AND summary ~ "OR project SECRET OR summary*" ORDER BY updated DESC');
    assert.equal(searchEpicsJql('a\\b*c?', ['10000']), 'issuetype in (10000) AND summary ~ "a b c*" ORDER BY updated DESC');
    assert.equal(searchEpicsJql('"!*', ['10000']), null, 'nothing to search');
  });

  it('searches nothing without epic issue types', () => {
    assert.equal(searchEpicsJql('', []), null);
    assert.equal(searchEpicsJql('x', ['Epic', '10000 OR 1=1']), null);
    assert.equal(searchEpicsJql('', ['Epic', '10000']), 'issuetype in (10000) ORDER BY updated DESC');
  });

  it('offers each epic once by its issue ID, labelled with its key and summary', () => {
    assert.deepEqual(toEpicValues([
      { id: '161539', key: 'EKB-31000', fields: { summary: 'Platform Infrastructure' } },
      { id: '161539', key: 'EKB-31000', fields: { summary: 'Again' } },
      { id: '156152', key: 'EKB-30001', fields: { summary: '  Line\none\ttwo ' } },
      { id: '170000', key: 'EKB-32000', fields: {} },
      { id: 'x', key: 'EKB-1', fields: { summary: 'Bad ID' } },
      { id: '1', fields: { summary: 'No key' } }
    ]), [
      { id: '161539', label: 'EKB-31000 - Platform Infrastructure' },
      { id: '156152', label: 'EKB-30001 - Line one two' },
      { id: '170000', label: 'EKB-32000' }
    ]);
    assert.deepEqual(toEpicValues(undefined), []);
  });
});

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const cloud = (fetchFn) => new JiraClient('https://acme.atlassian.net', new JiraCloudTokenProvider('dev@example.com', 'token'), { fetchFn });
const server = (fetchFn) => new JiraClient('https://jira.example.com', new JiraPatProvider('pat'), { fetchFn });

/** A fake Jira answering the requests Epic needs, recording each (the URL). */
function fakeJira(answers) {
  const requests = [];
  const fetchFn = async (rawUrl) => {
    const url = new URL(rawUrl);
    requests.push(url);
    for (const [test, answer] of answers) {
      if (test(url)) return typeof answer === 'function' ? answer(url) : answer;
    }
    return jsonResponse(404, { errorMessages: ['Not found'] });
  };
  return { fetchFn, requests, paths: () => requests.map((url) => url.pathname) };
}

describe('Epic - discovery through Jira', () => {
  it('finds Data Center\'s Epic Link in GET /field, and the epic issue type from Jira Software\'s own epics', async () => {
    const jira = fakeJira([
      [(url) => url.pathname === '/rest/api/2/field', jsonResponse(200, DC_FIELDS)],
      [(url) => url.pathname === '/rest/api/2/jql/autocompletedata/suggestions', jsonResponse(200, { results: [{ value: 'EKB-31000', displayName: 'Platform Infrastructure - (EKB-31000)' }] })],
      [(url) => url.pathname === '/rest/api/2/issue/EKB-31000', jsonResponse(200, { id: '161539', key: 'EKB-31000', fields: { issuetype: { id: '10000', name: 'Epic' } } })]
    ]);
    const { epic: found, singleSelect } = await server(jira.fetchFn).getCustomViewFields();
    assert.deepEqual(found, { field: 'customfield_10001', issueTypeIds: ['10000'] });
    assert.deepEqual(singleSelect.map((field) => field.id), ['customfield_14101'], 'the other custom fields as before');
    assert.deepEqual(jira.paths(), ['/rest/api/2/field', '/rest/api/2/jql/autocompletedata/suggestions', '/rest/api/2/issue/EKB-31000']);
    assert.equal(jira.requests[1].searchParams.get('fieldName'), 'cf[10001]');
    assert.equal(jira.requests[1].searchParams.get('fieldValue'), '');
    assert.equal(jira.requests[2].searchParams.get('fields'), 'issuetype');
  });

  it('has no epic issue type on Data Center when no epic can be seen', async () => {
    const jira = fakeJira([
      [(url) => url.pathname === '/rest/api/2/field', jsonResponse(200, DC_FIELDS)],
      [(url) => url.pathname.endsWith('/suggestions'), jsonResponse(200, { results: [] })]
    ]);
    assert.deepEqual((await server(jira.fetchFn).getCustomViewFields()).epic, { field: 'customfield_10001', issueTypeIds: [] });
  });

  it('asks nothing more on Data Center without Jira Software', async () => {
    const jira = fakeJira([[(url) => url.pathname === '/rest/api/2/field', jsonResponse(200, DC_FIELDS.filter((field) => field.id !== 'customfield_10001'))]]);
    assert.equal((await server(jira.fetchFn).getCustomViewFields()).epic, null);
    assert.deepEqual(jira.paths(), ['/rest/api/2/field']);
  });

  it('finds Cloud\'s parent and the epic issue types (hierarchy level 1)', async () => {
    const jira = fakeJira([
      [(url) => url.pathname === '/rest/api/3/field', jsonResponse(200, CLOUD_FIELDS)],
      [(url) => url.pathname === '/rest/api/3/issuetype', jsonResponse(200, CLOUD_TYPES)]
    ]);
    assert.deepEqual((await cloud(jira.fetchFn).getCustomViewFields()).epic, { field: 'parent', issueTypeIds: ['10005', '10001', '10000'] });
    assert.deepEqual(jira.paths(), ['/rest/api/3/field', '/rest/api/3/issuetype']);
  });

  it('reports a failure to read the epic issue types, never an empty list', async () => {
    const jira = fakeJira([
      [(url) => url.pathname === '/rest/api/3/field', jsonResponse(200, CLOUD_FIELDS)],
      [(url) => url.pathname === '/rest/api/3/issuetype', jsonResponse(503, { errorMessages: ['Down'] })]
    ]);
    await assert.rejects(cloud(jira.fetchFn).getCustomViewFields(), (err) => err.status === 503);
  });
});

describe('Epic - searching epics through Jira', () => {
  const epicsAnswer = (url) => jsonResponse(200, {
    issues: [{ id: '161539', key: 'EKB-31000', fields: { summary: 'Platform Infrastructure' } }],
    ...(url.pathname.includes('/3/') ? { isLast: true } : { startAt: 0, total: 1 })
  });

  it('runs one bounded search on Data Center, a typed key that doesn\'t exist being only a warning', async () => {
    const jira = fakeJira([[(url) => url.pathname === '/rest/api/2/search', epicsAnswer]]);
    assert.deepEqual(await server(jira.fetchFn).searchEpics('Platform', { issueTypeIds: ['10000'] }), [INFRA]);
    const [search] = jira.requests;
    assert.equal(search.searchParams.get('jql'), 'issuetype in (10000) AND summary ~ "Platform*" ORDER BY updated DESC');
    assert.equal(search.searchParams.get('maxResults'), String(EPIC_SUGGESTION_LIMIT));
    assert.equal(search.searchParams.get('fields'), 'summary');
    assert.equal(search.searchParams.get('validateQuery'), 'warn');
  });

  it('runs one bounded search on Cloud', async () => {
    const jira = fakeJira([[(url) => url.pathname === '/rest/api/3/search/jql', epicsAnswer]]);
    assert.deepEqual(await cloud(jira.fetchFn).searchEpics('EKB-3100', { issueTypeIds: ['10005', '10001', '10000'] }), [INFRA]);
    assert.match(jira.requests[0].searchParams.get('jql'), /^issuetype in \(10005, 10001, 10000\) AND key in \("EKB-3100", "EKB-31000",/);
    assert.equal(jira.requests[0].searchParams.get('nextPageToken'), null, 'one page only');
  });

  it('asks Jira nothing when there\'s nothing to search, and answers no epics with none', async () => {
    const jira = fakeJira([[(url) => url.pathname.includes('/search'), jsonResponse(200, { issues: [], isLast: true })]]);
    const client = cloud(jira.fetchFn);
    assert.deepEqual(await client.searchEpics('', { issueTypeIds: [] }), []);
    assert.deepEqual(await client.searchEpics('***', { issueTypeIds: ['10000'] }), []);
    assert.deepEqual(jira.requests, []);
    assert.deepEqual(await client.searchEpics('nothing like this', { issueTypeIds: ['10000'] }), []);
  });

  it('reports Jira\'s refusal (permissions, errors) with its status', async () => {
    const jira = fakeJira([[(url) => url.pathname.includes('/search'), jsonResponse(403, { errorMessages: ['No permission'] })]]);
    await assert.rejects(server(jira.fetchFn).searchEpics('x', { issueTypeIds: ['10000'] }), (err) => err.status === 403);
  });

  it('runs a view\'s Epic search with the site\'s own clause, on each edition', async () => {
    for (const [makeClient, path, epicField, expected] of [
      [server, '/rest/api/2/search', 'customfield_10001', 'cf[10001] in (161539) AND status in (10000, 3) ORDER BY updated DESC, key DESC'],
      [cloud, '/rest/api/3/search/jql', 'parent', 'parent in (161539) AND status in (10000, 3) ORDER BY updated DESC, key DESC']
    ]) {
      const jira = fakeJira([[(url) => url.pathname === path, (url) => jsonResponse(200, {
        issues: [{ id: '170001', key: 'EKB-31212', fields: { summary: 'A story', status: { name: 'To Do', statusCategory: { key: 'new' } } } }],
        ...(url.pathname.includes('/3/') ? { isLast: true } : { startAt: 0, total: 1 })
      })]]);
      const jql = buildCustomViewJql({ conditions: [epicCondition([INFRA]), statusCondition] }, { epicField });
      assert.equal(jql, expected);
      const result = await makeClient(jira.fetchFn).searchCustomViewIssues(jql);
      assert.deepEqual(result.issues.map((issue) => issue.issueKey), ['EKB-31212']);
      assert.equal(jira.requests[0].searchParams.get('jql'), expected);
    }
  });
});

describe('Epic - in the view editor', () => {
  let restoreDocument;
  beforeEach(() => {
    restoreDocument = installFakeDocument();
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    mock.timers.reset();
    restoreDocument();
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const EPICS = [INFRA, PROXY, epic('170000', 'EKB-32000 - Reporting')];

  function open({ view = null, epicField = 'customfield_10001' } = {}) {
    const root = h('aside', { class: 'custom-view-editor hidden' });
    const asked = [];
    const saved = [];
    openCustomViewEditor(root, {
      view,
      fields: SYSTEM_FIELDS.map((field) => ({ ...field, group: 'Fields' })),
      // As options.js offers it: Epic with the standard fields, once the site's fields are read.
      loadCustomFields: async () => [{ ...EPIC_FIELD, group: 'Fields' }],
      loadValues: async (field, query) => {
        asked.push([field.id, query]);
        if (field.id === 'status') return [{ id: '10000', label: 'To Do' }, { id: '3', label: 'In Progress' }];
        return EPICS.filter((value) => value.label.toLowerCase().includes(query.toLowerCase()));
      },
      validate: (draft) => validateViewDraft(draft, { views: view ? [view] : [], editingId: view?.id, epicField }),
      onSave: async (value) => { saved.push(value); },
      onClose: () => {},
      searchDelayMs: 10
    });
    const $ = (selector) => root.querySelector(selector);
    const choose = (selector, value) => {
      $(selector).value = value;
      $(selector).dispatchEvent({ type: 'change' });
    };
    const labels = () => root.querySelectorAll('.custom-view-value').map((label) => label.querySelector('span').textContent);
    const check = (label) => {
      const input = root.querySelectorAll('.custom-view-value').find((el) => el.querySelector('span').textContent === label).querySelector('input');
      input.checked = true;
      input.dispatchEvent({ type: 'change' });
    };
    return { root, $, choose, labels, check, asked, saved };
  }

  it('offers Epic in the Field list, with the standard fields', async () => {
    const { $ } = open();
    await flush();
    assert.deepEqual($('#customViewField-1').querySelectorAll('optgroup').map((group) => [group.getAttribute('label'), group.querySelectorAll('option').map((o) => o.textContent)]),
      [['Fields', ['Status', 'Priority', 'Assignee', 'Reporter', 'Epic']]]);
  });

  it('searches epics by key or summary as the user types, and saves several with In', async () => {
    const { $, choose, labels, check, asked, saved } = open();
    await flush();
    $('#customViewName').value = 'Platform';
    choose('#customViewField-1', 'epic');
    await flush();
    const search = $('#customViewValueSearch-1');
    assert.equal(search.getAttribute('placeholder'), 'Search epics by key or summary');
    assert.equal(search.getAttribute('aria-label'), 'Search epics by key or summary');
    assert.deepEqual(asked, [['epic', '']], 'the most recent epics at once');
    assert.deepEqual(labels(), ['EKB-30001 - Customer Environment Proxy', 'EKB-31000 - Platform Infrastructure', 'EKB-32000 - Reporting']);
    assert.deepEqual($('#customViewOperator-1').querySelectorAll('option').map((o) => o.textContent), ['In', 'Not in']);

    check('EKB-31000 - Platform Infrastructure');
    search.value = 'Customer';
    search.dispatchEvent({ type: 'input' });
    mock.timers.tick(10);
    await flush();
    assert.deepEqual(asked.at(-1), ['epic', 'Customer']);
    // The chosen epic stays listed, whatever the search shows.
    assert.deepEqual(labels(), ['EKB-31000 - Platform Infrastructure', 'EKB-30001 - Customer Environment Proxy']);
    check('EKB-30001 - Customer Environment Proxy');

    $('form').dispatchEvent({ type: 'submit' });
    await flush();
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].conditions, [{ field: { id: 'epic', name: 'Epic' }, operator: 'in', values: [INFRA, PROXY] }], 'in the order chosen');
  });

  it('says when no epic matches', async () => {
    const { $, choose } = open();
    await flush();
    choose('#customViewField-1', 'epic');
    await flush();
    $('#customViewValueSearch-1').value = 'zzz';
    $('#customViewValueSearch-1').dispatchEvent({ type: 'input' });
    mock.timers.tick(10);
    await flush();
    assert.equal($('[data-condition="1"]').querySelector('[role="status"]').textContent, 'No values match.');
  });

  it('restores a saved Epic condition\'s epics, with its other conditions, when editing', async () => {
    const view = { id: 'platform', name: 'Platform', conditions: [epicCondition([INFRA], 'notIn'), statusCondition], orderBy: { field: 'updated', direction: 'DESC' } };
    const { $, root, saved } = open({ view });
    await flush();
    assert.equal($('#customViewField-1').value, 'epic');
    assert.equal($('#customViewOperator-1').value, 'notIn');
    const checked = $('[data-condition="1"]').querySelectorAll('.custom-view-value').filter((label) => label.querySelector('input').checked)
      .map((label) => label.querySelector('span').textContent);
    assert.deepEqual(checked, ['EKB-31000 - Platform Infrastructure']);
    assert.equal($('#customViewField-2').value, 'status');
    $('form').dispatchEvent({ type: 'submit' });
    await flush();
    assert.deepEqual(saved[0].conditions, view.conditions, 'saved again unchanged');
  });
});
