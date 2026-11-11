/**
 * The Worklogs group's classifications: Pending, On Hold, and Archived, one tab each. Pending's
 * internal ID is 'ready' (its name before 1.2.2): it's never stored, so renaming it changed no data,
 * and every worklog stored without a classification still reads as Pending. A pending
 * worklog's classification is this browser's own metadata (src/timer/timeTrackingStore.js,
 * classifyPending()); changing it never sends anything to Jira, and never changes the worklog's
 * time, comment, or submission.
 *
 * Here: each tab's count and total, the actions a row's menu and the bulk bar offer, the selection
 * (always within the selected tab), and running a classification change and saying how it went.
 * No DOM and no storage access: the page controller keeps the selection and renders it.
 */

import { DEFAULT_CLASSIFICATION, PENDING_CLASSIFICATIONS, classificationOf } from '../timer/timeTrackingStore.js';

/**
 * The classifications, in tab order: the tab's name, a row menu's action, and the bulk bar's.
 * @type {ReadonlyArray<{ id: 'ready' | 'on-hold' | 'archived', label: string, action: string, bulkAction: string }>}
 */
export const CLASSIFICATIONS = Object.freeze([
  { id: 'ready', label: 'Pending', action: 'Mark as Pending', bulkAction: 'Pending' },
  { id: 'on-hold', label: 'On Hold', action: 'Put On Hold', bulkAction: 'On Hold' },
  { id: 'archived', label: 'Archived', action: 'Archive', bulkAction: 'Archive' }
].map(Object.freeze));

/**
 * True for 'ready', 'on-hold', and 'archived'.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isClassification(value) {
  return PENDING_CLASSIFICATIONS.includes(value);
}

/**
 * A classification's tab name ("On Hold").
 * @param {string} id
 * @returns {string}
 */
export function classificationLabel(id) {
  return (CLASSIFICATIONS.find((c) => c.id === id) ?? CLASSIFICATIONS[0]).label;
}

/**
 * The pending worklogs filed under a classification, in stored order. Every one of them, wherever
 * it was tracked: a tab never shows only part of its worklogs.
 * @param {Array<object>} entries - `timeTracking.pending`
 * @param {string} classification
 * @returns {Array<object>}
 */
export function entriesIn(entries, classification) {
  return (entries ?? []).filter((entry) => classificationOf(entry) === classification);
}

/**
 * Each classification's count and total time (whole seconds), from the same entries the tabs list,
 * so they always add up to every pending worklog.
 * @param {Array<object>} entries - `timeTracking.pending`
 * @returns {Record<'ready' | 'on-hold' | 'archived', { count: number, seconds: number }>}
 */
export function summarizeClassifications(entries) {
  const summary = Object.fromEntries(PENDING_CLASSIFICATIONS.map((id) => [id, { count: 0, seconds: 0 }]));
  for (const entry of entries ?? []) {
    const totals = summary[classificationOf(entry)];
    totals.count++;
    totals.seconds += Math.max(0, Number(entry?.timeSpentSeconds) || 0);
  }
  return summary;
}

/**
 * The actions a pending worklog's menu offers: every classification but its own.
 * @param {string} classification - classificationOf() the row
 * @returns {Array<{ id: string, label: string, action: string, bulkAction: string }>}
 */
export function rowActions(classification) {
  return CLASSIFICATIONS.filter((c) => c.id !== classification);
}

/**
 * The bulk bar's actions for the selected worklogs: every classification at least one of them isn't
 * under already (moving them there would change nothing otherwise). None without a selection.
 * @param {Array<object>} selected - The selected pending worklogs
 * @returns {Array<{ id: string, label: string, action: string, bulkAction: string }>}
 */
export function bulkActions(selected) {
  if (!selected?.length) return [];
  return CLASSIFICATIONS.filter((c) => !selected.every((entry) => classificationOf(entry) === c.id));
}

/**
 * Pending Worklogs' selection: which tab is selected, whether selection mode is on, and which of
 * the tab's worklogs are selected. The selection only ever holds worklogs of the selected tab:
 * choosing another tab clears it, and reconcile() drops worklogs that left the tab (filed
 * elsewhere, submitted, or discarded, here or in another browser tab).
 *
 * @param {string} [initialTab] - A classification; Ready otherwise
 */
