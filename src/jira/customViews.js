/**
 * Custom views of My Issues: up to two named views per Jira site, as tabs beside Active (the
 * built-in view: My Work's existing search), each with one condition (a field, an operator, and
 * values). A view is its own Jira search: buildCustomViewJql() turns its condition into JQL, and the
 * page runs it apart from Active's search (src/jira/customViewSearch.js), so a view finds the issues
 * the user can browse in Jira that match, whether Active lists them or not. Jira's permissions decide what any search returns. A view lists the first
 * CUSTOM_VIEW_RESULT_LIMIT issues, most recently updated first (then by key, so the same issues
 * come back in the same order), from one request: Jira is never asked for another page.
 *
 * Fields:
 * - Status and Priority: Jira's numeric ID in the JQL (`status in (10001, 3)`), chosen from every
 *   status and priority Jira lists (GET /status, GET /priority).
 * - Custom single-select and radio-button fields: the option's name, quoted and escaped
 *   (`cf[10050] = "Platform"`). Jira Data Center rejects option IDs in JQL, and only administrators
 *   can list a field's options with their IDs, so the names come from Jira's JQL suggestions for the
 *   field, and the stored `id` is the name too. A renamed option no longer matches until the view is
 *   edited.
 * - Assignee, Reporter, and the site's Additional Assignment Fields: only Me, as `currentUser()`.
 *   No other person can be chosen, stored, or shown.
 *
 * Operators: Equals (one value) and Is one of (at least two values; not for user fields).
 *
 * Stored in storage.local as `customViewsBySite`, per Jira site (`${deploymentType}|${baseUrl}`,
 * as siteId() makes it): { [site]: { version: 1, views: [{ id, name, conditions: [{ field: { id,
 * name }, operator, values: [{ id, label }] | [{ currentUser: true, label: 'Me' }] }] }] } }. One
 * condition per view for now; `conditions` is a list so more can come later. A site's entry with
 * another version is from another version of the extension: it's neither used nor overwritten.
 * Search results are never stored.
 *
 * No DOM and no network access.
 */

export const CUSTOM_VIEWS_VERSION = 1;
export const MAX_CUSTOM_VIEWS = 2;
export const MAX_VIEW_NAME_LENGTH = 30;
// The issues a view lists: Jira's first ones, in one request.
export const CUSTOM_VIEW_RESULT_LIMIT = 20;

// The built-in view, Active: My Work's existing search. Its name, and All, are no custom view's.
export const ALL_VIEW_ID = 'all';
export const ALL_VIEW_NAME = 'Active';
export const RESERVED_VIEW_NAMES = Object.freeze([ALL_VIEW_NAME, 'All']);

export const OPERATORS = { EQUALS: 'equals', IS_ONE_OF: 'isOneOf' };
export const OPERATOR_LABELS = { equals: 'Equals', isOneOf: 'Is one of' };

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
 * The operators a kind of field can use: Equals only for user fields (their one value is Me).
 * @param {'user' | 'option'} kind
 * @returns {string[]}
 */
export function operatorsFor(kind) {
  return kind === 'user' ? [OPERATORS.EQUALS] : [OPERATORS.EQUALS, OPERATORS.IS_ONE_OF];
}

/**
 * Checks a stored condition; null when it's malformed. The field must be one a view can use, and
 * its values must suit it: Me alone (with Equals) for a user field, one value for Equals, and two
 * or more for Is one of.
 *
 * @param {unknown} raw
 * @returns {{ field: { id: string, name: string }, operator: string, values: Array<object> } | null}
 */
