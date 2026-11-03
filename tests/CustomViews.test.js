import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_VIEWS_VERSION,
  MAX_CUSTOM_VIEWS,
  MAX_VIEW_NAME_LENGTH,
  ALL_VIEW_ID,
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
  requiredViewFields,
  toViewFieldValues,
  matchesCondition,
  matchesView,
  valueOptions,
  isViewAvailable,
  usesCustomOptionField,
  parseNamedValues,
  mergeValueOptions
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
      { id: 'e', name: 'All', conditions: [statusCondition(['1'])] },
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

  it('reserves All, in any letter case', () => {
    for (const name of ['All', 'all', ' ALL ']) assert.match(validateViewDraft(draft({ name }), { views: [] }).errors.name, /"All"/);
    assert.match(nameProblem('aLl'), /"All"/);
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

describe('Custom views - fields and matching', () => {
  const me = { accountId: 'me' };
  const someone = { accountId: 'other', displayName: 'Someone Else', emailAddress: 'someone@example.com' };
  const isCurrentUser = (person) => person.accountId === 'me';
  const fields = {
    status: { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    priority: { id: '2', name: 'High', iconUrl: 'https://x' },
    assignee: someone,
    reporter: me,
    customfield_10050: me,
    customfield_10100: { self: 'https://x', id: '10200', value: 'Platform' },
    customfield_10101: { id: '10300', value: 'Yes' },
    customfield_10102: [{ id: '1', value: 'A' }, { id: '2', value: 'B' }],
    customfield_10103: { id: '1', value: 'Parent', child: { id: '2', value: 'Child' } }
  };
  const ids = ['status', 'priority', 'assignee', 'reporter', 'customfield_10050', 'customfield_10100', 'customfield_10101', 'customfield_10102', 'customfield_10104'];
  const values = toViewFieldValues(fields, ids, { userFieldIds: ['customfield_10050'], isCurrentUser });

  it('reduces statuses, priorities, and single options to their ID and name', () => {
    assert.deepEqual(values.status, { id: '3', label: 'In Progress' });
    assert.deepEqual(values.priority, { id: '2', label: 'High' });
    assert.deepEqual(values.customfield_10100, { id: '10200', label: 'Platform' });
    assert.deepEqual(values.customfield_10101, { id: '10300', label: 'Yes' });
  });

  it('reduces people to whether they\'re the current user, keeping nothing else about them', () => {
    assert.deepEqual(values.assignee, { isCurrentUser: false });
    assert.deepEqual(values.reporter, { isCurrentUser: true });
    assert.deepEqual(values.customfield_10050, { isCurrentUser: true });
    const json = JSON.stringify(values);
    for (const secret of ['other', 'Someone Else', 'someone@example.com']) assert.ok(!json.includes(secret), secret);
  });

  it('gives no value for multiple options, a missing field, or an empty one', () => {
    assert.equal(values.customfield_10102, null);
    assert.equal(values.customfield_10104, null);
    assert.equal(toViewFieldValues({ assignee: null }, ['assignee'], { isCurrentUser }).assignee, null);
    assert.equal(toViewFieldValues({}, ['priority'], { isCurrentUser }).priority, null);
  });

  it('never reads a person as an option: a user custom field that isn\'t an assignment field gives no value', () => {
    assert.equal(toViewFieldValues({ customfield_10050: someone }, ['customfield_10050'], { isCurrentUser }).customfield_10050, null);
  });

  it('ignores fields views don\'t support', () => {
    assert.deepEqual(toViewFieldValues({ summary: 'x' }, ['summary', 'worklog'], { isCurrentUser }), {});
  });

  const issueWith = (viewFields) => ({ issueKey: 'KAN-1', viewFields });

  it('matches Equals and Is one of by ID', () => {
    const issue = issueWith({ status: { id: '3', label: 'In Progress' } });
    assert.equal(matchesView(issue, view('a', 'A', statusCondition(['3']))), true);
    assert.equal(matchesView(issue, view('a', 'A', statusCondition(['4']))), false);
    assert.equal(matchesView(issue, view('a', 'A', statusCondition(['4', '3']))), true);
    assert.equal(matchesView(issue, view('a', 'A', statusCondition(['4', '5']))), false);
  });

  it('matches by ID even when the name changed in Jira', () => {
    assert.equal(matchesCondition(issueWith({ status: { id: '3', label: 'Doing' } }), statusCondition(['3'])), true);
  });

  it('matches priority and custom single-select and radio-button fields', () => {
    const issue = issueWith({ priority: { id: '2', label: 'High' }, customfield_10100: { id: '10200', label: 'Platform' }, customfield_10101: { id: '10300', label: 'Yes' } });
    const condition = (id, valueId) => ({ field: { id, name: id }, operator: 'equals', values: [{ id: valueId, label: valueId }] });
    assert.equal(matchesCondition(issue, condition('priority', '2')), true);
    assert.equal(matchesCondition(issue, condition('customfield_10100', '10200')), true);
    assert.equal(matchesCondition(issue, condition('customfield_10101', '10300')), true);
    assert.equal(matchesCondition(issue, condition('customfield_10101', '10301')), false);
  });

  it('matches Assignee, Reporter, and an Additional Assignment Field equal to Me', () => {
    const issue = issueWith({ assignee: { isCurrentUser: false }, reporter: { isCurrentUser: true }, customfield_10050: { isCurrentUser: true } });
    assert.equal(matchesCondition(issue, meCondition('assignee')), false);
    assert.equal(matchesCondition(issue, meCondition('reporter')), true);
    assert.equal(matchesCondition(issue, meCondition('customfield_10050')), true);
  });

  it('never matches an issue without a value for the field, or loaded without it', () => {
    assert.equal(matchesCondition(issueWith({ status: null }), statusCondition(['3'])), false);
    assert.equal(matchesCondition(issueWith({}), statusCondition(['3'])), false);
    assert.equal(matchesCondition({ issueKey: 'KAN-1' }, meCondition('assignee')), false);
    assert.equal(matchesView({ issueKey: 'KAN-1' }, { conditions: [] }), false);
  });

  it('offers the values the loaded issues have, once each, by name; Me alone for user fields', () => {
    const issues = [
      issueWith({ status: { id: '3', label: 'In Progress' } }),
      issueWith({ status: { id: '4', label: 'In Review' } }),
      issueWith({ status: { id: '3', label: 'In Progress' } }),
      issueWith({ status: null }),
      { issueKey: 'KAN-9' }
    ];
    assert.deepEqual(valueOptions(issues, STATUS), [{ id: '3', label: 'In Progress' }, { id: '4', label: 'In Review' }]);
    assert.deepEqual(valueOptions(issues, PRIORITY), []);
    assert.deepEqual(valueOptions(issues, ASSIGNEE), [{ currentUser: true, label: 'Me' }]);
  });

  it('lists the fields the views compare, each once, in order', () => {
    assert.deepEqual(requiredViewFields([]), []);
    assert.deepEqual(requiredViewFields([view('a', 'A', statusCondition(['1'])), view('b', 'B', meCondition('reporter')), view('c', 'C', statusCondition(['2']))]),
      ['status', 'reporter']);
  });

  it('offers the standard fields: Status, Priority, Assignee, Reporter', () => {
    assert.deepEqual(SYSTEM_FIELDS.map((f) => [f.id, f.kind]), [['status', 'option'], ['priority', 'option'], ['assignee', 'user'], ['reporter', 'user']]);
    assert.equal(ALL_VIEW_ID, 'all');
    assert.deepEqual(OPERATORS, { EQUALS: 'equals', IS_ONE_OF: 'isOneOf' });
  });
});

describe('Custom views - Status values from the loaded issues', () => {
  const isCurrentUser = () => false;
  /** An issue as getActiveIssues() gives it with `viewFields: ['status']`, from Jira's raw status. */
  const loaded = (key, rawStatus) => ({ issueKey: key, viewFields: toViewFieldValues({ status: rawStatus }, ['status'], { isCurrentUser }) });
  const status = (id, name, categoryKey = 'indeterminate') => ({ id, name, statusCategory: { key: categoryKey } });
  const labels = (issues) => valueOptions(issues, STATUS).map((option) => option.label);

  it('offers the status of every loaded issue, whatever its category', () => {
    const issues = [
      loaded('P-1', status('10100', 'Demo')),
      loaded('P-2', status('3', 'In Progress')),
      loaded('P-3', status('10101', 'Verify')),
      // To Do category: listed through a recent worklog (Show recently logged), and offered all the same.
      loaded('P-4', status('10102', 'Selected for Development', 'new')),
      loaded('P-5', status('10002', 'Done', 'done'))
    ];
    assert.deepEqual(valueOptions(issues, STATUS), [
      { id: '10100', label: 'Demo' }, { id: '10002', label: 'Done' }, { id: '3', label: 'In Progress' },
      { id: '10102', label: 'Selected for Development' }, { id: '10101', label: 'Verify' }
    ]);
  });

  it('lists each status once, by its stable ID, with its name', () => {
    const issues = [loaded('P-1', status('3', 'In Progress')), loaded('P-2', status('3', 'In Progress')), loaded('P-3', status(3, 'In Progress'))];
    assert.deepEqual(valueOptions(issues, STATUS), [{ id: '3', label: 'In Progress' }]);
  });

  it('tells apart statuses that share a name but not an ID (two workflows)', () => {
    const issues = [loaded('A-1', status('3', 'In Progress')), loaded('B-1', status('10500', 'In Progress'))];
    // Same name: ordered by ID.
    assert.deepEqual(valueOptions(issues, STATUS), [{ id: '10500', label: 'In Progress' }, { id: '3', label: 'In Progress' }]);
  });

  it('hard-codes no status: any name Jira gives is offered', () => {
    const names = ['Ready for QA', 'Waiting for Customer', 'En cours', 'Bloqué', '進行中'];
    const issues = names.map((name, index) => loaded(`P-${index + 1}`, status(String(20000 + index), name)));
    assert.deepEqual(labels(issues).sort(), [...names].sort());
  });

  it('skips malformed statuses safely, keeping the others', () => {
    const issues = [
      loaded('P-1', { name: 'No ID' }),
      loaded('P-2', { id: '7' }),
      loaded('P-3', { id: '8', name: '   ' }),
      loaded('P-4', null),
      loaded('P-5', [status('9', 'In a list')]),
      loaded('P-6', 'In Progress'),
      { issueKey: 'P-7' },
      { issueKey: 'P-8', viewFields: { status: { label: 'No ID' } } },
      loaded('P-9', status('3', 'In Progress'))
    ];
    assert.deepEqual(valueOptions(issues, STATUS), [{ id: '3', label: 'In Progress' }]);
  });

  it('follows the issues: a new load offers its statuses', () => {
    const before = [loaded('P-1', status('3', 'In Progress'))];
    const after = [...before, loaded('P-2', status('10102', 'Selected for Development', 'new'))];
    assert.deepEqual(labels(before), ['In Progress']);
    assert.deepEqual(labels(after), ['In Progress', 'Selected for Development']);
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

  it('puts the listed issues\' values first, then Jira\'s others, each ID once', () => {
    const listed = [{ id: '11817', label: 'Demo' }, { id: '3', label: 'In Progress' }];
    const fromJira = [{ id: '12912', label: 'Backlog' }, { id: '11817', label: 'Demo' }, { id: '10413', label: 'Selected for Development' }];
    assert.deepEqual(mergeValueOptions(listed, fromJira), [
      { id: '11817', label: 'Demo', listed: true },
      { id: '3', label: 'In Progress', listed: true },
      { id: '12912', label: 'Backlog', listed: false },
      { id: '10413', label: 'Selected for Development', listed: false }
    ]);
    assert.deepEqual(mergeValueOptions(listed), listed.map((value) => ({ ...value, listed: true })));
    assert.deepEqual(mergeValueOptions([], fromJira).map((value) => value.listed), [false, false, false]);
  });
});
