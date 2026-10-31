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
 * across browser restarts. A timer can be paused: the active time so far is banked, and the time
 * spent paused never counts. No DOM and no network access; the storage area, lock, clock, and ID
 * generator are injected.
 *
 * Stored shape (`version` 2):
 * - running: null, or { id, site, issueId, issueKey, issueSummary, startedAt, accumulatedMs, resumedAt }
 *   `startedAt` is the session's start (the worklog's start in Jira); `accumulatedMs` the active time
 *   banked by pauses; `resumedAt` when the current active stretch began, or null while paused.
 * - pending: [{ id, site, issueId, issueKey, issueSummary, startedAt, stoppedAt, timeSpentSeconds, comment,
 *   submission? }] `submission` is set while a submission to Jira runs or after one didn't succeed:
 *   { state: 'submitting' | 'failed' | 'uncertain', at, message? } (see submissionStatus()).
 * Timestamps are epoch milliseconds, durations whole seconds unless named Ms. `site` is
 * `${deploymentType}|${baseUrl}` (siteId()). `issueId` is Jira's numeric ID, or '' when it isn't known.
 *
 * Version 1 (before pausing and submission) is read as version 2: its timer ran from its start
 * with nothing banked (accumulatedMs 0, resumedAt = startedAt), and its pending worklogs have no
 * submission. It's written back as version 2 on the next change only; reading never writes. An
 * older build reading version 2 refuses it (UNSUPPORTED_VERSION) rather than overwriting it.
 */

export const TIME_TRACKING_KEY = 'timeTracking';
export const TIME_TRACKING_VERSION = 2;
// Stored versions this build reads (and writes back as TIME_TRACKING_VERSION).
const READABLE_VERSIONS = new Set([1, 2]);

// A submission still marked as running this long after it began can't still be waiting for Jira
// (requests time out after 15 seconds): its page closed mid-request, and Jira may have the worklog.
export const STALE_SUBMISSION_MS = 2 * 60 * 1000;

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
 * - UNSUPPORTED_VERSION: the stored state is from another version of the extension, so it's
 *   neither read nor overwritten
 * - PENDING_NOT_FOUND: the pending worklog is no longer stored (discarded or submitted elsewhere)
 * - PENDING_CHANGED: the pending worklog changed since it was opened for editing, so the edit
 *   isn't applied over the newer values
 * - INVALID_PENDING: the edited values aren't a valid start, duration, or comment
 * - SUBMISSION_IN_PROGRESS: the pending worklog is being submitted to Jira (in this tab or another)
 * - SUBMISSION_UNCERTAIN: Jira may already have the pending worklog (a submission's outcome is
 *   unknown), so it can't be edited; submitting it again checks Jira first
 * - TOO_SHORT: the pending worklog is under a minute, which Jira doesn't accept
 * - OTHER_SITE: the pending worklog was tracked on another Jira site than the one it's submitted to
 */
