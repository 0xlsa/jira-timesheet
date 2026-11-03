import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_VIEWS_VERSION,
  MAX_CUSTOM_VIEWS,
  MAX_VIEW_NAME_LENGTH,
  CUSTOM_VIEW_RESULT_LIMIT,
  RESERVED_VIEW_NAMES,
  ALL_VIEW_ID,
  ALL_VIEW_NAME,
  OPERATORS,
  ME_VALUE,
  SYSTEM_FIELDS,
  parseSingleSelectFields,
  conditionKind,
  operatorsFor,
  normalizeCondition,
  normalizeView,
  normalizeSiteViews,
  normalizeCustomViewsBySite,
  nameProblem,
  validateViewDraft,
  isViewAvailable,
  usesCustomOptionField,
  parseNamedValues,
  parseFieldSuggestions,
  buildCustomViewJql,
  jqlString,
  describeView
} from '../src/jira/customViews.js';

const statusCondition = (ids, operator = ids.length > 1 ? 'isOneOf' : 'equals') => ({
  field: { id: 'status', name: 'Status' }, operator, values: ids.map((id) => ({ id, label: `Status ${id}` }))
});
const meCondition = (fieldId, name = fieldId) => ({ field: { id: fieldId, name }, operator: 'equals', values: [{ currentUser: true, label: 'Me' }] });
const view = (id, name, condition = statusCondition(['3'])) => ({ id, name, conditions: [condition] });

const STATUS = { id: 'status', name: 'Status', kind: 'option' };
const PRIORITY = { id: 'priority', name: 'Priority', kind: 'option' };
const ASSIGNEE = { id: 'assignee', name: 'Assignee', kind: 'user' };
const SELECT = { id: 'customfield_10100', name: 'Team', kind: 'option' };

describe('Custom views - storage', () => {
  it('reads a valid site entry as stored', () => {
    const entry = { version: 1, views: [view('a', 'Development Queue'), view('b', 'Ready for QA', meCondition('customfield_10050', 'QA Assignee'))] };
    assert.deepEqual(normalizeSiteViews(entry), entry);
  });

  it('reads nothing stored, or something that isn\'t an entry, as no views', () => {
    for (const raw of [undefined, null, 'x', [], {}]) {
      assert.deepEqual(normalizeSiteViews(raw), { version: CUSTOM_VIEWS_VERSION, views: [] });
    }
  });

  it('leaves an entry of another version untouched: no views, marked unsupported', () => {
    for (const version of [2, 0, '1']) {
      assert.deepEqual(normalizeSiteViews({ version, views: [view('a', 'Queue')] }), { version: CUSTOM_VIEWS_VERSION, views: [], unsupported: true });
    }
  });

  it('keeps at most two views, each ID and name once (names in any case)', () => {
    const { views } = normalizeSiteViews({ version: 1, views: [view('a', 'Queue'), view('a', 'Other'), view('b', 'QUEUE'), view('c', 'Review'), view('d', 'Third')] });
    assert.deepEqual(views.map((v) => v.id), ['a', 'c']);
    assert.equal(MAX_CUSTOM_VIEWS, 2);
  });

  it('drops malformed views, keeping the valid ones', () => {
    const { views } = normalizeSiteViews({ version: 1, views: [
      { id: 'bad id!', name: 'X', conditions: [statusCondition(['1'])] },
      { id: 'all', name: 'Everything', conditions: [statusCondition(['1'])] },
      { id: 'e', name: 'Active', conditions: [statusCondition(['1'])] },
      { id: 'f2', name: 'All', conditions: [statusCondition(['1'])] },
      { id: 'f', name: '   ', conditions: [statusCondition(['1'])] },
      { id: 'g', name: 'x'.repeat(31), conditions: [statusCondition(['1'])] },
      { id: 'h', name: 'Two conditions', conditions: [statusCondition(['1']), statusCondition(['2'])] },
      { id: 'i', name: 'No condition', conditions: [] },
      view('ok', 'Fine')
    ] });
    assert.deepEqual(views.map((v) => v.id), ['ok']);
  });

  it('reads every site\'s entry on its own', () => {
    const bySite = normalizeCustomViewsBySite({
      'cloud|https://a.atlassian.net': { version: 1, views: [view('a', 'Queue')] },
      'server|https://jira.example.com': { version: 2, views: [] },
      '': { version: 1, views: [view('x', 'Ignored')] }
    });
    assert.deepEqual(Object.keys(bySite), ['cloud|https://a.atlassian.net', 'server|https://jira.example.com']);
    assert.equal(bySite['server|https://jira.example.com'].unsupported, true);
    assert.deepEqual(normalizeCustomViewsBySite(null), {});
  });
});