export function createPendingSelection(initialTab) {
  let tab = isClassification(initialTab) ? initialTab : DEFAULT_CLASSIFICATION;
  let selecting = false;
  let selected = new Set();

  const idsInTab = (entries) => new Set(entriesIn(entries, tab).map((entry) => entry.id));

  return {
    /** The selected tab's classification. */
    get tab() { return tab; },
    /** Whether selection mode is on (the checkboxes show). */
    get selecting() { return selecting; },
    /** How many worklogs are selected. */
    get size() { return selected.size; },

    /** @returns {string[]} The selected worklogs' IDs, in the order they were selected. */
    selectedIds: () => [...selected],

    /** @param {string} id */
    has: (id) => selected.has(id),

    /**
     * Selects a tab. Another tab clears the selection, so it never carries over; selection mode stays.
     * @param {string} next
     * @returns {boolean} True when the tab changed
     */
    selectTab(next) {
      if (!isClassification(next) || next === tab) return false;
      tab = next;
      selected = new Set();
      return true;
    },

    /**
     * Turns selection mode on or off; off clears the selection.
     * @param {boolean} on
     */
    setSelecting(on) {
      selecting = Boolean(on);
      if (!selecting) selected = new Set();
    },

    /**
     * Selects or deselects one worklog of the selected tab. A worklog of another tab, or one that's
     * gone, is never selected.
     * @param {string} id
     * @param {Array<object>} entries - `timeTracking.pending`
     * @returns {boolean} True when the selection changed
     */
    toggle(id, entries) {
      if (selected.has(id)) {
        selected.delete(id);
        return true;
      }
      if (!selecting || !idsInTab(entries).has(id)) return false;
      selected.add(id);
      return true;
    },

    /**
     * Selects every worklog in the selected tab, from the stored entries (not only those on screen).
     * @param {Array<object>} entries - `timeTracking.pending`
     */
    selectAll(entries) {
      if (!selecting) return;
      selected = idsInTab(entries);
    },

    /** Deselects every worklog. */
    deselectAll() {
      selected = new Set();
    },

    /**
     * Keeps only the selected worklogs still in the selected tab.
     * @param {Array<object>} entries - `timeTracking.pending`, as just read
     * @returns {boolean} True when any was dropped
     */
    reconcile(entries) {
      const inTab = idsInTab(entries);
      const kept = [...selected].filter((id) => inTab.has(id));
      if (kept.length === selected.size) return false;
      selected = new Set(kept);
      return true;
    },

    /**
     * Keeps only these worklogs selected (those a change couldn't move).
     * @param {string[]} ids
     */
    keepOnly(ids) {
      const keep = new Set(ids);
      selected = new Set([...selected].filter((id) => keep.has(id)));
    }
  };
}

const plural = (count, word) => `${count} ${count === 1 ? word : `${word}s`}`;

const LIST_FORMAT = new Intl.ListFormat('en-US', { type: 'conjunction' });
// How many issue keys a message names before "and N more".
const NAMED_KEYS = 4;

/** "KAN-1", "KAN-1 and KAN-2", "KAN-1, KAN-2, KAN-3, KAN-4, and 2 more". */
function nameKeys(keys) {
  if (keys.length <= NAMED_KEYS + 1) return LIST_FORMAT.format(keys);
  return LIST_FORMAT.format([...keys.slice(0, NAMED_KEYS), `${keys.length - NAMED_KEYS} more`]);
}

// Why a worklog wasn't moved, on its row (it's still there to show it on).
export const NOT_MOVED_REASONS = {
  SUBMISSION_IN_PROGRESS: "Not moved: it's being submitted to Jira. Try again once that's done.",
  STORAGE: "Not moved: the change couldn't be saved in this browser. Try again in a moment."
};

/**
 * Why the worklogs a change refused weren't moved, naming them by issue key.
 * @param {Array<{ id: string, code: string, issueKey?: string }>} refused
 * @param {boolean} single - The change was for one worklog
 * @param {(id: string) => string | undefined} keyOf - An ID's issue key, as shown
 * @returns {string}
 */
function refusalReasons(refused, single, keyOf) {
  const keys = (code) => refused.filter((r) => (r.code === 'PENDING_NOT_FOUND') === (code === 'gone'))
    .map((r) => r.issueKey || keyOf(r.id) || 'a worklog');
  const gone = keys('gone');
  const submitting = keys('submitting');
  if (single) {
    return gone.length
      ? "It's no longer pending: it was submitted or discarded in another tab."
      : "It's being submitted to Jira. Try again once that's done.";
  }
  const sentences = [];
  if (submitting.length) {
    sentences.push(`${nameKeys(submitting)} ${submitting.length === 1 ? 'is' : 'are'} being submitted to Jira, so ${submitting.length === 1 ? 'it stays' : 'they stay'} selected.`);
  }
  if (gone.length) {
    sentences.push(`${nameKeys(gone)} ${gone.length === 1 ? 'is' : 'are'} no longer pending (submitted or discarded in another tab).`);
  }
  return sentences.join(' ');
}

