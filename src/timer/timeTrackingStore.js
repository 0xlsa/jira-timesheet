/**
 * Timer engine: the one running timer and the pending worklogs that stopped timers leave behind,
 * kept in local storage. Stopping a timer never sends anything to Jira; submitting a pending
 * worklog is a separate step.
 *
 * All state lives under one storage key, `timeTracking`, apart from the settings and credentials
 * (src/settings/settingsStore.js), so one write replaces it whole. That keeps each saved state
 * consistent, but doesn't stop two tabs from reading the same state and overwriting each other's
 * change: every change runs its read, change, and write inside one lock, held across all tabs of
 * the extension (Web Locks; see createTimeTrackingLock()).
 *
 * Elapsed time comes from timestamps, so a timer keeps counting while no page is open, including
 * across browser restarts. No DOM and no network access; the storage area, lock, clock, and ID
 * generator are injected.
 *
 * Stored shape (`version` 1):
 * - running: null, or { id, site, issueId, issueKey, issueSummary, startedAt }
 * - pending: [{ id, site, issueId, issueKey, issueSummary, startedAt, stoppedAt, timeSpentSeconds, comment }]
 * Timestamps are epoch milliseconds, durations whole seconds. `site` is `${deploymentType}|${baseUrl}`
 * (siteId()). `issueId` is Jira's numeric ID, or '' when it isn't known.
 */

export const TIME_TRACKING_KEY = 'timeTracking';
export const TIME_TRACKING_VERSION = 1;

// Name of the Web Lock every change holds, shared by all pages of the extension.
export const TIME_TRACKING_LOCK_NAME = 'jts-time-tracking';

// Shortest worklog Jira accepts (see JiraClient's worklog body); shorter sessions stay pending until edited.
export const MIN_WORKLOG_SECONDS = 60;

// Jira issue keys are PROJECTKEY-NUMBER (see src/jira/issueKeySearch.js).
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;
const ISSUE_ID = /^\d+$/;

/**
 * A timer engine error. `code` says what went wrong:
 * - LOCK_UNAVAILABLE: the browser has no Web Locks, so changes can't be made safely across tabs
 * - INVALID_ISSUE: the issue to time has no valid site, key, or ID
 * - PENDING_EXISTS: the issue already has a pending worklog, to submit or discard first
 * - UNSUPPORTED_VERSION: the stored state is from another version of the extension, so it's
 *   neither read nor overwritten
 */
export class TimeTrackingError extends Error {
  /**
   * @param {string} message
   * @param {'LOCK_UNAVAILABLE' | 'INVALID_ISSUE' | 'PENDING_EXISTS' | 'UNSUPPORTED_VERSION'} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'TimeTrackingError';
    this.code = code;
  }
}

/**
 * The Jira site a timer or pending worklog belongs to: issue IDs and keys only mean something on
 * their own site.
 *
 * @param {'cloud' | 'server'} deploymentType
 * @param {string} baseUrl - Validated Jira base URL, as JiraClient has it
 * @returns {string}
 */
export function siteId(deploymentType, baseUrl) {
  return `${deploymentType}|${baseUrl}`;
}

/** @returns {{ version: 1, running: null, pending: [] }} */
export function emptyTimeTracking() {
  return { version: TIME_TRACKING_VERSION, running: null, pending: [] };
}

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isTimestamp = (value) => Number.isSafeInteger(value) && value > 0;

/**
 * The fields every record shares, checked, or null when any is missing or malformed. A wrong
 * issue or site would send time to the wrong place, so nothing here is guessed or repaired.
 *
 * @param {object} raw
 * @returns {{ id: string, site: string, issueId: string, issueKey: string, issueSummary: string, startedAt: number } | null}
 */
function toRecordBase(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, site, issueId = '', issueKey, issueSummary = '', startedAt } = raw;
  if (!isText(id) || !isText(site) || typeof issueKey !== 'string' || !ISSUE_KEY.test(issueKey)) return null;
  if (typeof issueId !== 'string' || (issueId !== '' && !ISSUE_ID.test(issueId))) return null;
  if (typeof issueSummary !== 'string' || !isTimestamp(startedAt)) return null;
  return { id, site, issueId, issueKey, issueSummary, startedAt };
}

/**
 * @param {object} raw
 * @returns {object | null} A valid running timer, or null
 */
function toRunning(raw) {
  return toRecordBase(raw);
}

/**
 * @param {object} raw
 * @returns {object | null} A valid pending worklog, or null
 */
function toPending(raw) {
  const base = toRecordBase(raw);
  if (!base) return null;
  const { stoppedAt, timeSpentSeconds, comment = '' } = raw;
  if (!isTimestamp(stoppedAt) || stoppedAt < base.startedAt) return null;
  if (!Number.isSafeInteger(timeSpentSeconds) || timeSpentSeconds < 0 || typeof comment !== 'string') return null;
  return { ...base, stoppedAt, timeSpentSeconds, comment };
}

