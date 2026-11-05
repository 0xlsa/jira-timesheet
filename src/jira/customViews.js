/**
 * Custom views of Issues: up to five (MAX_CUSTOM_VIEWS) named views per Jira site, as tabs beside Active (the
 * built-in view: My Work's existing search), each with one or more conditions (a field, an operator,
 * and values), all of which an issue must meet (AND). A view is its own Jira search:
 * buildCustomViewJql() turns its conditions into JQL, and the
 * page runs it apart from Active's search (src/jira/customViewSearch.js), so a view finds the issues
 * the user can browse in Jira that match, whether Active lists them or not. Jira's permissions
 * decide what any search returns. A view lists the first CUSTOM_VIEW_RESULT_LIMIT issues in its own
 * order (one of ORDER_BY_FIELDS, ascending or descending; Updated, newest first, by default), which
 * Jira sorts before it limits them, from one request: Jira is never asked for another page.
 *
 * Fields:
 * - Status and Priority: Jira's numeric ID in the JQL (`status in (10001, 3)`), chosen from every
 *   status and priority Jira lists (GET /status, GET /priority).
 * - Custom single-select and radio-button fields: the option's name, quoted and escaped
 *   (`cf[10050] in ("Platform")`). Jira Data Center rejects option IDs in JQL, and only administrators
 *   can list a field's options with their IDs, so the names come from Jira's JQL suggestions for the
 *   field, and the stored `id` is the name too. A renamed option no longer matches until the view is
 *   edited.
 * - Assignee, Reporter, and custom single-user fields (user pickers, such as a QA Assignee: the
 *   site's Additional Assignment Fields and every other one GET /field lists, by the same rule as
 *   those, parseUserPickerFields()): only Me, as `currentUser()`, the field by its number
 *   (`cf[10050] in (currentUser())`). No other person can be chosen, stored, or shown. Multi-user
 *   fields are left out: "= Me" there would mean "among them", not "assigned to me".
 *
 * Operators: In (one or more values) and Not in (one or more values), for every field, Me included.
 * Not in also finds issues where the field is empty (`(cf[13931] not in (currentUser()) OR cf[13931]
 * is EMPTY)`): Jira's NOT IN alone leaves them out, which would restrict the view to issues that have
 * a value. Status is never empty, so it's left as `status not in (…)`. A view adds no condition of its
 * own: no assignee, reporter, or Additional Assignment Field unless the user chose it as a condition.
 * Conditions saved with the operators views had before (Equals, Is one of) are read as In, their
 * values kept.
 *
 * Stored in storage.local as `customViewsBySite`, per Jira site (`${deploymentType}|${baseUrl}`,
 * as siteId() makes it): { [site]: { version: 1, views: [{ id, name, conditions: [{ field: { id,
 * name }, operator, values: [{ id, label }] | [{ currentUser: true, label: 'Me' }] }], orderBy: { field,
 * direction } }] } }. At least one condition, at most one per field. Views saved with a single
 * condition, before views could have several, are read as they are. A view saved without `orderBy`, or with one that isn't valid, is read with DEFAULT_ORDER_BY. A
 * site's entry with another version is from another version of the extension: it's neither used nor
 * overwritten.
 * Search results are never stored.
 *
 * No DOM and no network access.
 */

export const CUSTOM_VIEWS_VERSION = 1;
export const MAX_CUSTOM_VIEWS = 5;
export const MAX_VIEW_NAME_LENGTH = 30;
// The issues a view lists: Jira's first ones, in one request.
export const CUSTOM_VIEW_RESULT_LIMIT = 20;

