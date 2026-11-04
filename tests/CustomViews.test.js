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
  usesCustomField,
  viewUserFieldIds,
  normalizeConditions,
  MAX_VIEW_JQL_LENGTH,
  normalizeViewOrder,
  normalizeCustomViewOrderBySite,
  orderViews,
  reorderViewIds,
  dropPosition,
  parseNamedValues,
  parseFieldSuggestions,
  buildCustomViewJql,
  jqlString,
  describeView,
  normalizeOrderBy,
  ORDER_BY_FIELDS,
  ORDER_DIRECTIONS,
  DEFAULT_ORDER_BY
} from '../src/jira/customViews.js';

const statusCondition = (ids, operator = ids.length > 1 ? 'in' : 'in') => ({
  field: { id: 'status', name: 'Status' }, operator, values: ids.map((id) => ({ id, label: `Status ${id}` }))
});
const meCondition = (fieldId, name = fieldId) => ({ field: { id: fieldId, name }, operator: 'in', values: [{ currentUser: true, label: 'Me' }] });
const DEFAULT_ORDER = { field: 'updated', direction: 'DESC' };
const view = (id, name, condition = statusCondition(['3']), orderBy = DEFAULT_ORDER) => ({ id, name, conditions: [condition], orderBy });

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

  it('keeps at most five views, each ID and name once (names in any case)', () => {
    const { views } = normalizeSiteViews({ version: 1, views: [
      view('a', 'Queue'), view('a', 'Other'), view('b', 'QUEUE'), view('c', 'Review'), view('d', 'Third'), view('e', 'Fourth'), view('f', 'Fifth'), view('g', 'Sixth')
    ] });
    assert.deepEqual(views.map((v) => v.id), ['a', 'c', 'd', 'e', 'f']);
    assert.equal(MAX_CUSTOM_VIEWS, 5);
  });

  it('drops malformed views, keeping the valid ones', () => {
    const { views } = normalizeSiteViews({ version: 1, views: [
      { id: 'bad id!', name: 'X', conditions: [statusCondition(['1'])] },
      { id: 'all', name: 'Everything', conditions: [statusCondition(['1'])] },
      { id: 'e', name: 'Active', conditions: [statusCondition(['1'])] },
      { id: 'f2', name: 'All', conditions: [statusCondition(['1'])] },
      { id: 'f', name: '   ', conditions: [statusCondition(['1'])] },
      { id: 'g', name: 'x'.repeat(31), conditions: [statusCondition(['1'])] },
      { id: 'h', name: 'Same field twice', conditions: [statusCondition(['1']), statusCondition(['2'])] },
      { id: 'h2', name: 'One bad condition', conditions: [statusCondition(['1']), { field: { id: 'labels' }, operator: 'in', values: [{ id: 'x' }] }] },
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
  it('accepts In and Not in with one value or several, for option fields, and no values never', () => {
    for (const operator of ['in', 'notIn']) {
      assert.equal(normalizeCondition(statusCondition(['1'], operator)).operator, operator);
      assert.equal(normalizeCondition(statusCondition(['1', '2'], operator)).values.length, 2);
      assert.equal(normalizeCondition(statusCondition([], operator)), null);
    }
  });

  it('reads the operators views had before as In, keeping every value', () => {
    assert.deepEqual(normalizeCondition({ field: { id: 'status', name: 'Status' }, operator: 'equals', values: [{ id: '3', label: 'In Progress' }] }),
      { field: { id: 'status', name: 'Status' }, operator: 'in', values: [{ id: '3', label: 'In Progress' }] });
    assert.deepEqual(normalizeCondition({ field: { id: 'priority', name: 'Priority' }, operator: 'isOneOf', values: [{ id: '1', label: 'Highest' }, { id: '2', label: 'High' }] }).values.map((v) => v.id), ['1', '2']);
    assert.equal(normalizeCondition({ ...meCondition('customfield_13931'), operator: 'equals' }).operator, 'in');
  });

  it('keeps values by ID once, with numeric IDs as text and labels defaulting to the ID', () => {
    assert.deepEqual(normalizeCondition({ field: { id: 'priority' }, operator: 'in', values: [{ id: 2, label: 'High' }, { id: '2' }, { id: '3' }] }),
      { field: { id: 'priority', name: 'priority' }, operator: 'in', values: [{ id: '2', label: 'High' }, { id: '3', label: '3' }] });
  });

  it('accepts Me alone, with In or Not in, on user fields; never on Status or Priority', () => {
    for (const id of ['assignee', 'reporter', 'customfield_10050']) {
      assert.deepEqual(normalizeCondition(meCondition(id)).values, [{ currentUser: true, label: 'Me' }]);
      assert.equal(normalizeCondition({ ...meCondition(id), operator: 'notIn' }).operator, 'notIn');
      assert.equal(normalizeCondition({ ...meCondition(id), values: [{ currentUser: true }, { currentUser: true }] }), null);
    }
    assert.equal(normalizeCondition(meCondition('status')), null);
    assert.equal(normalizeCondition(meCondition('priority')), null);
  });

  it('never stores another person: Assignee and Reporter take Me only', () => {
    assert.equal(normalizeCondition({ field: { id: 'assignee' }, operator: 'in', values: [{ id: 'someone', label: 'Someone Else' }] }), null);
    assert.equal(normalizeCondition({ field: { id: 'reporter' }, operator: 'in', values: [{ accountId: 'x' }] }), null);
    assert.equal(normalizeCondition({ field: { id: 'assignee' }, operator: 'in', values: [{ currentUser: true, accountId: 'me', displayName: 'Me Myself' }] }).values[0].accountId, undefined);
  });

  it('accepts only the fields views support', () => {
    for (const id of ['summary', 'labels', 'components', 'customfield_', 'customfield_10x', 'worklog', 'status;drop']) {
      assert.equal(normalizeCondition({ field: { id }, operator: 'in', values: [{ id: '1' }] }), null, id);
    }
  });

  it('accepts only In and Not in (and the operators views had before)', () => {
    for (const operator of ['isNot', 'not in', 'IN', '!=', '=', 'in;', 'toString', undefined]) {
      assert.equal(normalizeCondition({ ...statusCondition(['1']), operator }), null, String(operator));
    }
  });

  it('tells user conditions from option ones, and offers each kind its operators', () => {
    assert.equal(conditionKind(meCondition('assignee')), 'user');
    assert.equal(conditionKind(statusCondition(['1'])), 'option');
    assert.deepEqual(operatorsFor('user'), ['in', 'notIn']);
    assert.deepEqual(operatorsFor('option'), ['in', 'notIn']);
  });
});

describe('Custom views - validating a new or edited view', () => {
  /** A draft with one condition: `field`, `operator`, and `values` override the condition's. */
  const draft = ({ field = STATUS, operator = 'in', values = [{ id: '3', label: 'In Progress' }], ...overrides } = {}) =>
    ({ name: 'Development Queue', conditions: [{ field, operator, values }], orderBy: DEFAULT_ORDER, ...overrides });

  it('accepts a valid view, trimming its name', () => {
    const { errors, view: valid } = validateViewDraft(draft({ name: '  Development Queue  ' }), { views: [] });
    assert.deepEqual(errors, {});
    assert.deepEqual(valid, { name: 'Development Queue', conditions: [{ field: { id: 'status', name: 'Status' }, operator: 'in', values: [{ id: '3', label: 'In Progress' }] }], orderBy: DEFAULT_ORDER });
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

  it('allows at most five custom views', () => {
    const four = ['One', 'Two', 'Three', 'Four'].map((name, i) => view(`v${i}`, name));
    assert.deepEqual(validateViewDraft(draft({ name: 'Five' }), { views: four }).errors, {}, 'a fifth');
    const five = [...four, view('v4', 'Five')];
    assert.match(validateViewDraft(draft({ name: 'Six' }), { views: five }).errors.form, /at most 5 custom views/);
    assert.deepEqual(validateViewDraft(draft({ name: 'One again' }), { views: five, editingId: 'v0' }).errors, {}, 'editing one of five');
  });

  it('notices when the edited view was deleted meanwhile', () => {
    assert.match(validateViewDraft(draft(), { views: [], editingId: 'gone' }).errors.form, /deleted/);
  });

  it('requires a field, an operator it allows, and the right number of values', () => {
    assert.match(validateViewDraft(draft({ field: null }), { views: [] }).errors.byCondition[0].field, /Choose a field/);
    assert.match(validateViewDraft(draft({ operator: 'isNot' }), { views: [] }).errors.byCondition[0].operator, /Choose an operator/);
    assert.match(validateViewDraft(draft({ values: [] }), { views: [] }).errors.byCondition[0].values, /Choose at least one value/);
    assert.match(validateViewDraft(draft({ operator: 'notIn', values: [] }), { views: [] }).errors.byCondition[0].values, /Choose at least one value/);
    for (const operator of ['in', 'notIn']) {
      assert.deepEqual(validateViewDraft(draft({ operator, values: [{ id: '3', label: 'A' }] }), { views: [] }).errors, {}, `${operator}, one value`);
      assert.deepEqual(validateViewDraft(draft({ operator, values: [{ id: '3', label: 'A' }, { id: '4', label: 'B' }] }), { views: [] }).errors, {}, `${operator}, two values`);
    }
  });

  it('allows In and Not in, with Me alone, for user fields', () => {
    assert.deepEqual(validateViewDraft(draft({ field: ASSIGNEE, values: [{ ...ME_VALUE }] }), { views: [] }).errors, {});
    assert.deepEqual(validateViewDraft(draft({ field: ASSIGNEE, operator: 'notIn', values: [{ ...ME_VALUE }] }), { views: [] }).errors, {});
    assert.match(validateViewDraft(draft({ field: ASSIGNEE, operator: 'equals', values: [{ ...ME_VALUE }] }), { views: [] }).errors.byCondition[0].operator, /Choose an operator/, 'drafts use the new operators');
    assert.match(validateViewDraft(draft({ field: ASSIGNEE, values: [{ id: 'someone', label: 'Someone' }] }), { views: [] }).errors.byCondition[0].values, /Choose Me/);
  });

  it('keeps one condition as one, and accepts several, each checked, at most one per field', () => {
    assert.equal(validateViewDraft(draft(), { views: [] }).view.conditions.length, 1);
    const several = { ...draft(), conditions: [
      { field: STATUS, operator: 'in', values: [{ id: '10413', label: 'Selected for Development' }] },
      { field: PRIORITY, operator: 'in', values: [{ id: '1', label: 'Highest' }, { id: '2', label: 'High' }] },
      { field: { id: 'customfield_13931', name: 'QA Assignee', kind: 'user' }, operator: 'in', values: [{ ...ME_VALUE }] }
    ] };
    const { errors, view: valid } = validateViewDraft(several, { views: [] });
    assert.deepEqual(errors, {});
    assert.deepEqual(valid.conditions.map((c) => [c.field.id, c.operator, c.values.map((v) => v.id ?? 'me')]),
      [['status', 'in', ['10413']], ['priority', 'in', ['1', '2']], ['customfield_13931', 'in', ['me']]]);
  });

  it('says which condition is wrong, and how, keeping the others', () => {
    const { errors, view: valid } = validateViewDraft({ ...draft(), conditions: [
      { field: STATUS, operator: 'in', values: [{ id: '3', label: 'In Progress' }] },
      { field: null, operator: 'in', values: [] },
      { field: PRIORITY, operator: 'notIn', values: [] },
      { field: STATUS, operator: 'in', values: [{ id: '4', label: 'In Review' }] },
      { field: ASSIGNEE, operator: 'isOneOf', values: [{ ...ME_VALUE }] }
    ] }, { views: [] });
    assert.equal(valid, null);
    assert.deepEqual(errors.byCondition, [
      null,
      { field: 'Choose a field.' },
      { values: 'Choose at least one value.' },
      { field: 'Another condition already uses this field.' },
      { operator: 'Choose an operator.' }
    ]);
  });

  it('requires at least one condition', () => {
    const { errors, view: valid } = validateViewDraft({ ...draft(), conditions: [] }, { views: [] });
    assert.equal(valid, null);
    assert.equal(errors.conditions, 'Add at least one condition.');
  });

  it('refuses a view whose JQL would be too long for one Jira request', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ id: String(10000 + i), label: `Status ${i}` }));
    const { errors } = validateViewDraft(draft({ operator: 'in', values: many }), { views: [] });
    assert.match(errors.conditions, /too long for Jira/);
    assert.equal(MAX_VIEW_JQL_LENGTH, 2000);
  });

  it('reads stored conditions only when every one is valid, each on its own field', () => {
    assert.equal(normalizeConditions([statusCondition(['1']), meCondition('reporter')]).length, 2);
    assert.equal(normalizeConditions([]), null);
    assert.equal(normalizeConditions([statusCondition(['1']), { field: { id: 'labels' } }]), null);
    assert.equal(normalizeConditions([meCondition('reporter'), meCondition('reporter')]), null);
    assert.equal(normalizeView({ id: 'x', name: 'Two', conditions: [statusCondition(['1']), statusCondition(['2'])] }), null);
  });
});

describe('Custom views - fields', () => {
  it('offers the standard fields: Status, Priority, Assignee, Reporter', () => {
    assert.deepEqual(SYSTEM_FIELDS.map((f) => [f.id, f.kind]), [['status', 'option'], ['priority', 'option'], ['assignee', 'user'], ['reporter', 'user']]);
    assert.deepEqual(OPERATORS, { IN: 'in', NOT_IN: 'notIn' });
  });

  it('describes a view\'s search for its panel', () => {
    assert.equal(describeView(view('a', 'A', meCondition('reporter', 'Reporter'))), 'Reporter in Me · Updated, descending');
    assert.equal(describeView(view('b', 'B', statusCondition(['1', '2']), { field: 'priority', direction: 'ASC' })), 'Status in Status 1, Status 2 · Priority, ascending');
    assert.equal(describeView({ conditions: [meCondition('reporter', 'Reporter')] }), 'Reporter in Me · Updated, descending', 'an old view');
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
  const selectView = view('a', 'Team', { field: { id: 'customfield_10100', name: 'Team' }, operator: 'in', values: [{ id: '1', label: 'X' }] });
  const qaView = view('b', 'QA', meCondition('customfield_10050', 'QA Assignee'));

  it('keeps the standard fields available', () => {
    assert.equal(isViewAvailable(view('s', 'S'), { assignmentFieldIds: [], singleSelectFieldIds: new Set() }), true);
    assert.equal(isViewAvailable(view('r', 'R', meCondition('reporter')), { assignmentFieldIds: [], singleSelectFieldIds: new Set() }), true);
  });

  it('keeps a custom user field available while it\'s an Additional Assignment Field or one of the site\'s single-user fields', () => {
    assert.equal(isViewAvailable(qaView, { assignmentFieldIds: ['customfield_10050'], singleSelectFieldIds: null, userPickerFieldIds: new Set() }), true);
    assert.equal(isViewAvailable(qaView, { assignmentFieldIds: [], singleSelectFieldIds: null, userPickerFieldIds: new Set(['customfield_10050']) }), true);
    assert.equal(isViewAvailable(qaView, { assignmentFieldIds: [], singleSelectFieldIds: null, userPickerFieldIds: null }), true, 'assumed while not known');
    assert.equal(isViewAvailable(qaView, { assignmentFieldIds: [], singleSelectFieldIds: null, userPickerFieldIds: new Set(['customfield_99999']) }), false, 'gone from Jira');
  });

  it('allows the JQL only the custom user fields it may compare with Me', () => {
    const known = { assignmentFieldIds: ['customfield_10600'], userPickerFieldIds: new Set(['customfield_13931', 'customfield_10600']) };
    const two = view('q', 'QA and Dev', meCondition('customfield_13931'));
    two.conditions.push(meCondition('customfield_10600'));
    assert.deepEqual(viewUserFieldIds(two, known), ['customfield_13931', 'customfield_10600']);
    assert.deepEqual(viewUserFieldIds(two, { assignmentFieldIds: [], userPickerFieldIds: new Set(['customfield_10600']) }), ['customfield_10600']);
    assert.deepEqual(viewUserFieldIds(two, { assignmentFieldIds: [], userPickerFieldIds: null }), ['customfield_13931', 'customfield_10600']);
  });

  it('keeps a custom option field available while Jira lists it, and assumes so while that isn\'t known', () => {
    assert.equal(isViewAvailable(selectView, { assignmentFieldIds: [], singleSelectFieldIds: null }), true);
    assert.equal(isViewAvailable(selectView, { assignmentFieldIds: [], singleSelectFieldIds: new Set(['customfield_10100']) }), true);
    assert.equal(isViewAvailable(selectView, { assignmentFieldIds: [], singleSelectFieldIds: new Set() }), false);
  });

  it('asks for Jira\'s fields only when a view filters on a custom field it needs them for', () => {
    assert.equal(usesCustomField([view('s', 'S'), view('r', 'R', meCondition('reporter'))]), false);
    assert.equal(usesCustomField([selectView]), true);
    assert.equal(usesCustomField([qaView]), true, 'a custom user field, to check it\'s still a user field');
    assert.equal(usesCustomField([qaView], ['customfield_10050']), false, 'unless it\'s an Additional Assignment Field');
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
    assert.equal(jql(meCondition('reporter')), `reporter in (currentUser())${ORDER}`);
    assert.equal(jql(meCondition('assignee')), `assignee in (currentUser())${ORDER}`);
  });

  it('compares a custom user field with currentUser(), by its number, only when it\'s allowed', () => {
    assert.equal(jql(meCondition('customfield_10050'), { userFieldIds: ['customfield_10050'] }), `cf[10050] in (currentUser())${ORDER}`);
    assert.throws(() => jql(meCondition('customfield_10050'), { userFieldIds: [] }), /no longer available/);
  });

  it('compares Status by its IDs: Equals and Is one of', () => {
    assert.equal(jql(statusCondition(['10413'])), `status in (10413)${ORDER}`);
    assert.equal(jql(statusCondition(['10413', '3'])), `status in (10413, 3)${ORDER}`);
  });

  it('compares Priority by its IDs', () => {
    const priority = (ids, operator) => ({ field: { id: 'priority', name: 'Priority' }, operator, values: ids.map((id) => ({ id, label: `P${id}` })) });
    assert.equal(jql(priority(['2'], 'in')), `priority in (2)${ORDER}`);
    assert.equal(jql(priority(['1', '2'], 'in')), `priority in (1, 2)${ORDER}`);
  });

  it('compares a custom single-select or radio-button field by the option\'s quoted name', () => {
    assert.equal(jql(option('customfield_11300', 'in', ['Platform'])), `cf[11300] in ("Platform")${ORDER}`);
    assert.equal(jql(option('customfield_12802', 'in', ['Yes', 'Cisco UC Apps'])), `cf[12802] in ("Yes", "Cisco UC Apps")${ORDER}`);
  });

  it('keeps every custom option name inside its quotes: an injection attempt stays one name', () => {
    const attempt = 'x") OR project = SECRET OR (cf[1] = "y';
    assert.equal(jql(option('customfield_11300', 'in', [attempt])),
      `cf[11300] in ("x\\") OR project = SECRET OR (cf[1] = \\"y")${ORDER}`);
    assert.equal(jql(option('customfield_11300', 'in', ['back\\slash "quoted"'])), `cf[11300] in ("back\\\\slash \\"quoted\\"")${ORDER}`);
    assert.equal(jql(option('customfield_11300', 'notIn', [attempt])),
      `(cf[11300] not in ("x\\") OR project = SECRET OR (cf[1] = \\"y") OR cf[11300] is EMPTY)${ORDER}`);
    assert.equal(jqlString('O\'Brien'), '"O\'Brien"');
  });

  it('refuses names a JQL string can\'t carry, such as line breaks', () => {
    assert.throws(() => jql(option('customfield_11300', 'in', ['two\nlines'])), /aren't valid/);
    assert.throws(() => jqlString('tab\there'), /can't be searched/);
  });

  it('refuses Status and Priority values that aren\'t Jira\'s numeric IDs', () => {
    for (const id of ['1 OR 1=1', '3)', 'In Progress', '-1', '1.5', '']) {
      assert.throws(() => jql({ field: { id: 'status', name: 'Status' }, operator: 'in', values: [{ id, label: 'x' }] }), /aren't valid/, id);
      assert.throws(() => jql({ field: { id: 'priority', name: 'Priority' }, operator: 'in', values: [{ id, label: 'x' }] }), /aren't valid/, id);
    }
  });

  it('refuses unsupported fields and operators, no conditions, and a field twice', () => {
    assert.throws(() => jql({ field: { id: 'project', name: 'Project' }, operator: 'in', values: [{ id: '1', label: 'X' }] }), /aren't valid/);
    assert.throws(() => jql({ field: { id: 'status) OR (1', name: 'S' }, operator: 'in', values: [{ id: '1', label: 'X' }] }), /aren't valid/);
    assert.throws(() => jql({ ...statusCondition(['1']), operator: 'not in' }), /aren't valid/);
    assert.throws(() => jql({ ...statusCondition(['1']), operator: 'isNot' }), /aren't valid/);
    assert.throws(() => jql({ ...statusCondition(['1']), operator: ') OR (1' }), /aren't valid/);
    assert.throws(() => buildCustomViewJql({ conditions: [] }), /at least one condition/);
    assert.throws(() => buildCustomViewJql({ conditions: [statusCondition(['1']), statusCondition(['2'])] }), /aren't valid/, 'a field twice');
    assert.throws(() => buildCustomViewJql(null), /at least one condition/);
  });

  it('never compares a person but Me: an account or a name is refused', () => {
    for (const values of [[{ id: 'someone', label: 'Someone' }], [{ accountId: 'abc' }], [{ currentUser: true }, { currentUser: true }]]) {
      assert.throws(() => jql({ field: { id: 'assignee', name: 'Assignee' }, operator: 'in', values }), /aren't valid/);
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
    const condition = normalizeCondition({ field: { id: 'customfield_11300', name: 'Team' }, operator: 'in', values: parseFieldSuggestions({ results: [{ value: '"Cisco UC Apps"' }] }) });
    assert.deepEqual(condition.values, [{ id: 'Cisco UC Apps', label: 'Cisco UC Apps' }]);
    assert.equal(buildCustomViewJql({ conditions: [condition] }), 'cf[11300] in ("Cisco UC Apps") ORDER BY updated DESC, key DESC');
  });
});

describe('Custom views - order', () => {
  const jql = (orderBy, condition = meCondition('reporter')) => buildCustomViewJql({ conditions: [condition], orderBy });

  it('offers Jira\'s sortable fields only, with Ascending and Descending, Updated descending by default', () => {
    assert.deepEqual(ORDER_BY_FIELDS.map((f) => [f.id, f.name]), [
      ['updated', 'Updated'], ['created', 'Created'], ['priority', 'Priority'], ['duedate', 'Due date'], ['status', 'Status'], ['key', 'Issue key']
    ]);
    assert.deepEqual(Object.values(ORDER_DIRECTIONS), ['ASC', 'DESC']);
    assert.deepEqual(DEFAULT_ORDER_BY, { field: 'updated', direction: 'DESC' });
  });

  it('orders the JQL by the view\'s field and direction, then by key the same way', () => {
    assert.equal(jql({ field: 'updated', direction: 'DESC' }), 'reporter in (currentUser()) ORDER BY updated DESC, key DESC');
    assert.equal(jql({ field: 'updated', direction: 'ASC' }), 'reporter in (currentUser()) ORDER BY updated ASC, key ASC');
    assert.equal(jql({ field: 'created', direction: 'DESC' }), 'reporter in (currentUser()) ORDER BY created DESC, key DESC');
    assert.equal(jql({ field: 'priority', direction: 'ASC' }), 'reporter in (currentUser()) ORDER BY priority ASC, key ASC');
    assert.equal(jql({ field: 'duedate', direction: 'ASC' }), 'reporter in (currentUser()) ORDER BY duedate ASC, key ASC');
    assert.equal(jql({ field: 'status', direction: 'DESC' }), 'reporter in (currentUser()) ORDER BY status DESC, key DESC');
    assert.equal(jql({ field: 'key', direction: 'ASC' }), 'reporter in (currentUser()) ORDER BY key ASC', 'no tiebreaker for the key itself');
  });

  it('keeps the condition exactly as before, the order after it', () => {
    assert.equal(jql({ field: 'priority', direction: 'ASC' }, statusCondition(['3', '10413'])), 'status in (3, 10413) ORDER BY priority ASC, key ASC');
    assert.equal(jql({ field: 'duedate', direction: 'DESC' }, { field: { id: 'customfield_11300', name: 'Team' }, operator: 'in', values: [{ id: 'Sega', label: 'Sega' }] }),
      'cf[11300] in ("Sega") ORDER BY duedate DESC, key DESC');
  });

  it('orders a view saved without an order, or with one that isn\'t valid, by Updated descending', () => {
    for (const orderBy of [undefined, null, {}, { field: 'updated' }, { direction: 'ASC' }]) {
      assert.equal(jql(orderBy), 'reporter in (currentUser()) ORDER BY updated DESC, key DESC', JSON.stringify(orderBy));
    }
  });

  it('never puts an unknown field or direction into the JQL', () => {
    for (const orderBy of [
      { field: 'summary', direction: 'ASC' }, { field: 'cf[10050]', direction: 'ASC' }, { field: 'updated; DROP', direction: 'ASC' },
      { field: 'updated DESC, created', direction: 'ASC' }, { field: 'updated', direction: 'asc' }, { field: 'updated', direction: 'DESC, key' },
      { field: 'Updated', direction: 'DESC' }, { field: 'updated', direction: 'RANDOM' }
    ]) {
      assert.equal(normalizeOrderBy(orderBy), null, JSON.stringify(orderBy));
      assert.equal(jql(orderBy), 'reporter in (currentUser()) ORDER BY updated DESC, key DESC', JSON.stringify(orderBy));
    }
  });

  it('stores the order with the view, keeping only Jira\'s fields and ASC or DESC', () => {
    const stored = normalizeView({ id: 'a', name: 'A', conditions: [statusCondition(['3'])], orderBy: { field: 'priority', direction: 'ASC', extra: 'x' } });
    assert.deepEqual(stored.orderBy, { field: 'priority', direction: 'ASC' });
    assert.deepEqual(normalizeView({ id: 'b', name: 'B', conditions: [statusCondition(['3'])] }).orderBy, DEFAULT_ORDER_BY, 'a view saved before orders');
    assert.deepEqual(normalizeView({ id: 'c', name: 'C', conditions: [statusCondition(['3'])], orderBy: { field: 'summary', direction: 'ASC' } }).orderBy, DEFAULT_ORDER_BY);
  });

  it('refuses a draft without a valid order', () => {
    const draft = (orderBy) => ({ name: 'A', conditions: [{ field: STATUS, operator: 'in', values: [{ id: '3', label: 'In Progress' }] }], orderBy });
    for (const orderBy of [undefined, { field: 'summary', direction: 'ASC' }, { field: 'updated', direction: 'up' }]) {
      assert.match(validateViewDraft(draft(orderBy), { views: [] }).errors.orderBy, /Choose an order and a direction/);
    }
    assert.deepEqual(validateViewDraft(draft({ field: 'duedate', direction: 'ASC' }), { views: [] }).view.orderBy, { field: 'duedate', direction: 'ASC' });
  });
});

describe('Custom views - several conditions, all met (AND)', () => {
  const ORDER = ' ORDER BY updated DESC, key DESC';
  const jql = (conditions, context, orderBy) => buildCustomViewJql({ conditions, orderBy }, context);
  const priority = (ids, operator = ids.length > 1 ? 'in' : 'in') => ({ field: { id: 'priority', name: 'Priority' }, operator, values: ids.map((id) => ({ id, label: `P${id}` })) });
  const option = (fieldId, labels) => ({ field: { id: fieldId, name: fieldId }, operator: labels.length > 1 ? 'in' : 'in', values: labels.map((label) => ({ id: label, label })) });

  it('joins one clause per condition with AND, in their order, before ORDER BY', () => {
    assert.equal(jql([statusCondition(['10413']), priority(['2'])]), `status in (10413) AND priority in (2)${ORDER}`);
    assert.equal(jql([statusCondition(['10413']), priority(['2']), meCondition('assignee')]),
      `status in (10413) AND priority in (2) AND assignee in (currentUser())${ORDER}`);
    assert.equal(jql([statusCondition(['10413', '3']), meCondition('reporter')], {}, { field: 'priority', direction: 'ASC' }),
      'status in (10413, 3) AND reporter in (currentUser()) ORDER BY priority ASC, key ASC');
  });

  it('combines custom option fields, quoted, with the others', () => {
    assert.equal(jql([option('customfield_11300', ['Sega', 'Cisco UC Apps']), priority(['1', '2'])]),
      `cf[11300] in ("Sega", "Cisco UC Apps") AND priority in (1, 2)${ORDER}`);
  });

  it('compares custom user fields with Me by their numbers, alone or with Status and Priority', () => {
    const qa = meCondition('customfield_13931', 'QA Assignee');
    const dev = meCondition('customfield_10600', 'Development Lead');
    const allowed = { userFieldIds: ['customfield_13931', 'customfield_10600'] };
    assert.equal(jql([qa], allowed), `cf[13931] in (currentUser())${ORDER}`);
    assert.equal(jql([statusCondition(['10413']), qa], allowed), `status in (10413) AND cf[13931] in (currentUser())${ORDER}`);
    assert.equal(jql([priority(['2']), qa], allowed), `priority in (2) AND cf[13931] in (currentUser())${ORDER}`);
    assert.equal(jql([qa, dev], allowed), `cf[13931] in (currentUser()) AND cf[10600] in (currentUser())${ORDER}`);
    assert.equal(jql([meCondition('assignee'), qa], allowed), `assignee in (currentUser()) AND cf[13931] in (currentUser())${ORDER}`);
  });

  it('refuses the whole view when any condition is wrong: never a broader search without it', () => {
    assert.throws(() => jql([statusCondition(['10413']), { field: { id: 'labels' }, operator: 'in', values: [{ id: 'x' }] }]), /aren't valid/);
    assert.throws(() => jql([statusCondition(['10413']), meCondition('customfield_13931')], { userFieldIds: [] }), /no longer available/);
    assert.throws(() => jql([statusCondition(['1 OR project = X'])]), /aren't valid/);
  });

  it('keeps every value quoted in its own clause: an injection attempt in one condition stays a name', () => {
    const attempt = 'x") OR (project = SECRET';
    assert.equal(jql([statusCondition(['3']), option('customfield_11300', [attempt])]),
      `status in (3) AND cf[11300] in ("x\\") OR (project = SECRET")${ORDER}`);
  });

  it('describes every condition, joined with "and"', () => {
    assert.equal(describeView({ conditions: [statusCondition(['3']), meCondition('customfield_13931', 'QA Assignee')] }),
      'Status in Status 3 and QA Assignee in Me · Updated, descending');
  });
});

describe('Custom views - In and Not in', () => {
  const ORDER = ' ORDER BY updated DESC, key DESC';
  const jql = (conditions, context) => buildCustomViewJql({ conditions }, context);
  const status = (operator, ids) => ({ field: { id: 'status', name: 'Status' }, operator, values: ids.map((id) => ({ id, label: `S${id}` })) });
  const priority = (operator, ids) => ({ field: { id: 'priority', name: 'Priority' }, operator, values: ids.map((id) => ({ id, label: `P${id}` })) });
  const select = (operator, labels) => ({ field: { id: 'customfield_11300', name: 'Team' }, operator, values: labels.map((label) => ({ id: label, label })) });
  const user = (id, operator) => ({ field: { id, name: id }, operator, values: [{ currentUser: true, label: 'Me' }] });
  const QA = { userFieldIds: ['customfield_13931'] };

  it('In: one value or several, on every kind of field', () => {
    assert.equal(jql([status('in', ['10100'])]), `status in (10100)${ORDER}`);
    assert.equal(jql([status('in', ['10100', '10200'])]), `status in (10100, 10200)${ORDER}`);
    assert.equal(jql([priority('in', ['1', '2'])]), `priority in (1, 2)${ORDER}`);
    assert.equal(jql([select('in', ['Sega', 'Cisco UC Apps'])]), `cf[11300] in ("Sega", "Cisco UC Apps")${ORDER}`);
    assert.equal(jql([user('assignee', 'in')]), `assignee in (currentUser())${ORDER}`);
    assert.equal(jql([user('reporter', 'in')]), `reporter in (currentUser())${ORDER}`);
    assert.equal(jql([user('customfield_13931', 'in')], QA), `cf[13931] in (currentUser())${ORDER}`);
  });

  it('Not in: one value or several; Status alone needs nothing more, as it\'s never empty', () => {
    assert.equal(jql([status('notIn', ['10100'])]), `status not in (10100)${ORDER}`);
    assert.equal(jql([status('notIn', ['10100', '10200'])]), `status not in (10100, 10200)${ORDER}`);
  });

  it('Not in also finds issues where the field is empty, which Jira\'s NOT IN alone leaves out', () => {
    assert.equal(jql([priority('notIn', ['1', '2'])]), `(priority not in (1, 2) OR priority is EMPTY)${ORDER}`);
    assert.equal(jql([select('notIn', ['Sega'])]), `(cf[11300] not in ("Sega") OR cf[11300] is EMPTY)${ORDER}`);
    assert.equal(jql([user('assignee', 'notIn')]), `(assignee not in (currentUser()) OR assignee is EMPTY)${ORDER}`);
    assert.equal(jql([user('reporter', 'notIn')]), `(reporter not in (currentUser()) OR reporter is EMPTY)${ORDER}`);
    assert.equal(jql([user('customfield_13931', 'notIn')], QA), `(cf[13931] not in (currentUser()) OR cf[13931] is EMPTY)${ORDER}`);
  });

  it('keeps each Not in\'s OR inside its parentheses, so AND applies to the whole condition', () => {
    assert.equal(jql([status('notIn', ['10100', '10200']), priority('in', ['1', '2']), user('customfield_13931', 'in')], QA),
      `status not in (10100, 10200) AND priority in (1, 2) AND cf[13931] in (currentUser())${ORDER}`);
    assert.equal(jql([priority('notIn', ['3']), user('assignee', 'in')]),
      `(priority not in (3) OR priority is EMPTY) AND assignee in (currentUser())${ORDER}`);
  });

  it('adds no condition of its own: no assignee, reporter, or Additional Assignment Field unless chosen', () => {
    for (const conditions of [[status('notIn', ['10100', '10200'])], [status('in', ['10413'])], [priority('in', ['1'])], [select('notIn', ['Sega'])]]) {
      const query = jql(conditions, { userFieldIds: ['customfield_13931', 'customfield_10050'] });
      assert.doesNotMatch(query, /assignee|reporter|currentUser|cf\[13931\]|cf\[10050\]|worklog|statusCategory/, query);
    }
    // Only the user's own condition, exactly once.
    const mine = jql([status('notIn', ['10100', '10200']), user('assignee', 'in')]);
    assert.equal(mine.match(/currentUser\(\)/g).length, 1);
    assert.equal(mine, `status not in (10100, 10200) AND assignee in (currentUser())${ORDER}`);
  });

  it('turns saved Equals and Is one of views into the same In JQL, keeping values and order', () => {
    const old = normalizeView({ id: 'v', name: 'Old', conditions: [
      { field: { id: 'status', name: 'Status' }, operator: 'isOneOf', values: [{ id: '3', label: 'In Progress' }, { id: '4', label: 'In Review' }] },
      { field: { id: 'customfield_13931', name: 'QA' }, operator: 'equals', values: [{ currentUser: true, label: 'Me' }] }
    ], orderBy: { field: 'priority', direction: 'ASC' } });
    assert.deepEqual(old.conditions.map((c) => [c.operator, c.values.length]), [['in', 2], ['in', 1]]);
    assert.deepEqual(old.orderBy, { field: 'priority', direction: 'ASC' });
    assert.equal(buildCustomViewJql(old, QA), 'status in (3, 4) AND cf[13931] in (currentUser()) ORDER BY priority ASC, key ASC');
  });

  it('describes Not in and In', () => {
    assert.equal(describeView({ conditions: [status('notIn', ['1', '2']), user('assignee', 'in')] }), 'Status not in S1, S2 and assignee in Me · Updated, descending');
  });
});

describe('Custom views - tab order', () => {
  const views = ['a', 'b', 'c', 'd'].map((id) => view(id, `View ${id}`));
  const ids = (list) => list.map((v) => v.id);

  it('shows the views in the saved order, keeping each view as it is', () => {
    const ordered = orderViews(views, ['c', 'a', 'd', 'b']);
    assert.deepEqual(ids(ordered), ['c', 'a', 'd', 'b']);
    assert.ok(ordered.every((v) => views.includes(v)), 'the same view objects, unchanged');
  });

  it('shows the views as saved without an order', () => {
    assert.deepEqual(ids(orderViews(views, [])), ['a', 'b', 'c', 'd']);
    assert.deepEqual(ids(orderViews(views, undefined)), ['a', 'b', 'c', 'd']);
  });

  it('appends views the order doesn\'t name (created since), and skips IDs of views that are gone', () => {
    assert.deepEqual(ids(orderViews(views, ['d', 'gone', 'b'])), ['d', 'b', 'a', 'c']);
    assert.deepEqual(ids(orderViews([...views, view('e', 'New')], ['d', 'c', 'b', 'a'])), ['d', 'c', 'b', 'a', 'e']);
  });

  it('reads only valid IDs, each once, never Active', () => {
    assert.deepEqual(normalizeViewOrder(['a', 'a', 'all', 'bad id!', 7, null, 'b']), ['a', 'b']);
    assert.deepEqual(normalizeViewOrder({ ids: ['a'] }), []);
    assert.deepEqual(normalizeCustomViewOrderBySite({ s1: ['b', 'a'], s2: { version: 2, ids: [] }, '': ['x'] }), { s1: ['b', 'a'] });
    assert.deepEqual(normalizeCustomViewOrderBySite(null), {});
  });

  it('moves an ID left or right, keeping the others in order', () => {
    const order = ['a', 'b', 'c', 'd'];
    assert.deepEqual(reorderViewIds(order, 'c', 0), ['c', 'a', 'b', 'd']);
    assert.deepEqual(reorderViewIds(order, 'a', 3), ['b', 'c', 'd', 'a']);
    assert.deepEqual(reorderViewIds(order, 'b', 2), ['a', 'c', 'b', 'd']);
    assert.deepEqual(reorderViewIds(order, 'b', 99), ['a', 'c', 'd', 'b']);
    assert.deepEqual(reorderViewIds(order, 'b', -3), ['b', 'a', 'c', 'd']);
    assert.deepEqual(reorderViewIds(order, 'zz', 0), order);
    assert.deepEqual(order, ['a', 'b', 'c', 'd'], 'the list given is left as it was');
  });

  describe('where a dragged tab goes', () => {
    // Two rows: a, b, c on the first (y 0-20), d on the second (y 30-50).
    const tabs = [
      { id: 'a', left: 100, right: 160, top: 0, bottom: 20 },
      { id: 'b', left: 170, right: 230, top: 0, bottom: 20 },
      { id: 'c', left: 240, right: 300, top: 0, bottom: 20 },
      { id: 'd', left: 0, right: 60, top: 30, bottom: 50 }
    ];

    it('goes before or after the tab under the pointer, by which half it\'s in', () => {
      assert.deepEqual(dropPosition(tabs, { x: 180, y: 10 }), { id: 'b', after: false, index: 1 });
      assert.deepEqual(dropPosition(tabs, { x: 220, y: 10 }), { id: 'b', after: true, index: 2 });
    });

    it('goes beside the nearest tab on the pointer\'s row, between tabs or past the ends', () => {
      assert.deepEqual(dropPosition(tabs, { x: 236, y: 10 }), { id: 'c', after: false, index: 2 });
      assert.deepEqual(dropPosition(tabs, { x: 400, y: 10 }), { id: 'c', after: true, index: 3 });
      assert.deepEqual(dropPosition(tabs, { x: 20, y: 5 }), { id: 'a', after: false, index: 0 });
    });

    it('follows the tabs onto another row when they wrap', () => {
      assert.deepEqual(dropPosition(tabs, { x: 50, y: 40 }), { id: 'd', after: true, index: 4 });
      assert.deepEqual(dropPosition(tabs, { x: 250, y: 45 }), { id: 'd', after: true, index: 4 });
      assert.deepEqual(dropPosition(tabs, { x: 10, y: 26 }), { id: 'd', after: false, index: 3 }, 'nearer the second row');
    });

    it('has nowhere to go without tabs', () => {
      assert.equal(dropPosition([], { x: 0, y: 0 }), null);
    });
  });
});
