/**
 * Additional Assignment Fields: Jira user fields (such as a "QA Assignee") that also count as
 * assigning an issue to the user in My Active Issues, alongside the standard Assignee.
 *
 * Only single-user custom fields are supported: custom fields whose schema is the user picker
 * (`com.atlassian.jira.plugin.system.customfieldtypes:userpicker`), as both Jira Cloud
 * (`GET /rest/api/3/field`) and Data Center / Server (`GET /rest/api/2/field`) describe them, and
 * that JQL can search. Fields are identified by their Jira ID (`customfield_10050`), never by
 * name: names can repeat and change. In JQL a field is `cf[10050]`, which both editions accept,
 * so no name is ever quoted into a query.
 *
 * No DOM and no network access.
 */

export const USER_PICKER_SCHEMA = 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker';

// The most fields kept per Jira site; each adds a clause to the active issues search.
export const MAX_ASSIGNMENT_FIELDS = 10;

const CUSTOM_FIELD_ID = /^customfield_(\d+)$/;

/**
 * @param {unknown} value
 * @returns {string} A trimmed name, or ''
 */
const toName = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Picks the supported fields out of a `GET /field` response.
 *
 * @param {unknown} data
 * @returns {Array<{ id: string, name: string }>} Sorted by name, then ID
 * @throws {Error} When the response isn't a list of fields
 */
export function parseUserPickerFields(data) {
  if (!Array.isArray(data)) throw new Error('Jira sent an unexpected list of fields.');
  const byId = new Map();
  for (const field of data) {
    const id = typeof field?.id === 'string' ? field.id : '';
    const name = toName(field?.name);
    if (!CUSTOM_FIELD_ID.test(id) || !name || byId.has(id)) continue;
    if (field.custom === false || field.searchable === false) continue;
    if (field.schema?.type !== 'user' || field.schema?.custom !== USER_PICKER_SCHEMA) continue;
    byId.set(id, { id, name });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
    fieldNumber(a.id) - fieldNumber(b.id));
}

/** The number in `customfield_10050`. */
function fieldNumber(id) {
  return Number(CUSTOM_FIELD_ID.exec(id)?.[1] ?? 0);
}

/**
 * Checks a stored list of fields: valid IDs only, each once, with a name to show.
 *
 * @param {unknown} raw
 * @returns {Array<{ id: string, name: string }>}
 */
export function normalizeAssignmentFields(raw) {
  if (!Array.isArray(raw)) return [];
  const fields = [];
  for (const item of raw) {
    const id = typeof item?.id === 'string' ? item.id : '';
    if (!CUSTOM_FIELD_ID.test(id) || fields.some((field) => field.id === id)) continue;
    fields.push({ id, name: toName(item.name) || id });
    if (fields.length === MAX_ASSIGNMENT_FIELDS) break;
  }
  return fields;
}

/**
 * Checks the stored fields of every Jira site: `{ [site]: fields }`, without sites that have none.
 *
 * @param {unknown} raw
 * @returns {Record<string, Array<{ id: string, name: string }>>}
 */
export function normalizeAssignmentFieldsBySite(raw) {
  const bySite = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bySite;
  for (const [site, list] of Object.entries(raw)) {
    const fields = normalizeAssignmentFields(list);
    if (site && fields.length) bySite[site] = fields;
  }
  return bySite;
}

/**
 * The JQL clause for a field: `cf[10050]`.
 *
 * @param {string} id - A custom field ID, `customfield_<number>`
 * @returns {string}
 */
export function assignmentFieldClause(id) {
  const match = CUSTOM_FIELD_ID.exec(id);
  if (!match) throw new Error(`Not a custom field ID: ${id}`);
  return `cf[${match[1]}]`;
}

/**
 * Adds the field ID as a hint to fields whose name another field in `fields` shares (ignoring
 * case), so two "Reviewer" fields can be told apart.
 *
 * @param {Array<{ id: string, name: string }>} fields
 * @returns {Array<{ id: string, name: string, hint: string }>} `hint` is '' when the name is unique
 */
export function withDuplicateHints(fields) {
  const counts = new Map();
  for (const { name } of fields) counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) || 0) + 1);
  return fields.map((field) => ({ ...field, hint: counts.get(field.name.toLowerCase()) > 1 ? field.id : '' }));
}