// The fields a view can be ordered by: Jira's own sortable fields, by their JQL names, all checked
// with ORDER BY on Jira Cloud and Data Center. Status sorts by the workflow's order of statuses,
// and Priority by the site's order of priorities, as Jira's issue navigator does.
export const ORDER_BY_FIELDS = Object.freeze([
  Object.freeze({ id: 'updated', name: 'Updated' }),
  Object.freeze({ id: 'created', name: 'Created' }),
  Object.freeze({ id: 'priority', name: 'Priority' }),
  Object.freeze({ id: 'duedate', name: 'Due date' }),
  Object.freeze({ id: 'status', name: 'Status' }),
  Object.freeze({ id: 'key', name: 'Issue key' })
]);
export const ORDER_DIRECTIONS = Object.freeze({ ASC: 'ASC', DESC: 'DESC' });
export const ORDER_DIRECTION_LABELS = Object.freeze({ ASC: 'Ascending', DESC: 'Descending' });
// Most recently updated first.
export const DEFAULT_ORDER_BY = Object.freeze({ field: 'updated', direction: 'DESC' });

// The longest JQL a view may have. Its search is a GET request, and Jira refuses request lines much
// over 8 KB (Data Center's Tomcat by default, Cloud's gateways likewise): URL encoding can make JQL
// up to three times longer, so this keeps the request well within that. Conditions themselves have
// no limit but this, and one per field.
export const MAX_VIEW_JQL_LENGTH = 2000;

// The built-in view, Active: My Work's existing search. Its name, and All, are no custom view's.
export const ALL_VIEW_ID = 'all';
export const ALL_VIEW_NAME = 'Active';
export const RESERVED_VIEW_NAMES = Object.freeze([ALL_VIEW_NAME, 'All']);

export const OPERATORS = Object.freeze({ IN: 'in', NOT_IN: 'notIn' });
export const OPERATOR_LABELS = Object.freeze({ in: 'In', notIn: 'Not in' });
// The operators views had before In and Not in, and what they're read as.
export const LEGACY_OPERATORS = Object.freeze({ equals: OPERATORS.IN, isOneOf: OPERATORS.IN });

// The one value a user field can be compared with.
export const ME_VALUE = Object.freeze({ currentUser: true, label: 'Me' });

// Jira's custom field types that hold a single option ({ id, value }), as GET /field describes
// them (`schema.custom`). Multi-select, cascading select, and every other type are left out.
export const SINGLE_SELECT_TYPES = Object.freeze({
  'com.atlassian.jira.plugin.system.customfieldtypes:select': 'select',
  'com.atlassian.jira.plugin.system.customfieldtypes:radiobuttons': 'radio'
});

// The standard fields a view can use: `option` fields hold one of Jira's values, `user` fields a person.
export const SYSTEM_FIELDS = Object.freeze([
  Object.freeze({ id: 'status', name: 'Status', kind: 'option' }),
  Object.freeze({ id: 'priority', name: 'Priority', kind: 'option' }),
  Object.freeze({ id: 'assignee', name: 'Assignee', kind: 'user' }),
  Object.freeze({ id: 'reporter', name: 'Reporter', kind: 'user' })
]);

const CUSTOM_FIELD_ID = /^customfield_(\d+)$/;
const VIEW_FIELD_ID = /^(status|priority|assignee|reporter|customfield_\d+)$/;
const OPTION_SYSTEM_FIELDS = new Set(['status', 'priority']);
const USER_SYSTEM_FIELDS = new Set(['assignee', 'reporter']);
const VIEW_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Jira's status and priority IDs, as they go into the JQL.
const NUMERIC_ID = /^\d{1,18}$/;
// Characters a JQL string can't carry as they are.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const sameName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/** The number in `customfield_10050`. */
function fieldNumber(id) {
  return Number(CUSTOM_FIELD_ID.exec(id)?.[1] ?? 0);
}

/**
 * Picks the custom single-select and radio-button fields out of a `GET /field` response: custom
 * fields of those types holding one option, which search results can return (navigable).
 *
 * @param {unknown} data
 * @returns {Array<{ id: string, name: string, kind: 'option', type: 'select' | 'radio' }>} Sorted by name, then ID
 * @throws {Error} When the response isn't a list of fields
 */