describe('Custom views - conditions', () => {
  it('accepts Equals with one value, and Is one of with two or more, for option fields', () => {
    assert.ok(normalizeCondition(statusCondition(['1'])));
    assert.ok(normalizeCondition(statusCondition(['1', '2'])));
    assert.equal(normalizeCondition(statusCondition(['1', '2'], 'equals')), null);
    assert.equal(normalizeCondition(statusCondition(['1'], 'isOneOf')), null);
  });

  it('keeps values by ID once, with numeric IDs as text and labels defaulting to the ID', () => {
    assert.deepEqual(normalizeCondition({ field: { id: 'priority' }, operator: 'isOneOf', values: [{ id: 2, label: 'High' }, { id: '2' }, { id: '3' }] }),
      { field: { id: 'priority', name: 'priority' }, operator: 'isOneOf', values: [{ id: '2', label: 'High' }, { id: '3', label: '3' }] });
  });

  it('accepts Me, with Equals only, on user fields; never on Status or Priority', () => {
    for (const id of ['assignee', 'reporter', 'customfield_10050']) {
      assert.deepEqual(normalizeCondition(meCondition(id)).values, [{ currentUser: true, label: 'Me' }]);
      assert.equal(normalizeCondition({ ...meCondition(id), operator: 'isOneOf' }), null);
    }
    assert.equal(normalizeCondition(meCondition('status')), null);
    assert.equal(normalizeCondition(meCondition('priority')), null);
  });

  it('never stores another person: Assignee and Reporter take Me only', () => {
    assert.equal(normalizeCondition({ field: { id: 'assignee' }, operator: 'equals', values: [{ id: 'someone', label: 'Someone Else' }] }), null);
    assert.equal(normalizeCondition({ field: { id: 'reporter' }, operator: 'equals', values: [{ accountId: 'x' }] }), null);
    assert.equal(normalizeCondition({ field: { id: 'assignee' }, operator: 'equals', values: [{ currentUser: true, accountId: 'me', displayName: 'Me Myself' }] }).values[0].accountId, undefined);
  });

  it('accepts only the fields views support', () => {
    for (const id of ['summary', 'labels', 'components', 'customfield_', 'customfield_10x', 'worklog', 'status;drop']) {
      assert.equal(normalizeCondition({ field: { id }, operator: 'equals', values: [{ id: '1' }] }), null, id);
    }
  });

  it('accepts only Equals and Is one of', () => {
    for (const operator of ['isNot', 'notIn', 'in', '!=', undefined]) {
      assert.equal(normalizeCondition({ ...statusCondition(['1']), operator }), null, String(operator));
    }
  });

  it('tells user conditions from option ones, and offers each kind its operators', () => {
    assert.equal(conditionKind(meCondition('assignee')), 'user');
    assert.equal(conditionKind(statusCondition(['1'])), 'option');
    assert.deepEqual(operatorsFor('user'), ['equals']);
    assert.deepEqual(operatorsFor('option'), ['equals', 'isOneOf']);
  });
});

