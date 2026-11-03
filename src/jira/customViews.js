/**
 * Custom views of My Active Issues: up to two named views per Jira site, each with one condition
 * (a field, an operator, and values) that narrows the issues My Active Issues already lists. A
 * view never widens that list: it's applied locally to the issues the existing search returned
 * (JiraClient.getActiveIssues()), and never adds anything to the search's JQL.
 *
 * Fields:
 * - Status and Priority, and custom single-select or radio-button fields: compared by Jira's ID
 *   for the status, priority, or option. The values to choose: every status and priority Jira lists
 *   (GET /status, GET /priority), the ones the issues already loaded have first; for custom fields,
 *   those the loaded issues have (their full lists need administrator access).
 * - Assignee, Reporter, and the site's Additional Assignment Fields: compared only against the
 *   current user ("Me"). JiraClient reduces these fields to `{ isCurrentUser }`, so no other
 *   person's identity reaches views, the page, or storage.
 *
 * Operators: Equals (one value) and Is one of (at least two values; not for user fields).
 *
 * Stored in storage.local as `customViewsBySite`, per Jira site (`${deploymentType}|${baseUrl}`,
 * as siteId() makes it): { [site]: { version: 1, views: [{ id, name, conditions: [{ field: { id,
 * name }, operator, values: [{ id, label }] | [{ currentUser: true, label: 'Me' }] }] }] } }. One
 * condition per view for now; `conditions` is a list so more can come later. A site's entry with
 * another version is from another version of the extension: it's neither used nor overwritten.
 *
 * No DOM and no network access.
 */

export const CUSTOM_VIEWS_VERSION = 1;
export const MAX_CUSTOM_VIEWS = 2;
export const MAX_VIEW_NAME_LENGTH = 30;

// The view that lists every issue: My Active Issues as it is. Its name is reserved.
export const ALL_VIEW_ID = 'all';
export const ALL_VIEW_NAME = 'All';

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

// Fields a view may add to the active issues search; the search always asks for status and assignee.
export const REQUESTABLE_VIEW_FIELD = /^(priority|reporter|customfield_\d+)$/;

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

  const values = [];
  for (const value of raw.values) {
    const valueId = typeof value?.id === 'string' || typeof value?.id === 'number' ? String(value.id) : '';
    if (!valueId) return null;
    if (values.some((v) => v.id === valueId)) continue;
    values.push({ id: valueId, label: text(value.label) || valueId });
  }
  if (operator === OPERATORS.EQUALS ? values.length !== 1 : values.length < 2) return null;
  return { field, operator, values };
}

/**
 * Checks a view's name: required once trimmed, at most MAX_VIEW_NAME_LENGTH characters, and not
 * All (in any letter case).
 * @param {unknown} name
 * @returns {string} What's wrong, or '' when it's valid
 */