export function parseSingleSelectFields(data) {
  if (!Array.isArray(data)) throw new Error('Jira sent an unexpected list of fields.');
  const byId = new Map();
  for (const field of data) {
    const id = typeof field?.id === 'string' ? field.id : '';
    const name = text(field?.name);
    if (!CUSTOM_FIELD_ID.test(id) || !name || byId.has(id)) continue;
    if (field.custom === false || field.navigable === false) continue;
    const type = SINGLE_SELECT_TYPES[field.schema?.custom];
    if (!type || field.schema?.type !== 'option') continue;
    byId.set(id, { id, name, kind: 'option', type });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
    fieldNumber(a.id) - fieldNumber(b.id));
}

/**
 * Whether a condition compares a person (with Me) or one of Jira's values.
 * @param {{ values: Array<object> }} condition
 * @returns {'user' | 'option'}
 */
export function conditionKind(condition) {
  return condition.values[0]?.currentUser === true ? 'user' : 'option';
}

/**
 * The operators a kind of field can use: In and Not in, for user fields too (their one value is Me).
 * @param {'user' | 'option'} kind
 * @returns {string[]}
 */
export function operatorsFor(kind) {
  return [OPERATORS.IN, OPERATORS.NOT_IN];
}

/**
 * Checks a stored condition; null when it's malformed. The field must be one a view can use, and
 * its values must suit it: Me alone for a user field, one or more values otherwise. An operator
 * views had before (Equals, Is one of) is read as In.
 *
 * @param {unknown} raw
 * @returns {{ field: { id: string, name: string }, operator: string, values: Array<object> } | null}
 */
export function normalizeCondition(raw) {
  const id = typeof raw?.field?.id === 'string' ? raw.field.id : '';
  if (!VIEW_FIELD_ID.test(id)) return null;
  const field = { id, name: text(raw.field.name) || id };
  const operator = Object.hasOwn(LEGACY_OPERATORS, raw.operator) ? LEGACY_OPERATORS[raw.operator] : raw.operator;
  if (!Object.values(OPERATORS).includes(operator) || !Array.isArray(raw.values) || raw.values.length === 0) return null;

  if (raw.values.some((value) => value?.currentUser === true)) {
    if (OPTION_SYSTEM_FIELDS.has(id) || raw.values.length !== 1) return null;
    return { field, operator, values: [{ ...ME_VALUE }] };
  }
  if (USER_SYSTEM_FIELDS.has(id)) return null;

  // Statuses and priorities go into the JQL by their numeric ID; custom options by their name (the label).
  const values = [];
  for (const value of raw.values) {
    const valueId = typeof value?.id === 'string' || typeof value?.id === 'number' ? String(value.id) : '';
    if (!valueId) return null;
    const label = text(value.label) || valueId;
    if (OPTION_SYSTEM_FIELDS.has(id) ? !NUMERIC_ID.test(valueId) : CONTROL_CHARACTERS.test(label)) return null;
    if (values.some((v) => v.id === valueId)) continue;
    values.push({ id: valueId, label });
  }
  return { field, operator, values };
}

/**
 * Checks a view's conditions: one or more, each valid, each on a field no other uses. Null otherwise.
 * @param {unknown} raw
 * @returns {Array<object> | null}
 */
export function normalizeConditions(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const conditions = raw.map(normalizeCondition);
  if (conditions.some((condition) => !condition)) return null;
  const ids = conditions.map((condition) => condition.field.id);
  return new Set(ids).size === ids.length ? conditions : null;
}

/**
 * Checks a view's order: one of ORDER_BY_FIELDS, ascending or descending; null when it's anything else.
 * @param {unknown} raw
 * @returns {{ field: string, direction: 'ASC' | 'DESC' } | null}
 */
export function normalizeOrderBy(raw) {
  const field = ORDER_BY_FIELDS.find((item) => item.id === raw?.field)?.id;
  const direction = Object.values(ORDER_DIRECTIONS).find((item) => item === raw?.direction);
  return field && direction ? { field, direction } : null;
}