describe('Custom views - validating a new or edited view', () => {
  const draft = (overrides = {}) => ({ name: 'Development Queue', field: STATUS, operator: 'equals', values: [{ id: '3', label: 'In Progress' }], ...overrides });

  it('accepts a valid view, trimming its name', () => {
    const { errors, view: valid } = validateViewDraft(draft({ name: '  Development Queue  ' }), { views: [] });
    assert.deepEqual(errors, {});
    assert.deepEqual(valid, { name: 'Development Queue', conditions: [{ field: { id: 'status', name: 'Status' }, operator: 'equals', values: [{ id: '3', label: 'In Progress' }] }] });
  });

  it('requires a name', () => {
    assert.match(validateViewDraft(draft({ name: '   ' }), { views: [] }).errors.name, /Enter a name/);
  });

  it('allows names of up to 30 characters', () => {
    assert.equal(MAX_VIEW_NAME_LENGTH, 30);
    assert.deepEqual(validateViewDraft(draft({ name: 'x'.repeat(30) }), { views: [] }).errors, {});
    assert.match(validateViewDraft(draft({ name: 'x'.repeat(31) }), { views: [] }).errors.name, /at most 30 characters/);
  });

  it('reserves Active (the built-in view\'s name) and All, in any letter case', () => {
    assert.deepEqual([ALL_VIEW_ID, ALL_VIEW_NAME], ['all', 'Active']);
    assert.deepEqual(RESERVED_VIEW_NAMES, ['Active', 'All']);
    for (const name of ['Active', 'active', ' ACTIVE ']) assert.match(validateViewDraft(draft({ name }), { views: [] }).errors.name, /"Active" can't be a custom view's name/);
    for (const name of ['All', 'all', ' ALL ']) assert.match(validateViewDraft(draft({ name }), { views: [] }).errors.name, /"All"/);
    assert.match(nameProblem('aLl'), /"All"/);
    assert.equal(nameProblem('Active work'), '');
  });

  it('rejects a name another view has, in any letter case, but not the edited view\'s own', () => {
    const views = [view('a', 'Development Queue'), view('b', 'Review')];
    assert.match(validateViewDraft(draft({ name: 'development queue' }), { views }).errors.name, /Another view already has this name/);
    assert.deepEqual(validateViewDraft(draft({ name: 'DEVELOPMENT QUEUE' }), { views, editingId: 'a' }).errors, {});
  });

  it('allows at most two custom views', () => {
    const views = [view('a', 'One'), view('b', 'Two')];
    assert.match(validateViewDraft(draft({ name: 'Three' }), { views }).errors.form, /at most 2 custom views/);
    assert.deepEqual(validateViewDraft(draft({ name: 'One again' }), { views, editingId: 'a' }).errors, {});
  });

  it('notices when the edited view was deleted meanwhile', () => {
    assert.match(validateViewDraft(draft(), { views: [], editingId: 'gone' }).errors.form, /deleted/);
  });

  it('requires a field, an operator it allows, and the right number of values', () => {
    assert.match(validateViewDraft(draft({ field: null }), { views: [] }).errors.field, /Choose a field/);
    assert.match(validateViewDraft(draft({ operator: 'isNot' }), { views: [] }).errors.operator, /Choose an operator/);
    assert.match(validateViewDraft(draft({ values: [] }), { views: [] }).errors.values, /Choose a value/);
    assert.match(validateViewDraft(draft({ operator: 'isOneOf', values: [{ id: '3', label: 'A' }] }), { views: [] }).errors.values, /at least two values/);
    assert.deepEqual(validateViewDraft(draft({ operator: 'isOneOf', values: [{ id: '3', label: 'A' }, { id: '4', label: 'B' }] }), { views: [] }).errors, {});
  });

  it('allows only Equals and Me for user fields', () => {
    assert.deepEqual(validateViewDraft(draft({ field: ASSIGNEE, values: [{ ...ME_VALUE }] }), { views: [] }).errors, {});
    assert.match(validateViewDraft(draft({ field: ASSIGNEE, operator: 'isOneOf', values: [{ ...ME_VALUE }] }), { views: [] }).errors.operator, /Choose an operator/);
    assert.match(validateViewDraft(draft({ field: ASSIGNEE, values: [{ id: 'someone', label: 'Someone' }] }), { views: [] }).errors.values, /Choose Me/);
  });

  it('keeps exactly one condition', () => {
    const { view: valid } = validateViewDraft(draft(), { views: [] });
    assert.equal(valid.conditions.length, 1);
    assert.equal(normalizeView({ id: 'x', name: 'Two', conditions: [statusCondition(['1']), statusCondition(['2'])] }), null);
  });
});