/**
 * Files pending worklogs under a classification, and says how it went. Nothing goes to Jira.
 *
 * - done: every worklog is under it now (moved, or there already)
 * - partial: some moved, and `refused` says why the others didn't
 * - failed: none moved: storage failed (nothing changed), or every one was refused
 *
 * `keep` is what should stay selected afterwards: nothing once done; the worklogs that weren't
 * moved and still exist otherwise (all of them when storage failed), so a failure never drops
 * what the user chose, and never reads as success. `failures` says why each of those wasn't
 * moved, for its row. The message and detail name the worklogs that weren't moved by issue key.
 *
 * @param {object} options
 * @param {(ids: string[], to: string) => Promise<{ classified: object[], unchanged: object[],
 *   refused: Array<{ id: string, code: string, issueKey?: string }> }>} options.classify - The timer
 *   controller's classifyPending()
 * @param {Array<object>} options.entries - `timeTracking.pending`, as shown, for the issue keys
 * @param {string[]} options.ids
 * @param {'ready' | 'on-hold' | 'archived'} options.to
 * @returns {Promise<{ status: 'done' | 'partial' | 'failed', moved: object[], refused: object[],
 *   keep: string[], failures: Array<{ id: string, issueKey: string, reason: string }>, message: string, detail: string }>}
 */
export async function classifyPendingWorklogs({ classify, entries, ids, to }) {
  const label = classificationLabel(to);
  const keyOf = (id) => (entries ?? []).find((entry) => entry.id === id)?.issueKey;
  const one = ids.length === 1 ? keyOf(ids[0]) : null;
  const failMessage = one ? `Couldn't move ${one} to ${label}` : `Couldn't move ${plural(ids.length, 'worklog')} to ${label}`;

  let result;
  try {
    result = await classify(ids, to);
  } catch (err) {
    return {
      status: 'failed', moved: [], refused: [], keep: [...ids],
      failures: ids.map((id) => ({ id, issueKey: keyOf(id) ?? '', reason: NOT_MOVED_REASONS.STORAGE })),
      message: failMessage,
      detail: err?.message || "Couldn't save the change in the browser's storage, so nothing changed."
    };
  }

  const { classified = [], unchanged = [], refused = [] } = result ?? {};
  // Refused but still there (being submitted): kept selected, to try again.
  const kept = refused.filter((r) => r.code !== 'PENDING_NOT_FOUND');
  const keep = kept.map((r) => r.id);
  const failures = kept.map((r) => ({ id: r.id, issueKey: r.issueKey || keyOf(r.id) || '', reason: NOT_MOVED_REASONS[r.code] ?? NOT_MOVED_REASONS.SUBMISSION_IN_PROGRESS }));
  const settled = classified.length + unchanged.length;

  if (refused.length === 0) {
    const message = one
      ? `Moved ${one} to ${label}`
      : `Moved ${plural(settled, 'worklog')} to ${label}`;
    return { status: 'done', moved: classified, refused, keep: [], failures: [], message, detail: '' };
  }
  if (settled === 0) {
    return {
      status: 'failed', moved: [], refused, keep, failures,
      message: failMessage,
      detail: refusalReasons(refused, Boolean(one), keyOf)
    };
  }
  return {
    status: 'partial', moved: classified, refused, keep, failures,
    message: `Moved ${settled} of ${plural(ids.length, 'worklog')} to ${label}`,
    detail: refusalReasons(refused, false, keyOf)
  };
}

/**
 * Updates the selection after a bulk change (classifyPendingWorklogs()'s outcome), and says what to
 * show about the worklogs it didn't move. The selected tab never changes: the moved worklogs just
 * leave it.
 *
 * - done: selection mode closes, clearing the selection, so no Done is needed
 * - partial or failed: selection mode stays, and only the worklogs that weren't moved and still
 *   exist stay selected, to try again
 *
 * @param {ReturnType<typeof createPendingSelection>} selection
 * @param {{ status: string, keep: string[], failures: Array<{ id: string, issueKey: string, reason: string }>,
 *   message: string, detail: string }} outcome
 * @returns {{ items: Array<{ id: string, issueKey: string, reason: string }>, notice: string } | null} The
 *   worklogs not moved (flagged on their rows) and what happened (in the selection bar); null once done
 */
export function settleBulkSelection(selection, outcome) {
  if (outcome.status === 'done') {
    selection.setSelecting(false);
    return null;
  }
  selection.keepOnly(outcome.keep);
  return { items: outcome.failures, notice: `${outcome.message}. ${outcome.detail}` };
}