/**
 * Checks a view's name: required once trimmed, at most MAX_VIEW_NAME_LENGTH characters, and none
 * of RESERVED_VIEW_NAMES (Active, the built-in view, and All), in any letter case.
 * @param {unknown} name
 * @returns {string} What's wrong, or '' when it's valid
 */
export function nameProblem(name) {
  const trimmed = text(name);
  if (!trimmed) return 'Enter a name for the view.';
  if (trimmed.length > MAX_VIEW_NAME_LENGTH) return `Use at most ${MAX_VIEW_NAME_LENGTH} characters.`;
  const reserved = RESERVED_VIEW_NAMES.find((reservedName) => sameName(trimmed, reservedName));
  if (reserved) return `"${reserved}" can't be a custom view's name. Choose another name.`;
  return '';
}

/**
 * Checks a stored view; null when it's malformed: a valid ID and name, and one or more valid
 * conditions, each on a field of its own. A view with a condition that isn't valid is left out as a
 * whole, never searched without it (which would find more than it should). Its order is read as
 * DEFAULT_ORDER_BY when it has none, or one that isn't valid.
 * @param {unknown} raw
 * @returns {{ id: string, name: string, conditions: Array<object>, orderBy: { field: string, direction: string } } | null}
 */
export function normalizeView(raw) {
  const id = typeof raw?.id === 'string' && VIEW_ID.test(raw.id) ? raw.id : '';
  if (!id || id === ALL_VIEW_ID || nameProblem(raw.name)) return null;
  const conditions = normalizeConditions(raw.conditions);
  return conditions ? { id, name: text(raw.name), conditions, orderBy: normalizeOrderBy(raw.orderBy) ?? { ...DEFAULT_ORDER_BY } } : null;
}

/**
 * Checks one site's stored views. An entry with another version is from another version of the
 * extension: it's marked `unsupported`, with no views, so it's neither used nor overwritten.
 * Otherwise malformed views are left out, as are repeated IDs and names, and any past the
 * MAX_CUSTOM_VIEWS.
 *
 * @param {unknown} raw
 * @returns {{ version: number, views: Array<object>, unsupported?: true }}
 */
export function normalizeSiteViews(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: CUSTOM_VIEWS_VERSION, views: [] };
  if (raw.version !== CUSTOM_VIEWS_VERSION) {
    return 'version' in raw ? { version: CUSTOM_VIEWS_VERSION, views: [], unsupported: true } : { version: CUSTOM_VIEWS_VERSION, views: [] };
  }
  const views = [];
  for (const item of Array.isArray(raw.views) ? raw.views : []) {
    const view = normalizeView(item);
    if (!view || views.some((v) => v.id === view.id || sameName(v.name, view.name))) continue;
    views.push(view);
    if (views.length === MAX_CUSTOM_VIEWS) break;
  }
  return { version: CUSTOM_VIEWS_VERSION, views };
}

/**
 * Checks one site's stored tab order: the custom views' IDs, in the order their tabs show (Active,
 * the built-in view, is always first and never in it). Anything else, such as an entry saved by
 * another version, reads as no order.
 * @param {unknown} raw
 * @returns {string[]} Valid IDs, each once
 */