export function nameProblem(name) {
  const trimmed = text(name);
  if (!trimmed) return 'Enter a name for the view.';
  if (trimmed.length > MAX_VIEW_NAME_LENGTH) return `Use at most ${MAX_VIEW_NAME_LENGTH} characters.`;
  if (sameName(trimmed, ALL_VIEW_NAME)) return '"All" is the view of all your issues. Choose another name.';
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
 * The fields the site's views compare, each once, in order: what the active issues search has to
 * return for them (JiraClient.getActiveIssues()'s `viewFields`). None without views.
 * @param {Array<{ conditions: Array<{ field: { id: string } }> }>} views
 * @returns {string[]}
 */
export function requiredViewFields(views) {
  const ids = [];
  for (const view of views) {
    for (const condition of view.conditions) {
      if (VIEW_FIELD_ID.test(condition.field.id) && !ids.includes(condition.field.id)) ids.push(condition.field.id);
    }
  }
  return ids;
}

/**
 * Reduces an issue's fields to what views compare, for the given field IDs:
 * - status, priority, and custom single-select fields: `{ id, label }` (the option's or status's
 *   ID, and its name), or null when the issue has none (or it isn't a single option)
 * - assignee, reporter, and `userFieldIds` (the Additional Assignment Fields): `{ isCurrentUser }`,
 *   or null when nobody is set. Nothing else about the person is kept.
 *
 * @param {object} fields - An issue's `fields`, as Jira's search returns them
 * @param {string[]} fieldIds
 * @param {object} options
 * @param {string[]} [options.userFieldIds] - Custom fields that hold a person
 * @param {(person: object) => boolean} options.isCurrentUser
 * @returns {Record<string, { id: string, label: string } | { isCurrentUser: boolean } | null>}
 */
export function toViewFieldValues(fields, fieldIds, { userFieldIds = [], isCurrentUser }) {
  const values = {};
  for (const id of fieldIds) {
    if (!VIEW_FIELD_ID.test(id)) continue;
    const raw = fields?.[id];
    if (USER_SYSTEM_FIELDS.has(id) || userFieldIds.includes(id)) {
      values[id] = raw && typeof raw === 'object' && !Array.isArray(raw) ? { isCurrentUser: Boolean(isCurrentUser(raw)) } : null;
      continue;
    }
    const optionId = raw && !Array.isArray(raw) && (typeof raw.id === 'string' || typeof raw.id === 'number') ? String(raw.id) : '';
    // Statuses and priorities have a name; custom options a value.
    const label = OPTION_SYSTEM_FIELDS.has(id) ? text(raw?.name) : text(raw?.value);
    values[id] = optionId && label ? { id: optionId, label } : null;
  }
  return values;
}

/**
 * Whether an issue meets a condition, by the values toViewFieldValues() gave it. An issue without
 * a value for the field never does.
 */
export function matchesCondition(issue, condition) {
  const value = issue?.viewFields?.[condition.field.id];
  if (!value) return false;
  if (conditionKind(condition) === 'user') return value.isCurrentUser === true;
  return condition.values.some((wanted) => wanted.id === value.id);
}

/**
 * Whether an issue is in a view: it meets the view's condition.
 * @param {object} issue - From JiraClient.getActiveIssues() with the view's fields
 * @param {{ conditions: Array<object> }} view
 * @returns {boolean}
 */
export function matchesView(issue, view) {
  return view.conditions.length > 0 && view.conditions.every((condition) => matchesCondition(issue, condition));
}

/**
 * The values to choose from for a field: Me for a user field; otherwise each value the loaded
 * issues have for it, once, sorted by label.
 *
 * @param {Array<object>} issues - Loaded with the field (their `viewFields` have it)
 * @param {{ id: string, kind: 'user' | 'option' }} field
 * @returns {Array<{ id: string, label: string } | { currentUser: true, label: string }>}
 */
export function valueOptions(issues, field) {
  if (field.kind === 'user') return [{ ...ME_VALUE }];
  const byId = new Map();
  for (const issue of issues) {
    const value = issue?.viewFields?.[field.id];
    if (value?.id && !byId.has(value.id)) byId.set(value.id, { id: value.id, label: value.label });
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id));
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
 * The values to choose for a field, from the issues listed and from Jira's own list: those the
 * issues have first (`listed: true`), then Jira's others (`listed: false`), each ID once.
 *
 * @param {Array<{ id: string, label: string }>} listed - valueOptions() of the loaded issues
 * @param {Array<{ id: string, label: string }>} [fromJira] - parseNamedValues() of Jira's list
 * @returns {Array<{ id: string, label: string, listed: boolean }>}
 */
export function mergeValueOptions(listed, fromJira = []) {
  const seen = new Set();
  const merged = [];
  for (const [values, isListed] of [[listed, true], [fromJira, false]]) {
    for (const value of values) {
      if (seen.has(value.id)) continue;
      seen.add(value.id);
      merged.push({ id: value.id, label: value.label, listed: isListed });
    }
  }
  return merged;
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