/**
 * Normalizes the stored `timeTracking` value. A missing or malformed value gives the empty state.
 * A malformed running timer becomes null, and malformed pending worklogs (or a repeated ID) are
 * left out, keeping the valid ones.
 *
 * A value that declares any other version throws instead: it may be a newer extension's timers
 * and pending worklogs, which an empty state would let the next change overwrite.
 *
 * @param {unknown} value
 * @returns {{ version: 1, running: object | null, pending: Array<object> }}
 * @throws {TimeTrackingError} UNSUPPORTED_VERSION
 */
export function normalizeTimeTracking(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyTimeTracking();
  if ('version' in value && value.version !== TIME_TRACKING_VERSION) {
    throw new TimeTrackingError(
      'The saved timer data is from another version of Timesheet for Jira. Update the extension to use the timer.',
      'UNSUPPORTED_VERSION');
  }
  if (value.version !== TIME_TRACKING_VERSION) return emptyTimeTracking();

  const seen = new Set();
  const pending = (Array.isArray(value.pending) ? value.pending : [])
    .map(toPending)
    .filter((entry) => entry && !seen.has(entry.id) && seen.add(entry.id));

  return { version: TIME_TRACKING_VERSION, running: toRunning(value.running), pending };
}

/**
 * Whole seconds a timer has run, from its start to `now`. A clock moved back gives 0, never a
 * negative time.
 *
 * @param {{ startedAt: number } | null} running
 * @param {number} [now=Date.now()] - Epoch milliseconds
 * @returns {number}
 */
export function elapsedSeconds(running, now = Date.now()) {
  if (!running) return 0;
  return Math.max(0, Math.floor((now - running.startedAt) / 1000));
}

/**
 * True when a pending worklog is shorter than Jira accepts: it stays pending until it's edited to
 * at least a minute.
 *
 * @param {{ timeSpentSeconds: number }} pending
 * @returns {boolean}
 */
export function isTooShort(pending) {
  return pending.timeSpentSeconds < MIN_WORKLOG_SECONDS;
}

/**
 * True when two records are the same issue on the same site: by Jira's issue ID when both have
 * it (it survives moving an issue to another project), otherwise by key.
 *
 * @param {{ site: string, issueId?: string, issueKey: string }} a
 * @param {{ site: string, issueId?: string, issueKey: string }} b
 * @returns {boolean}
 */
export function isSameIssue(a, b) {
  if (a.site !== b.site) return false;
  return a.issueId && b.issueId ? a.issueId === b.issueId : a.issueKey === b.issueKey;
}

/**
 * The issue's pending worklog, if it has one.
 *
 * @param {{ pending: Array<object> }} state
 * @param {{ site: string, issueId?: string, issueKey: string }} issue
 * @returns {object | null}
 */
export function findPending(state, issue) {
  return state.pending.find((entry) => isSameIssue(entry, issue)) || null;
}

/**
 * True when a timer can start on the issue: it isn't already running, and has no pending
 * worklog. Another issue's running timer doesn't prevent it; starting stops that one.
 *
 * @param {{ running: object | null, pending: Array<object> }} state
 * @param {{ site: string, issueId?: string, issueKey: string }} issue
 * @returns {boolean}
 */
export function canStart(state, issue) {
  if (state.running && isSameIssue(state.running, issue)) return false;
  return !findPending(state, issue);
}

/**
 * Checks the issue to time and keeps only the fields a timer stores (never anything else the
 * caller's object carries).
 *
 * @param {object} issue
 * @returns {{ site: string, issueId: string, issueKey: string, issueSummary: string }}
 */
function toTimedIssue(issue) {
  const site = issue?.site;
  const issueId = issue?.issueId == null ? '' : String(issue.issueId);
  const issueKey = issue?.issueKey;
  if (!isText(site) || typeof issueKey !== 'string' || !ISSUE_KEY.test(issueKey) || (issueId !== '' && !ISSUE_ID.test(issueId))) {
    throw new TimeTrackingError('A timer needs a Jira site and a valid issue key.', 'INVALID_ISSUE');
  }
  const issueSummary = typeof issue.issueSummary === 'string' ? issue.issueSummary : '';
  return { site, issueId, issueKey, issueSummary };
}

/**
 * The lock every change holds, shared by all pages of the extension through the Web Locks API
 * (`navigator.locks`), which Chrome and Firefox provide in extension pages. Without it, a change
 * can't be made safely across tabs, so this throws rather than settling for a lock that only one
 * tab would respect.
 *
 * @param {{ locks?: { request: Function } }} [nav=globalThis.navigator]
 * @returns {{ run: <T>(fn: () => Promise<T>) => Promise<T> }}
 * @throws {TimeTrackingError} LOCK_UNAVAILABLE
 */