describe('Custom views - fields', () => {
  it('offers the standard fields: Status, Priority, Assignee, Reporter', () => {
    assert.deepEqual(SYSTEM_FIELDS.map((f) => [f.id, f.kind]), [['status', 'option'], ['priority', 'option'], ['assignee', 'user'], ['reporter', 'user']]);
    assert.deepEqual(OPERATORS, { EQUALS: 'equals', IS_ONE_OF: 'isOneOf' });
  });

  it('describes a view\'s search for its panel', () => {
    assert.equal(describeView(view('a', 'A', meCondition('reporter', 'Reporter'))), 'Reporter is Me');
    assert.equal(describeView(view('b', 'B', statusCondition(['1', '2']))), 'Status is one of Status 1, Status 2');
  });
});

describe('Custom views - custom fields from Jira', () => {
  const field = (id, name, schema, extra = {}) => ({ id, name, custom: true, navigable: true, schema, ...extra });
  const SELECT_SCHEMA = { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select', customId: 10100 };
  const RADIO_SCHEMA = { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:radiobuttons' };

  it('offers custom single-select and radio-button fields, sorted by name', () => {
    assert.deepEqual(parseSingleSelectFields([
      field('customfield_10101', 'Urgent', RADIO_SCHEMA),
      field('customfield_10100', 'Team', SELECT_SCHEMA)
    ]), [
      { id: 'customfield_10100', name: 'Team', kind: 'option', type: 'select' },
      { id: 'customfield_10101', name: 'Urgent', kind: 'option', type: 'radio' }
    ]);
  });

  it('leaves out multi-select, cascading select, user pickers, system fields, and anything ambiguous', () => {
    assert.deepEqual(parseSingleSelectFields([
      field('customfield_1', 'Multi', { type: 'array', items: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:multiselect' }),
      field('customfield_2', 'Cascade', { type: 'option-with-child', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect' }),
      field('customfield_3', 'QA', { type: 'user', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker' }),
      field('customfield_4', 'Odd select', { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' }),
      field('customfield_5', 'App option', { type: 'option', custom: 'com.vendor:option-field' }),
      field('customfield_6', 'Hidden', SELECT_SCHEMA, { navigable: false }),
      field('customfield_7', '', SELECT_SCHEMA),
      { id: 'priority', name: 'Priority', custom: false, schema: { type: 'priority' } },
      field('customfield_8', 'Not custom', SELECT_SCHEMA, { custom: false })
    ]), []);
  });

  it('refuses a response that isn\'t a list of fields', () => {
    assert.throws(() => parseSingleSelectFields({ fields: [] }), /unexpected list of fields/);
  });
});

describe('Custom views - availability of a view\'s field', () => {
  const selectView = view('a', 'Team', { field: { id: 'customfield_10100', name: 'Team' }, operator: 'equals', values: [{ id: '1', label: 'X' }] });
  const qaView = view('b', 'QA', meCondition('customfield_10050', 'QA Assignee'));

  it('keeps the standard fields available', () => {
    assert.equal(isViewAvailable(view('s', 'S'), { assignmentFieldIds: [], singleSelectFieldIds: new Set() }), true);
    assert.equal(isViewAvailable(view('r', 'R', meCondition('reporter')), { assignmentFieldIds: [], singleSelectFieldIds: new Set() }), true);
  });

  it('keeps a user custom field available while it\'s an Additional Assignment Field', () => {
    assert.equal(isViewAvailable(qaView, { assignmentFieldIds: ['customfield_10050'], singleSelectFieldIds: null }), true);
    assert.equal(isViewAvailable(qaView, { assignmentFieldIds: [], singleSelectFieldIds: null }), false);
  });

  it('keeps a custom option field available while Jira lists it, and assumes so while that isn\'t known', () => {
    assert.equal(isViewAvailable(selectView, { assignmentFieldIds: [], singleSelectFieldIds: null }), true);
    assert.equal(isViewAvailable(selectView, { assignmentFieldIds: [], singleSelectFieldIds: new Set(['customfield_10100']) }), true);
    assert.equal(isViewAvailable(selectView, { assignmentFieldIds: [], singleSelectFieldIds: new Set() }), false);
  });

  it('asks for Jira\'s fields only when a view filters on a custom option field', () => {
    assert.equal(usesCustomOptionField([view('s', 'S'), qaView]), false);
    assert.equal(usesCustomOptionField([selectView]), true);
  });
});

describe('Custom views - Jira\'s lists of statuses and priorities', () => {
  it('reads GET /status and GET /priority, and the values of GET /priority/search', () => {
    const statuses = [{ id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } }, { id: 10413, name: 'Selected for Development' }];
    assert.deepEqual(parseNamedValues(statuses), [{ id: '3', label: 'In Progress' }, { id: '10413', label: 'Selected for Development' }]);
    assert.deepEqual(parseNamedValues({ values: [{ id: '2', name: 'High' }], isLast: true }), [{ id: '2', label: 'High' }]);
  });

  it('keeps each ID once, sorted by name, and skips entries without an ID or a name', () => {
    assert.deepEqual(parseNamedValues([
      { id: '2', name: 'Verify' }, { id: '2', name: 'Again' }, { id: '1', name: 'Demo' }, { name: 'No ID' }, { id: '9' }, { id: '8', name: '  ' }, null
    ]), [{ id: '1', label: 'Demo' }, { id: '2', label: 'Verify' }]);
  });

  it('refuses a response that isn\'t a list', () => {
    assert.throws(() => parseNamedValues({ statuses: [] }), /unexpected list of values/);
    assert.throws(() => parseNamedValues(null), /unexpected list of values/);
  });
});

describe('Custom views - their own JQL', () => {
  const jql = (condition, context) => buildCustomViewJql({ conditions: [condition] }, context);
  const option = (fieldId, operator, labels) => ({
    field: { id: fieldId, name: fieldId }, operator, values: labels.map((label, index) => ({ id: label, label: labels[index] }))
  });
  const ORDER = ' ORDER BY updated DESC, key DESC';

  it('compares Reporter and Assignee with currentUser()', () => {
    assert.equal(jql(meCondition('reporter')), `reporter = currentUser()${ORDER}`);
    assert.equal(jql(meCondition('assignee')), `assignee = currentUser()${ORDER}`);
  });

  it('compares an Additional Assignment Field with currentUser(), by its number, while it is one', () => {
    assert.equal(jql(meCondition('customfield_10050'), { assignmentFieldIds: ['customfield_10050'] }), `cf[10050] = currentUser()${ORDER}`);
    assert.throws(() => jql(meCondition('customfield_10050'), { assignmentFieldIds: [] }), /no longer available/);
  });

  it('compares Status by its IDs: Equals and Is one of', () => {
    assert.equal(jql(statusCondition(['10413'])), `status = 10413${ORDER}`);
    assert.equal(jql(statusCondition(['10413', '3'])), `status in (10413, 3)${ORDER}`);
  });

  it('compares Priority by its IDs', () => {
    const priority = (ids, operator) => ({ field: { id: 'priority', name: 'Priority' }, operator, values: ids.map((id) => ({ id, label: `P${id}` })) });
    assert.equal(jql(priority(['2'], 'equals')), `priority = 2${ORDER}`);
    assert.equal(jql(priority(['1', '2'], 'isOneOf')), `priority in (1, 2)${ORDER}`);
  });

  it('compares a custom single-select or radio-button field by the option\'s quoted name', () => {
    assert.equal(jql(option('customfield_11300', 'equals', ['Platform'])), `cf[11300] = "Platform"${ORDER}`);
    assert.equal(jql(option('customfield_12802', 'isOneOf', ['Yes', 'Cisco UC Apps'])), `cf[12802] in ("Yes", "Cisco UC Apps")${ORDER}`);
  });

  it('keeps every custom option name inside its quotes: an injection attempt stays one name', () => {
    const attempt = 'x") OR project = SECRET OR (cf[1] = "y';
    assert.equal(jql(option('customfield_11300', 'equals', [attempt])),
      `cf[11300] = "x\\") OR project = SECRET OR (cf[1] = \\"y"${ORDER}`);
    assert.equal(jql(option('customfield_11300', 'equals', ['back\\slash "quoted"'])), `cf[11300] = "back\\\\slash \\"quoted\\""${ORDER}`);
    assert.equal(jqlString('O\'Brien'), '"O\'Brien"');
  });

  it('refuses names a JQL string can\'t carry, such as line breaks', () => {
    assert.throws(() => jql(option('customfield_11300', 'equals', ['two\nlines'])), /isn't valid/);
    assert.throws(() => jqlString('tab\there'), /can't be searched/);
  });

  it('refuses Status and Priority values that aren\'t Jira\'s numeric IDs', () => {
    for (const id of ['1 OR 1=1', '3)', 'In Progress', '-1', '1.5', '']) {
      assert.throws(() => jql({ field: { id: 'status', name: 'Status' }, operator: 'equals', values: [{ id, label: 'x' }] }), /isn't valid/, id);
      assert.throws(() => jql({ field: { id: 'priority', name: 'Priority' }, operator: 'equals', values: [{ id, label: 'x' }] }), /isn't valid/, id);
    }
  });

  it('refuses unsupported fields and operators, and anything but one condition', () => {
    assert.throws(() => jql({ field: { id: 'project', name: 'Project' }, operator: 'equals', values: [{ id: '1', label: 'X' }] }), /isn't valid/);
    assert.throws(() => jql({ field: { id: 'status) OR (1', name: 'S' }, operator: 'equals', values: [{ id: '1', label: 'X' }] }), /isn't valid/);
    assert.throws(() => jql({ ...statusCondition(['1']), operator: 'notIn' }), /isn't valid/);
    assert.throws(() => jql({ ...statusCondition(['1']), operator: 'isNot' }), /isn't valid/);
    assert.throws(() => buildCustomViewJql({ conditions: [] }), /exactly one condition/);
    assert.throws(() => buildCustomViewJql({ conditions: [statusCondition(['1']), statusCondition(['2'])] }), /exactly one condition/);
    assert.throws(() => buildCustomViewJql(null), /exactly one condition/);
  });

  it('never compares a person but Me: an account or a name is refused', () => {
    for (const values of [[{ id: 'someone', label: 'Someone' }], [{ accountId: 'abc' }], [{ currentUser: true }, { currentUser: true }]]) {
      assert.throws(() => jql({ field: { id: 'assignee', name: 'Assignee' }, operator: 'equals', values }), /isn't valid/);
    }
  });

  it('never asks Active Issues\' restrictions: a Status view finds every issue in that status', () => {
    const query = jql(statusCondition(['3']));
    assert.doesNotMatch(query, /currentUser|worklog|statusCategory|assignee/);
  });

  it('orders the issues by the latest update, then by key, so the first ones are always the same', () => {
    assert.match(jql(statusCondition(['3'])), / ORDER BY updated DESC, key DESC$/);
    assert.equal(CUSTOM_VIEW_RESULT_LIMIT, 20);
  });
});

describe('Custom views - custom option values from Jira\'s suggestions', () => {
  it('reads the suggestions\' JQL values as names: unquoted, unescaped, each once, in Jira\'s order', () => {
    assert.deepEqual(parseFieldSuggestions({ results: [
      { value: 'Sega', displayName: '<b>Se</b>ga' },
      { value: '"Cisco UC Apps"', displayName: 'Cisco UC Apps' },
      { value: '"say \\"hi\\""', displayName: 'say "hi"' },
      { value: 'Sega' },
      { value: '' },
      { displayName: 'No value' },
      null
    ] }), [
      { id: 'Sega', label: 'Sega' },
      { id: 'Cisco UC Apps', label: 'Cisco UC Apps' },
      { id: 'say "hi"', label: 'say "hi"' }
    ]);
  });

  it('never reads the suggestions\' markup', () => {
    assert.deepEqual(parseFieldSuggestions({ results: [{ value: 'Migrate', displayName: '<b>Mig</b>rate' }] }), [{ id: 'Migrate', label: 'Migrate' }]);
  });

  it('refuses a response that isn\'t a list of suggestions', () => {
    assert.throws(() => parseFieldSuggestions([]), /unexpected suggestions/);
    assert.throws(() => parseFieldSuggestions(null), /unexpected suggestions/);
  });

  it('stores a suggested option by its name, which the view\'s JQL compares', () => {
    const condition = normalizeCondition({ field: { id: 'customfield_11300', name: 'Team' }, operator: 'equals', values: parseFieldSuggestions({ results: [{ value: '"Cisco UC Apps"' }] }) });
    assert.deepEqual(condition.values, [{ id: 'Cisco UC Apps', label: 'Cisco UC Apps' }]);
    assert.equal(buildCustomViewJql({ conditions: [condition] }), 'cf[11300] = "Cisco UC Apps" ORDER BY updated DESC, key DESC');
  });
});