export class TimeTrackingError extends Error {
  /**
   * @param {string} message
   * @param {'LOCK_UNAVAILABLE' | 'INVALID_ISSUE' | 'UNSUPPORTED_VERSION' |
   *   'PENDING_NOT_FOUND' | 'PENDING_CHANGED' | 'INVALID_PENDING' | 'SUBMISSION_IN_PROGRESS' |
   *   'SUBMISSION_UNCERTAIN' | 'TOO_SHORT' | 'OTHER_SITE'} code
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

/** @returns {{ version: 2, running: null, pending: [] }} */
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
 * @returns {object | null} A valid running timer, or null. A version 1 timer (no pause fields) ran
 *   from its start with nothing banked.
 */
function toRunning(raw) {
  const base = toRecordBase(raw);
  if (!base) return null;
  const accumulatedMs = raw.accumulatedMs ?? 0;
  const resumedAt = raw.resumedAt === undefined ? base.startedAt : raw.resumedAt;
  if (!Number.isSafeInteger(accumulatedMs) || accumulatedMs < 0) return null;
  if (resumedAt !== null && !isTimestamp(resumedAt)) return null;
  return { ...base, accumulatedMs, resumedAt };
}

const SUBMISSION_STATES = new Set(['submitting', 'failed', 'uncertain']);

/**
 * A pending worklog's submission record, or undefined without one. A damaged record may stand for
 * a submission that reached Jira, so it reads as uncertain, never as none.
 * @param {unknown} raw
 * @returns {{ state: string, at: number, message?: string } | undefined}
 */
function toSubmission(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (SUBMISSION_STATES.has(raw?.state) && isTimestamp(raw.at) && (raw.message === undefined || typeof raw.message === 'string')) {
    return raw.message === undefined ? { state: raw.state, at: raw.at } : { state: raw.state, at: raw.at, message: raw.message };
  }
  return { state: 'uncertain', at: isTimestamp(raw?.at) ? raw.at : 1 };
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
  const submission = toSubmission(raw.submission);
  const entry = { ...base, stoppedAt, timeSpentSeconds, comment };
  if (submission) entry.submission = submission;
  return entry;
}

/**
 * Normalizes the stored `timeTracking` value, as version 2 (a version 1 value reads as version 2;
 * see the module comment). A missing or malformed value gives the empty state. A malformed running
 * timer becomes null, and malformed pending worklogs (or a repeated ID) are left out, keeping the
 * valid ones.
 *
 * A value that declares any other version throws instead: it may be a newer extension's timers
 * and pending worklogs, which an empty state would let the next change overwrite.
 *
 * @param {unknown} value
 * @returns {{ version: 2, running: object | null, pending: Array<object> }}
 * @throws {TimeTrackingError} UNSUPPORTED_VERSION
 */
export function normalizeTimeTracking(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyTimeTracking();
  if ('version' in value && !READABLE_VERSIONS.has(value.version)) {
    throw new TimeTrackingError(
      'The saved timer data is from another version of Timesheet for Jira. Update the extension to use the timer.',
      'UNSUPPORTED_VERSION');
  }
  if (!READABLE_VERSIONS.has(value.version)) return emptyTimeTracking();

  const seen = new Set();
  const pending = (Array.isArray(value.pending) ? value.pending : [])
    .map(toPending)
    .filter((entry) => entry && !seen.has(entry.id) && seen.add(entry.id));

  return { version: TIME_TRACKING_VERSION, running: toRunning(value.running), pending };
}

/**
 * Whole seconds a timer has been active up to `now`: the time banked by pauses, plus the current
 * stretch unless it's paused. Time spent paused never counts, and a clock moved back adds nothing,
 * never a negative time. A timer without pause fields (version 1) runs from its start.
 *
 * @param {{ startedAt: number, accumulatedMs?: number, resumedAt?: number | null } | null} running
 * @param {number} [now=Date.now()] - Epoch milliseconds
 * @returns {number}
 */
export function elapsedSeconds(running, now = Date.now()) {
  if (!running) return 0;
  const resumedAt = running.resumedAt === undefined ? running.startedAt : running.resumedAt;
  const current = resumedAt === null ? 0 : Math.max(0, now - resumedAt);
  return Math.floor(((running.accumulatedMs ?? 0) + current) / 1000);
}

/**
 * True when the running timer is paused.
 * @param {{ resumedAt?: number | null } | null} running
 * @returns {boolean}
 */
export function isPaused(running) {
  return Boolean(running) && running.resumedAt === null;
}

/**
 * A pending worklog's submission state: null (never submitted), 'submitting' (a page is waiting for
 * Jira), 'failed' (Jira refused it; nothing was created), or 'uncertain' (Jira may have it: the
 * answer never came, or a submission was left running past STALE_SUBMISSION_MS).
 *
 * @param {{ submission?: { state: string, at: number } }} entry
 * @param {number} [now=Date.now()]
 * @returns {null | 'submitting' | 'failed' | 'uncertain'}
 */
export function submissionStatus(entry, now = Date.now()) {
  const submission = entry?.submission;
  if (!submission) return null;
  if (submission.state === 'submitting' && now - submission.at > STALE_SUBMISSION_MS) return 'uncertain';
  return submission.state;
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
 * True when starting the issue would start (or resume) its timer: it isn't the one already
 * running. Another issue's timer doesn't prevent it (starting stops that one), and neither do the
 * issue's pending worklogs: each timer session becomes a pending worklog of its own.
 *
 * @param {{ running: object | null }} state
 * @param {{ site: string, issueId?: string, issueKey: string }} issue
 * @returns {boolean}
 */
export function canStart(state, issue) {
  return !(state.running && isSameIssue(state.running, issue) && !isPaused(state.running));
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
     * Starts a timer on an issue. A timer running (or paused) on another issue stops first,
     * becoming a pending worklog of its active time, in the same write. Starting the issue already
     * running changes nothing; starting it while paused resumes it. The issue's pending worklogs
     * don't matter: the new session is a separate one, and becomes a pending worklog of its own.
     *
     * @param {{ site: string, issueId?: string | number, issueKey: string, issueSummary?: string }} issue
     * @returns {Promise<{ state: object, running: object, stopped: object | null }>} `stopped` is the
     *   pending worklog of the timer this one replaced
     * @throws {TimeTrackingError} INVALID_ISSUE
     */
    async start(issue) {
      const timed = toTimedIssue(issue);
      return transition((state) => {
        if (state.running && isSameIssue(state.running, timed)) {
          // Starting the paused issue resumes it.
          if (isPaused(state.running)) {
            const running = { ...state.running, resumedAt: now() };
            return { state: { ...state, running }, running, stopped: null };
          }
          return { running: state.running, stopped: null };
        }
        const at = now();
        const stopped = state.running ? toStoppedSession(state.running, at) : null;
        const running = { id: newId(), ...timed, startedAt: at, accumulatedMs: 0, resumedAt: at };
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
    },

    /**
     * Pauses the running timer: its active time so far is banked, and it stays the current timer
     * (not a pending worklog) until resumed or stopped. Paused or no timer: nothing changes.
     * @returns {Promise<{ state: object, paused: object | null }>}
     */
    pause() {
      return transition((state) => {
        const running = state.running;
        if (!running || isPaused(running)) return { paused: null };
        const paused = {
          ...running,
          accumulatedMs: running.accumulatedMs + Math.max(0, now() - running.resumedAt),
          resumedAt: null
        };
        return { state: { ...state, running: paused }, paused };
      });
    },

    /**
     * Resumes the paused timer: active time counts again from now, on top of what's banked.
     * Running or no timer: nothing changes.
     * @returns {Promise<{ state: object, resumed: object | null }>}
     */
    resume() {
      return transition((state) => {
        if (!isPaused(state.running)) return { resumed: null };
        const resumed = { ...state.running, resumedAt: now() };
        return { state: { ...state, running: resumed }, resumed };
      });
    },

    /**
     * Changes a pending worklog's start, duration, or comment, keeping its ID, issue, and place in
     * the list; the other pending worklogs and the running timer stay as they are. Its stop time
     * follows the start and duration. Nothing goes to Jira.
     *
     * A duration under a minute is kept (isTooShort() flags it). With `expected`, the edit applies
     * only while the stored values still match it, so an edit made in another tab meanwhile isn't
     * silently overwritten.
     *
     * @param {string} id
     * @param {{ startedAt?: number, timeSpentSeconds?: number, comment?: string }} changes
     * @param {{ startedAt: number, timeSpentSeconds: number, comment: string }} [expected] - The values the
     *   edit started from
     * @returns {Promise<{ state: object, updated: object }>}
     * @throws {TimeTrackingError} INVALID_PENDING, PENDING_NOT_FOUND, or PENDING_CHANGED
     */
    async updatePending(id, changes, expected) {
      const { startedAt, timeSpentSeconds, comment } = changes ?? {};
      if ((startedAt !== undefined && !isTimestamp(startedAt)) ||
          (timeSpentSeconds !== undefined && (!Number.isSafeInteger(timeSpentSeconds) || timeSpentSeconds < 0)) ||
          (comment !== undefined && typeof comment !== 'string')) {
        throw new TimeTrackingError('Enter a valid date, start time, and duration.', 'INVALID_PENDING');
      }

      return transition((state) => {
        const current = state.pending.find((entry) => entry.id === id);
        if (!current) throw pendingNotFound();
        refuseWhileSubmitted(current, now());
        if (expected && changedSince(current, expected)) {
          throw new TimeTrackingError(
            'This pending worklog was changed in another tab, so your edit wasn\'t saved. Open it again to see the latest values.',
            'PENDING_CHANGED');
        }

        const next = { ...current };
        // A refused submission created nothing in Jira; after an edit, it no longer describes this worklog.
        delete next.submission;
        if (startedAt !== undefined) next.startedAt = startedAt;
        if (timeSpentSeconds !== undefined) next.timeSpentSeconds = timeSpentSeconds;
        if (comment !== undefined) next.comment = comment;
        // Keeps the record valid (a stop never before its start) wherever the start moved.
        next.stoppedAt = next.startedAt + next.timeSpentSeconds * 1000;

        return {
          state: { ...state, pending: state.pending.map((entry) => (entry.id === id ? next : entry)) },
          updated: next
        };
      });
    },

    /**
     * Removes one pending worklog from this browser, by its ID. The other pending worklogs and the
     * running timer stay as they are. Nothing goes to Jira.
     *
     * @param {string} id
     * @returns {Promise<{ state: object, discarded: object }>}
     * @throws {TimeTrackingError} PENDING_NOT_FOUND when it's no longer stored
     */
    discardPending(id) {
      return transition((state) => {
        const discarded = state.pending.find((entry) => entry.id === id);
        if (!discarded) throw pendingNotFound();
        return { state: { ...state, pending: state.pending.filter((entry) => entry.id !== id) }, discarded };
      });
    },

    /**
     * Marks a pending worklog as being submitted to Jira, before the request, so no other tab (or
     * a second click) submits it at the same time. Refused when it's being submitted already, is
     * under a minute, belongs to another Jira site, or changed since the user chose to submit it.
     * Nothing is removed until completeSubmission().
     *
     * @param {string} id
     * @param {object} options
     * @param {string} options.site - The connected Jira site's ID
     * @param {{ startedAt: number, timeSpentSeconds: number, comment: string }} [options.expected] - The
     *   values the user chose to submit
     * @returns {Promise<{ state: object, entry: object, previous: null | 'failed' | 'uncertain' }>} `entry`
     *   is the stored worklog to send; `previous` its state before, 'uncertain' meaning Jira may have
     *   it already (check before sending)
     * @throws {TimeTrackingError} PENDING_NOT_FOUND, SUBMISSION_IN_PROGRESS, OTHER_SITE, TOO_SHORT, or PENDING_CHANGED
     */
    beginSubmission(id, { site, expected } = {}) {
      return transition((state) => {
        const current = state.pending.find((entry) => entry.id === id);
        if (!current) throw pendingNotFound();
        const at = now();
        const previous = submissionStatus(current, at);
        if (previous === 'submitting') {
          throw new TimeTrackingError(`${current.issueKey}'s worklog is already being submitted.`, 'SUBMISSION_IN_PROGRESS');
        }
        if (current.site !== site) {
          throw new TimeTrackingError(
            `This worklog was tracked on ${siteHost(current.site)}, not the Jira site you're connected to, so it can't be submitted here.`,
            'OTHER_SITE');
        }
        if (isTooShort(current)) {
          throw new TimeTrackingError('Jira needs a worklog of at least 1 minute. Edit the duration before submitting it.', 'TOO_SHORT');
        }
        if (expected && changedSince(current, expected)) {
          throw new TimeTrackingError('This pending worklog was changed in another tab. Check it, then submit it again.', 'PENDING_CHANGED');
        }
        const entry = { ...current, submission: { state: 'submitting', at } };
        return {
          state: { ...state, pending: state.pending.map((p) => (p.id === id ? entry : p)) },
          entry,
          previous
        };
      });
    },

    /**
     * Removes a pending worklog once Jira has it (it confirmed the submission, or already had it).
     * Already gone (discarded meanwhile): nothing changes.
     * @param {string} id
     * @returns {Promise<{ state: object, completed: object | null }>}
     */
    completeSubmission(id) {
      return transition((state) => {
        const completed = state.pending.find((entry) => entry.id === id) || null;
        if (!completed) return { completed: null };
        return { state: { ...state, pending: state.pending.filter((entry) => entry.id !== id) }, completed };
      });
    },

    /**
     * Records a submission that didn't succeed, keeping the pending worklog: 'failed' when Jira
     * refused it (nothing was created), 'uncertain' when Jira may have it (no answer came).
     * Already gone: nothing changes.
     * @param {string} id
     * @param {{ uncertain: boolean, message?: string }} outcome
     * @returns {Promise<{ state: object, failed: object | null }>}
     */
    failSubmission(id, { uncertain, message } = {}) {
      return transition((state) => {
        const current = state.pending.find((entry) => entry.id === id);
        if (!current) return { failed: null };
        const submission = { state: uncertain ? 'uncertain' : 'failed', at: now() };
        if (typeof message === 'string' && message) submission.message = message;
        const failed = { ...current, submission };
        return { state: { ...state, pending: state.pending.map((p) => (p.id === id ? failed : p)) }, failed };
      });
    }
  };
}

/** True when a pending worklog's values differ from the ones a user acted on. */
function changedSince(entry, expected) {
  return ['startedAt', 'timeSpentSeconds', 'comment'].some((field) => entry[field] !== expected[field]);
}

/** Refuses a change to a pending worklog that's being submitted, or that Jira may already have. */
function refuseWhileSubmitted(entry, now) {
  const status = submissionStatus(entry, now);
  if (status === 'submitting') {
    throw new TimeTrackingError(`${entry.issueKey}'s worklog is being submitted, so it can't be changed now.`, 'SUBMISSION_IN_PROGRESS');
  }
  if (status === 'uncertain') {
    throw new TimeTrackingError(
      `Jira may already have ${entry.issueKey}'s worklog, so it can't be edited. Submit it again to check Jira, or discard it.`,
      'SUBMISSION_UNCERTAIN');
  }
}

function siteHost(site) {
  const baseUrl = String(site).slice(String(site).indexOf('|') + 1);
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function pendingNotFound() {
  return new TimeTrackingError(
    'This pending worklog is no longer here: it was discarded or changed in another tab.',
    'PENDING_NOT_FOUND');
}