export function normalizeViewOrder(raw) {
  if (!Array.isArray(raw)) return [];
  const ids = [];
  for (const id of raw) {
    if (typeof id === 'string' && VIEW_ID.test(id) && id !== ALL_VIEW_ID && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Checks every site's stored tab order (`customViewOrderBySite`): `{ [site]: normalizeViewOrder() }`.
 * @param {unknown} raw
 * @returns {Record<string, string[]>}
 */
export function normalizeCustomViewOrderBySite(raw) {
  const bySite = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bySite;
  for (const [site, order] of Object.entries(raw)) {
    if (site && Array.isArray(order)) bySite[site] = normalizeViewOrder(order);
  }
  return bySite;
}

/**
 * The views in their tabs' order: those in `order` first, as it has them, then any it doesn't
 * name (a view created since, or every view when there's no order yet), as they're saved. IDs of
 * views that are gone are skipped. The views themselves are returned as they are.
 * @param {Array<{ id: string }>} views
 * @param {string[]} order
 * @returns {Array<object>}
 */
export function orderViews(views, order) {
  const byId = new Map(views.map((view) => [view.id, view]));
  const ordered = normalizeViewOrder(order).filter((id) => byId.has(id)).map((id) => byId.get(id));
  return [...ordered, ...views.filter((view) => !ordered.includes(view))];
}

/**
 * Moves a view's ID to another position among the custom views' IDs (0 is just after Active);
 * the others keep their order. A position past either end is the end.
 * @param {string[]} ids
 * @param {string} id
 * @param {number} toIndex
 * @returns {string[]} A new list; the same order when the ID isn't in it
 */
export function reorderViewIds(ids, id, toIndex) {
  if (!ids.includes(id)) return [...ids];
  const others = ids.filter((other) => other !== id);
  const index = Math.max(0, Math.min(others.length, Math.trunc(toIndex) || 0));
  return [...others.slice(0, index), id, ...others.slice(index)];
}

/**
 * Where a dragged tab would go, from where the pointer is: the tab under it (or, between tabs or
 * rows, the nearest on the pointer's row), before or after it by which half the pointer is in.
 * Works when the tabs wrap onto several rows. Only the custom views' tabs are given: nothing can
 * go before Active.
 * @param {Array<{ id: string, left: number, right: number, top: number, bottom: number }>} tabs - The
 *   custom views' tabs, in order, with their boxes on the page
 * @param {{ x: number, y: number }} point
 * @returns {{ id: string, after: boolean, index: number } | null} The tab the drop is beside, which
 *   side, and the position it means among the custom views (as the list is before the move); null
 *   without tabs
 */
export function dropPosition(tabs, { x, y }) {
  if (tabs.length === 0) return null;
  const rowOf = (tab) => (y >= tab.top && y <= tab.bottom ? 0 : Math.min(Math.abs(y - tab.top), Math.abs(y - tab.bottom)));
  const nearestRow = Math.min(...tabs.map(rowOf));
  const onRow = tabs.filter((tab) => rowOf(tab) === nearestRow);
  const distance = (tab) => (x < tab.left ? tab.left - x : x > tab.right ? x - tab.right : 0);
  const target = onRow.reduce((best, tab) => (distance(tab) < distance(best) ? tab : best));
  const after = x > (target.left + target.right) / 2;
  const index = tabs.indexOf(target) + (after ? 1 : 0);
  return { id: target.id, after, index };
}

/**
 * Checks every site's stored views: `{ [site]: normalizeSiteViews() }`.
 * @param {unknown} raw
 * @returns {Record<string, { version: number, views: Array<object>, unsupported?: true }>}
 */
export function normalizeCustomViewsBySite(raw) {
  const bySite = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bySite;
  for (const [site, entry] of Object.entries(raw)) {
    if (site) bySite[site] = normalizeSiteViews(entry);
  }
  return bySite;
}

/**
 * Checks a view being created or edited, as the editor has it, against the site's other views:
 * its name, each of its conditions (a field, an operator the field allows, and the right values),
 * at least one condition and at most one per field, its order, and the length of its JQL.
 *
 * @param {{ name?: string, conditions?: Array<{ field?: { id: string, name: string, kind: 'user' | 'option' } | null,
 *   operator?: string, values?: Array<object> }>, orderBy?: { field: string, direction: string } }} draft
 * @param {object} context
 * @param {Array<{ id: string, name: string }>} context.views - The site's saved views
 * @param {string} [context.editingId] - The view being edited; none when creating one
 * @returns {{ errors: { form?: string, name?: string, conditions?: string, orderBy?: string,
 *   byCondition?: Array<{ field?: string, operator?: string, values?: string } | null> },
 *   view: { name: string, conditions: Array<object>, orderBy: object } | null }} `view` (without its ID)
 *   when there are no errors; `byCondition` has each condition's, in order (null for one without)
 */
export function validateViewDraft(draft, { views, editingId }) {
  const errors = {};
  const others = views.filter((view) => view.id !== editingId);
  if (!editingId && others.length >= MAX_CUSTOM_VIEWS) errors.form = `You can have at most ${MAX_CUSTOM_VIEWS} custom views.`;
  if (editingId && !views.some((view) => view.id === editingId)) errors.form = 'This view was deleted, maybe in another tab.';

  const name = text(draft.name);
  const problem = nameProblem(name);
  if (problem) errors.name = problem;
  else if (others.some((view) => sameName(view.name, name))) errors.name = 'Another view already has this name.';

  const drafts = Array.isArray(draft.conditions) ? draft.conditions : [];
  if (drafts.length === 0) errors.conditions = 'Add at least one condition.';
  const usedFields = new Set();
  const byCondition = drafts.map((condition) => {
    const found = conditionProblem(condition ?? {});
    const fieldId = condition?.field?.id;
    if (!found.field && usedFields.has(fieldId)) found.field = 'Another condition already uses this field.';
    if (fieldId) usedFields.add(fieldId);
    return Object.keys(found).length > 0 ? found : null;
  });
  if (byCondition.some(Boolean)) errors.byCondition = byCondition;

  const orderBy = normalizeOrderBy(draft.orderBy);
  if (!orderBy) errors.orderBy = 'Choose an order and a direction.';

  if (Object.keys(errors).length > 0) return { errors, view: null };
  const conditions = normalizeConditions(drafts.map((condition) => ({
    field: { id: condition.field.id, name: condition.field.name }, operator: condition.operator, values: condition.values
  })));
  if (!conditions) return { errors: { conditions: 'Choose the conditions\' values again.' }, view: null };
  const userFieldIds = conditions.filter((condition) => conditionKind(condition) === 'user').map((condition) => condition.field.id);
  if (buildCustomViewJql({ conditions, orderBy }, { userFieldIds }).length > MAX_VIEW_JQL_LENGTH) {
    return { errors: { conditions: 'This view\'s search is too long for Jira. Remove a condition, or some values.' }, view: null };
  }
  return { errors, view: { name, conditions, orderBy } };
}

/** What's wrong with one condition as the editor has it: its field, operator, or values. */
function conditionProblem({ field, operator, values: rawValues }) {
  const values = Array.isArray(rawValues) ? rawValues : [];
  if (!field || !VIEW_FIELD_ID.test(field.id ?? '')) return { field: 'Choose a field.' };
  if (!operatorsFor(field.kind).includes(operator)) return { operator: 'Choose an operator.' };
  if (field.kind === 'user') return values.length !== 1 || values[0]?.currentUser !== true ? { values: 'Choose Me.' } : {};
  if (values.length === 0) return { values: 'Choose at least one value.' };
  return {};
}

/**
 * Quotes a name as a JQL string: in double quotes, with backslashes and double quotes escaped, so
 * no name can end the string or add to the query.
 * @param {string} value - Without control characters (normalizeCondition() refuses them)
 * @returns {string}
 */
export function jqlString(value) {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) throw new Error('This value can\'t be searched.');
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

/**
 * Builds the JQL of a view's own Jira search, from its conditions and order alone: one clause per
 * condition, joined with AND, from allow-listed fields and operators, numeric IDs for statuses and
 * priorities, quoted names for custom options, and `currentUser()` for Me. Nothing typed by the
 * user goes into it unquoted. Ordered by the view's
 * field and direction (DEFAULT_ORDER_BY without a valid one), then by key in the same direction, so
 * issues with the same value come back in the same order from one search to the next.
 *
 * @param {{ conditions: Array<object> }} view - A stored view (normalizeView())
 * @param {object} context
 * @param {string[]} context.userFieldIds - The custom user fields Me can be compared on (the site's
 *   single-user fields, Additional Assignment Fields included): any other is refused
 * @returns {string} E.g. `reporter in (currentUser()) ORDER BY updated DESC, key DESC`, or `status not in
 *   (3, 10413) AND priority in (1, 2) AND assignee in (currentUser()) ORDER BY priority ASC, key ASC`
 * @throws {Error} Without conditions, for one that isn't valid or repeats a field, or for a field
 *   views can't search on
 */
export function buildCustomViewJql(view, { userFieldIds = [] } = {}) {
  if (!Array.isArray(view?.conditions) || view.conditions.length === 0) throw new Error('A view has at least one condition.');
  const conditions = normalizeConditions(view.conditions);
  if (!conditions) throw new Error('This view\'s conditions aren\'t valid.');
  const clauses = conditions.map((condition) => conditionClause(condition, userFieldIds));
  const { field, direction } = normalizeOrderBy(view.orderBy) ?? DEFAULT_ORDER_BY;
  return `${clauses.join(' AND ')} ORDER BY ${field} ${direction}${field === 'key' ? '' : `, key ${direction}`}`;
}

/**
 * One condition's JQL clause (normalizeCondition() checked it): `status in (3, 4)`, `cf[10050] in
 * (currentUser())`, `status not in (3)`, `(priority not in (2) OR priority is EMPTY)`.
 */
function conditionClause(condition, userFieldIds) {
  const { id } = condition.field;
  const custom = CUSTOM_FIELD_ID.exec(id);
  // System fields by name, custom fields by number: cf[10050].
  const clauseField = custom ? `cf[${custom[1]}]` : id;

  let values;
  if (conditionKind(condition) === 'user') {
    if (custom && !userFieldIds.includes(id)) throw new Error('This view\'s field is no longer available in Jira.');
    values = ['currentUser()'];
  } else if (OPTION_SYSTEM_FIELDS.has(id)) {
    values = condition.values.map((value) => value.id);
  } else {
    values = condition.values.map((value) => jqlString(value.label));
  }
  const list = `(${values.join(', ')})`;
  if (condition.operator === OPERATORS.IN) return `${clauseField} in ${list}`;
  // Jira's NOT IN leaves out issues where the field is empty; Not in keeps them (Status is never empty).
  return id === 'status' ? `${clauseField} not in ${list}` : `(${clauseField} not in ${list} OR ${clauseField} is EMPTY)`;
}

/**
 * Reads Jira's list of statuses or priorities (`GET /status`, `GET /priority`, or the `values` of
 * `GET /priority/search`) as values to choose: `{ id, label }`, each ID once, sorted by name.
 *
 * @param {unknown} data
 * @returns {Array<{ id: string, label: string }>}
 * @throws {Error} When the response isn't such a list
 */
export function parseNamedValues(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.values) ? data.values : null;
  if (!list) throw new Error('Jira sent an unexpected list of values.');
  const byId = new Map();
  for (const item of list) {
    const id = typeof item?.id === 'string' || typeof item?.id === 'number' ? String(item.id) : '';
    const label = text(item?.name);
    if (id && label && !byId.has(id)) byId.set(id, { id, label });
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id));
}

/**
 * Reads Jira's JQL suggestions for a custom field's values (`GET /jql/autocompletedata/suggestions`)
 * as values to choose: `{ id, label }`, both the option's name (its JQL form, unquoted), each once,
 * in Jira's order.
 *
 * @param {unknown} data
 * @returns {Array<{ id: string, label: string }>}
 * @throws {Error} When the response isn't a list of suggestions
 */
export function parseFieldSuggestions(data) {
  if (!Array.isArray(data?.results)) throw new Error('Jira sent unexpected suggestions.');
  const values = [];
  for (const result of data.results) {
    const name = unquoteJqlValue(result?.value);
    if (!name || CONTROL_CHARACTERS.test(name) || values.some((value) => value.id === name)) continue;
    values.push({ id: name, label: name });
  }
  return values;
}

/** A suggested JQL value as plain text: `"Cisco UC Apps"` → `Cisco UC Apps`, `Sega` → `Sega`. */
function unquoteJqlValue(value) {
  const raw = text(value);
  const quoted = /^"(.*)"$/s.exec(raw) ?? /^'(.*)'$/s.exec(raw);
  return quoted ? quoted[1].replace(/\\(.)/g, '$1').trim() : raw;
}

/**
 * Describes a view's search for its panel: "Status in In Progress, Review · Priority, ascending",
 * "Status not in Done and Reporter in Me · Updated, descending".
 * @param {{ conditions: Array<object>, orderBy?: object }} view
 * @returns {string}
 */
export function describeView(view) {
  const conditions = view.conditions.map((condition) => {
    const labels = condition.values.map((value) => value.label).join(', ');
    return `${condition.field.name} ${condition.operator === OPERATORS.NOT_IN ? 'not in' : 'in'} ${labels}`;
  });
  const orderBy = normalizeOrderBy(view.orderBy) ?? DEFAULT_ORDER_BY;
  const orderName = ORDER_BY_FIELDS.find((item) => item.id === orderBy.field).name;
  return `${conditions.join(' and ')} · ${orderName}, ${ORDER_DIRECTION_LABELS[orderBy.direction].toLowerCase()}`;
}

/**
 * Whether a view's fields can all still be used. The standard fields always can. A custom user
 * field can while it's one of the site's Additional Assignment Fields or among its single-user
 * fields; an option custom field while it's among the site's single-select fields. While the
 * site's fields aren't known, it's assumed they can.
 *
 * @param {{ conditions: Array<object> }} view
 * @param {object} context
 * @param {string[]} context.assignmentFieldIds
 * @param {Set<string> | null} context.singleSelectFieldIds - Null while not known
 * @param {Set<string> | null} [context.userPickerFieldIds] - The site's single-user fields; null while not known
 * @returns {boolean}
 */
export function isViewAvailable(view, { assignmentFieldIds, singleSelectFieldIds, userPickerFieldIds = null }) {
  return view.conditions.every((condition) => {
    const { id } = condition.field;
    if (!CUSTOM_FIELD_ID.test(id)) return true;
    if (conditionKind(condition) === 'user') return assignmentFieldIds.includes(id) || !userPickerFieldIds || userPickerFieldIds.has(id);
    return !singleSelectFieldIds || singleSelectFieldIds.has(id);
  });
}

/**
 * The custom user fields a view may compare with Me, for buildCustomViewJql(): the site's
 * Additional Assignment Fields and single-user fields, or, while those aren't known, the view's own
 * (isViewAvailable() assumes them available until then).
 *
 * @param {{ conditions: Array<object> }} view
 * @param {{ assignmentFieldIds: string[], userPickerFieldIds?: Set<string> | null }} context
 * @returns {string[]}
 */
export function viewUserFieldIds(view, { assignmentFieldIds, userPickerFieldIds = null }) {
  const own = view.conditions.filter((condition) => conditionKind(condition) === 'user').map((condition) => condition.field.id);
  return own.filter((id) => assignmentFieldIds.includes(id) || !userPickerFieldIds || userPickerFieldIds.has(id));
}

/**
 * Whether any view compares a custom field (a single-select field, or a user field that isn't an
 * Additional Assignment Field), whose availability needs the site's list of fields (GET /field).
 * @param {Array<object>} views
 * @param {string[]} [assignmentFieldIds]
 * @returns {boolean}
 */
export function usesCustomField(views, assignmentFieldIds = []) {
  return views.some((view) => view.conditions.some((condition) =>
    CUSTOM_FIELD_ID.test(condition.field.id) && !(conditionKind(condition) === 'user' && assignmentFieldIds.includes(condition.field.id))));
}
