/**
 * Custom groups of the Worklog Queue: up to five (MAX_WORKLOG_GROUPS) named groups per Jira site,
 * as tabs beside the two built-in ones, Pending and On Hold (src/worklog/pendingClassification.js).
 * A group only organizes pending worklogs in this browser: it isn't a Jira status, it's never sent
 * to Jira, and it has no submission of its own (a worklog is submitted from its row, as in Pending
 * and On Hold, or moved to Pending first).
 *
 * A pending worklog is filed under a group through its `classification` (src/timer/timeTrackingStore.js),
 * which holds the group's ID: one field, so a worklog is never in two groups at once, and it goes
 * with the worklog when that's submitted or discarded. A worklog filed under a group that's gone
 * (deleted, here or in another tab, or one of another Jira site's groups) reads as On Hold
 * (resolveClassification() in pendingClassification.js), so deleting a group never hides or loses
 * a worklog, even before its worklogs are moved to On Hold in storage.
 *
 * Stored in storage.local as `worklogGroupsBySite`, per Jira site (`${deploymentType}|${baseUrl}`,
 * as siteId() makes it): { [site]: { version: 1, groups: [{ id, name }] } }, in their tabs' order
 * (the order they were created in). A site's entry with another version is from another version of
 * the extension: it's neither used nor overwritten.
 *
 * No DOM and no storage access.
 */

import { isGroupId } from '../timer/timeTrackingStore.js';

// The ID format belongs to the stored worklogs, which name their group (src/timer/timeTrackingStore.js).
export { isGroupId };

export const WORKLOG_GROUPS_VERSION = 1;
export const MAX_WORKLOG_GROUPS = 5;
export const MAX_GROUP_NAME_LENGTH = 30;

// The built-in groups' names, which no custom group can take, in any letter case.
export const RESERVED_GROUP_NAMES = Object.freeze(['Pending', 'On Hold']);

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const sameName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/**
 * A new custom group's ID.
 * @param {string} [uuid=crypto.randomUUID()]
 * @returns {string}
 */
export function newGroupId(uuid = crypto.randomUUID()) {
  return `group-${uuid}`;
}

/**
 * What's wrong with a group's name: none, longer than MAX_GROUP_NAME_LENGTH, or a built-in
 * group's (RESERVED_GROUP_NAMES), in any letter case.
 * @param {unknown} name
 * @returns {string} What's wrong, or '' when it's valid
 */
export function groupNameProblem(name) {
  const trimmed = text(name);
  if (!trimmed) return 'Enter a name for the group.';
  if (trimmed.length > MAX_GROUP_NAME_LENGTH) return `Use at most ${MAX_GROUP_NAME_LENGTH} characters.`;
  const reserved = RESERVED_GROUP_NAMES.find((reservedName) => sameName(trimmed, reservedName));
  if (reserved) return `"${reserved}" is a built-in group. Choose another name.`;
  return '';
}

/**
 * Checks a stored group; null when its ID or name isn't valid.
 * @param {unknown} raw
 * @returns {{ id: string, name: string } | null}
 */
export function normalizeGroup(raw) {
  if (!isGroupId(raw?.id) || groupNameProblem(raw.name)) return null;
  return { id: raw.id, name: text(raw.name) };
}

/**
 * Checks one site's stored groups. An entry with another version is from another version of the
 * extension: it's marked `unsupported`, with no groups, so it's neither used nor overwritten.
 * Otherwise malformed groups are left out, as are repeated IDs and names, and any past
 * MAX_WORKLOG_GROUPS.
 *
 * @param {unknown} raw
 * @returns {{ version: number, groups: Array<{ id: string, name: string }>, unsupported?: true }}
 */
export function normalizeSiteGroups(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: WORKLOG_GROUPS_VERSION, groups: [] };
  if (raw.version !== WORKLOG_GROUPS_VERSION) {
    return 'version' in raw
      ? { version: WORKLOG_GROUPS_VERSION, groups: [], unsupported: true }
      : { version: WORKLOG_GROUPS_VERSION, groups: [] };
  }
  const groups = [];
  for (const item of Array.isArray(raw.groups) ? raw.groups : []) {
    const group = normalizeGroup(item);
    if (!group || groups.some((g) => g.id === group.id || sameName(g.name, group.name))) continue;
    groups.push(group);
    if (groups.length === MAX_WORKLOG_GROUPS) break;
  }
  return { version: WORKLOG_GROUPS_VERSION, groups };
}

/**
 * Checks every site's stored groups: `{ [site]: normalizeSiteGroups() }`.
 * @param {unknown} raw
 * @returns {Record<string, { version: number, groups: Array<{ id: string, name: string }>, unsupported?: true }>}
 */
export function normalizeWorklogGroupsBySite(raw) {
  const bySite = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bySite;
  for (const [site, entry] of Object.entries(raw)) {
    if (site) bySite[site] = normalizeSiteGroups(entry);
  }
  return bySite;
}

/**
 * Checks a group being created or renamed, as the editor has it, against the site's other groups:
 * its name (valid, and no other group's), and, for a new one, room for it.
 *
 * @param {{ name?: string }} draft
 * @param {object} context
 * @param {Array<{ id: string, name: string }>} context.groups - The site's saved groups
 * @param {string} [context.editingId] - The group being renamed; none when creating one
 * @returns {{ errors: { form?: string, name?: string }, group: { name: string } | null }} `group`
 *   (without its ID) when there are no errors
 */
export function validateGroupDraft(draft, { groups, editingId }) {
  const errors = {};
  const others = groups.filter((group) => group.id !== editingId);
  if (!editingId && others.length >= MAX_WORKLOG_GROUPS) errors.form = `You can have at most ${MAX_WORKLOG_GROUPS} custom groups.`;
  if (editingId && !groups.some((group) => group.id === editingId)) errors.form = 'This group was deleted, maybe in another tab.';

  const name = text(draft?.name);
  const problem = groupNameProblem(name);
  if (problem) errors.name = problem;
  else if (others.some((group) => sameName(group.name, name))) errors.name = 'Another group already has this name.';

  return Object.keys(errors).length > 0 ? { errors, group: null } : { errors, group: { name } };
}