export function createTimeTrackingLock(nav = globalThis.navigator) {
  const locks = nav?.locks;
  if (typeof locks?.request !== 'function') {
    throw new TimeTrackingError(
      "This browser can't coordinate the timer between open tabs (Web Locks are unavailable), so the timer is turned off.",
      'LOCK_UNAVAILABLE');
  }
  return {
    run: (fn) => locks.request(TIME_TRACKING_LOCK_NAME, () => fn())
  };
}

/**
 * @param {{ get: Function, set: Function }} storageArea - `storage.local`, or createMemoryStorageArea()
 * @param {object} options
 * @param {{ run: <T>(fn: () => Promise<T>) => Promise<T> }} options.lock - From createTimeTrackingLock();
 *   required, so changes are never made without one
 * @param {() => number} [options.now=Date.now] - Epoch milliseconds
 * @param {() => string} [options.newId] - Defaults to crypto.randomUUID()
 */
export function createTimeTrackingStore(storageArea, { lock, now = Date.now, newId = () => crypto.randomUUID() } = {}) {
  if (typeof lock?.run !== 'function') {
    throw new TypeError('createTimeTrackingStore() needs a lock (see createTimeTrackingLock()).');
  }

  async function read() {
    const raw = await storageArea.get(TIME_TRACKING_KEY);
    return normalizeTimeTracking(raw?.[TIME_TRACKING_KEY]);
  }

  /**
   * Reads the state, applies `change`, and writes the result if there is one, all inside the
   * lock. `change` returns { state, ...result } to write, or { ...result } alone to leave the
   * stored state as it is. A failed read or write rejects, and the stored state is unchanged;
   * so does stored state of an unsupported version, which is never overwritten.
   *
   * @param {(state: object) => object} change
   */
  function transition(change) {
    return lock.run(async () => {
      const current = await read();
      const { state, ...result } = change(current);
      if (!state) return { state: current, ...result };
      await storageArea.set({ [TIME_TRACKING_KEY]: state });
      return { state, ...result };
    });
  }

  /**
   * The pending worklog a running timer leaves when it stops at `stoppedAt`.
   * @param {object} running
   * @param {number} stoppedAt
   */
  function toStoppedSession(running, stoppedAt) {
    const { site, issueId, issueKey, issueSummary, startedAt } = running;
    // A clock moved back before the start ends the session at its start, with no time.
    const end = Math.max(stoppedAt, startedAt);
    return {
      id: newId(), site, issueId, issueKey, issueSummary, startedAt,
      stoppedAt: end,
      timeSpentSeconds: elapsedSeconds(running, end),
      comment: ''
    };
  }

  return {
    /**
     * The stored state. Reading needs no lock: a single key is always read whole.
     * @returns {Promise<{ version: 1, running: object | null, pending: Array<object> }>}
     * @throws {TimeTrackingError} UNSUPPORTED_VERSION
     */
    load: read,

    /**
     * Starts a timer on an issue. A timer running on another issue stops first, becoming a
     * pending worklog, in the same write. Starting the issue already running changes nothing.
     *
     * @param {{ site: string, issueId?: string | number, issueKey: string, issueSummary?: string }} issue
     * @returns {Promise<{ state: object, running: object, stopped: object | null }>} `stopped` is the
     *   pending worklog of the timer this one replaced
     * @throws {TimeTrackingError} INVALID_ISSUE, or PENDING_EXISTS when the issue has a pending worklog
     */
    async start(issue) {
      const timed = toTimedIssue(issue);
      return transition((state) => {
        if (state.running && isSameIssue(state.running, timed)) {
          return { running: state.running, stopped: null };
        }
        if (findPending(state, timed)) {
          throw new TimeTrackingError(
            `${timed.issueKey} already has a pending worklog. Submit or discard it before starting another timer.`,
            'PENDING_EXISTS');
        }

        const at = now();
        const stopped = state.running ? toStoppedSession(state.running, at) : null;
        const running = { id: newId(), ...timed, startedAt: at };
        return {
          state: { ...state, running, pending: stopped ? [...state.pending, stopped] : state.pending },
          running,
          stopped
        };
      });
    },

    /**
     * Stops the running timer, leaving a pending worklog. With no timer running, nothing changes.
     * @returns {Promise<{ state: object, stopped: object | null }>}
     */
    stop() {
      return transition((state) => {
        if (!state.running) return { stopped: null };
        const stopped = toStoppedSession(state.running, now());
        return { state: { ...state, running: null, pending: [...state.pending, stopped] }, stopped };
      });
    }
  };
}