export function normalizeCondition(raw) {
  const id = typeof raw?.field?.id === 'string' ? raw.field.id : '';
  if (!VIEW_FIELD_ID.test(id)) return null;
  const field = { id, name: text(raw.field.name) || id };
  const operator = raw.operator;
  if (!Object.values(OPERATORS).includes(operator) || !Array.isArray(raw.values) || raw.values.length === 0) return null;

  if (raw.values.some((value) => value?.currentUser === true)) {
    if (OPTION_SYSTEM_FIELDS.has(id) || operator !== OPERATORS.EQUALS || raw.values.length !== 1) return null;
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
  if (operator === OPERATORS.EQUALS ? values.length !== 1 : values.length < 2) return null;
  return { field, operator, values };
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
 * Checks a stored view; null when it's malformed: a valid ID and name, and exactly one valid
 * condition.
 * @param {unknown} raw
 * @returns {{ id: string, name: string, conditions: Array<object> } | null}
 */
export function normalizeView(raw) {
  const id = typeof raw?.id === 'string' && VIEW_ID.test(raw.id) ? raw.id : '';
  if (!id || id === ALL_VIEW_ID || nameProblem(raw.name)) return null;
  if (!Array.isArray(raw.conditions) || raw.conditions.length !== 1) return null;
  const condition = normalizeCondition(raw.conditions[0]);
  return condition ? { id, name: text(raw.name), conditions: [condition] } : null;
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
 * Checks a view being created or edited, as the editor has it, against the site's other views.
 *
 * @param {{ name?: string, field?: { id: string, name: string, kind: 'user' | 'option' } | null,
 *   operator?: string, values?: Array<object> }} draft
 * @param {object} context
 * @param {Array<{ id: string, name: string }>} context.views - The site's saved views
 * @param {string} [context.editingId] - The view being edited; none when creating one
 * @returns {{ errors: { form?: string, name?: string, field?: string, operator?: string, values?: string },
 *   view: { name: string, conditions: Array<object> } | null }} `view` (without its ID) when there are no errors
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

  const field = draft.field;
  const values = Array.isArray(draft.values) ? draft.values : [];
  if (!field || !VIEW_FIELD_ID.test(field.id ?? '')) {
    errors.field = 'Choose a field.';
  } else if (!operatorsFor(field.kind).includes(draft.operator)) {
    errors.operator = 'Choose an operator.';
  } else if (field.kind === 'user') {
    if (values.length !== 1 || values[0]?.currentUser !== true) errors.values = 'Choose Me.';
  } else if (draft.operator === OPERATORS.EQUALS && values.length !== 1) {
    errors.values = 'Choose a value.';
  } else if (draft.operator === OPERATORS.IS_ONE_OF && values.length < 2) {
    errors.values = 'Choose at least two values.';
  }

  if (Object.keys(errors).length > 0) return { errors, view: null };
  const condition = normalizeCondition({ field: { id: field.id, name: field.name }, operator: draft.operator, values });
  if (!condition) return { errors: { values: 'Choose the values again.' }, view: null };
  return { errors, view: { name, conditions: [condition] } };
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
 * Builds the JQL of a view's own Jira search, from its condition alone: allow-listed fields and
 * operators, numeric IDs for statuses and priorities, quoted names for custom options, and
 * `currentUser()` for Me. Nothing typed by the user goes into it unquoted. Ordered by the latest
 * update, newest first, then by key, so the first issues are the same from one search to the next.
 *
 * @param {{ conditions: Array<object> }} view - A stored view (normalizeView())
 * @param {object} context
 * @param {string[]} context.assignmentFieldIds - The site's Additional Assignment Fields: the only
 *   custom fields Me can be compared on
 * @returns {string} E.g. `reporter = currentUser() ORDER BY updated DESC, key DESC`
 * @throws {Error} For a condition that isn't valid, or a field views can't search on
 */
export function buildCustomViewJql(view, { assignmentFieldIds = [] } = {}) {
  if (!Array.isArray(view?.conditions) || view.conditions.length !== 1) throw new Error('A view has exactly one condition.');
  const condition = normalizeCondition(view.conditions[0]);
  if (!condition) throw new Error('This view\'s condition isn\'t valid.');
  const { id } = condition.field;
  const custom = CUSTOM_FIELD_ID.exec(id);
  // System fields by name, custom fields by number: cf[10050].
  const clauseField = custom ? `cf[${custom[1]}]` : id;

  let values;
  if (conditionKind(condition) === 'user') {
    if (custom && !assignmentFieldIds.includes(id)) throw new Error('This view\'s field is no longer available in Jira.');
    values = ['currentUser()'];
  } else if (OPTION_SYSTEM_FIELDS.has(id)) {
    values = condition.values.map((value) => value.id);
  } else {
    values = condition.values.map((value) => jqlString(value.label));
  }
  const clause = condition.operator === OPERATORS.EQUALS ? `${clauseField} = ${values[0]}` : `${clauseField} in (${values.join(', ')})`;
  return `${clause} ORDER BY updated DESC, key DESC`;
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
 * Describes a view's search for its panel: "Status is one of In Progress, Review", "Reporter is Me".
 * @param {{ conditions: Array<object> }} view
 * @returns {string}
 */
export function describeView(view) {
  const condition = view.conditions[0];
  const labels = condition.values.map((value) => value.label).join(', ');
  return `${condition.field.name} ${condition.operator === OPERATORS.IS_ONE_OF ? 'is one of' : 'is'} ${labels}`;
}

/**
 * Whether a view's field can still be used. The standard fields always can. A user custom field
 * can while it's one of the site's Additional Assignment Fields; an option custom field while
 * it's among the site's single-select fields (when those are known: until then, it's assumed it can).
 *
 * @param {{ conditions: Array<object> }} view
 * @param {object} context
 * @param {string[]} context.assignmentFieldIds
 * @param {Set<string> | null} context.singleSelectFieldIds - Null while not known
 * @returns {boolean}
 */
export function isViewAvailable(view, { assignmentFieldIds, singleSelectFieldIds }) {
  return view.conditions.every((condition) => {
    const { id } = condition.field;
    if (!CUSTOM_FIELD_ID.test(id)) return true;
    if (conditionKind(condition) === 'user') return assignmentFieldIds.includes(id);
    return !singleSelectFieldIds || singleSelectFieldIds.has(id);
  });
}

/**
 * Whether any view compares a custom single-select field, whose availability needs the site's
 * list of fields (GET /field).
 * @param {Array<object>} views
 * @returns {boolean}
 */
export function usesCustomOptionField(views) {
  return views.some((view) => view.conditions.some((condition) =>
    CUSTOM_FIELD_ID.test(condition.field.id) && conditionKind(condition) === 'option'));
}
