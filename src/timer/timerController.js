/**
 * Connects the timer engine (src/timer/timeTrackingStore.js) to a page: loads the stored state,
 * starts and stops timers through the store, follows changes other tabs make, and runs the one
 * clock that refreshes elapsed times on screen. No DOM: the page controller renders the states and
 * ticks this reports.
 *
 * Storage is the source of truth. The state shown is always the last one read from storage (or
 * written by this page's own change), never one the page works out itself; a change made in
 * another tab arrives as a storage change, which is answered with a read, never a write.
 */

import { TIME_TRACKING_KEY, isPaused } from './timeTrackingStore.js';

// What the user is told for each timer engine error (TimeTrackingError codes).
const ERROR_MESSAGES = {
  LOCK_UNAVAILABLE: "This browser can't coordinate the timer between open tabs, so the timer is turned off.",
  UNSUPPORTED_VERSION: 'The saved timer data comes from another version of Timesheet for Jira, so this version ' +
    "can't safely use it. It's been left as it is; update the extension to use the timer.",
  INVALID_ISSUE: "This issue can't be timed: Jira didn't give it a valid issue key."
};

// Engine errors whose own message is written for users (it names the issue or says what happened).
const OWN_MESSAGE_CODES = new Set([
  'PENDING_EXISTS', 'PENDING_NOT_FOUND', 'PENDING_CHANGED', 'INVALID_PENDING',
  'SUBMISSION_IN_PROGRESS', 'SUBMISSION_UNCERTAIN', 'TOO_SHORT', 'OTHER_SITE'
]);

// Errors that leave the timer unusable until the page is reloaded (or the data changes).
const UNAVAILABLE_CODES = new Set(['LOCK_UNAVAILABLE', 'UNSUPPORTED_VERSION']);

/**
 * The message to show for a timer error. Storage failures get a general message: their own text
 * is the browser's, not written for users.
 *
 * @param {Error} err
 * @param {'read' | 'change'} operation
 * @returns {string}
 */
export function timerErrorMessage(err, operation) {
  if (OWN_MESSAGE_CODES.has(err?.code)) return err.message;
  if (ERROR_MESSAGES[err?.code]) return ERROR_MESSAGES[err.code];
  return operation === 'read'
    ? "Couldn't read the timer from the browser's storage. Try again in a moment."
    : "Couldn't save the timer in the browser's storage, so nothing changed. Try again in a moment.";
}

/**
 * @param {object} options
 * @param {() => object} options.createStore - Creates the timer store; may throw (no Web Locks)
 * @param {(listener: (changes: object) => void) => () => void} options.watchStorage - Subscribes
 *   to storage.local changes; returns the unsubscribe function
 * @param {(state: object) => void} options.onChange - Called with each new state (see getState())
 * @param {() => void} options.onTick - Called about once a second while a timer runs and the page is active
 * @param {(message: string) => void} options.onError - Shows a user-facing error message
 * @param {(err: Error) => void} [options.logError=console.error]
 * @param {Function} [options.setInterval=globalThis.setInterval]
 * @param {Function} [options.clearInterval=globalThis.clearInterval]
 * @param {number} [options.tickMs=1000]
 */
export function createTimerController({
  createStore,
  watchStorage,
  onChange,
  onTick,
  onError,
  logError = (err) => console.error('Timer error:', err),
  setInterval = (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval = (id) => globalThis.clearInterval(id),
  tickMs = 1000
}) {
  let store = null;
  let unsubscribe = null;
  let initialized = false;
  let disposed = false;
  let active = true;
  let ticker = null;
  // Each read gets a number; only the latest read's answer is shown, so a slow, older read never
  // replaces a newer state.
  let readCount = 0;

  // status: 'loading' until the first read; 'ready'; 'error' after a failed read (the last state
  // read stays, and changes are still possible); 'unavailable' when the timer can't be used.
  let state = { status: 'loading', tracking: null, busy: false, message: '' };

  function emit(next) {
    state = { ...state, ...next };
    syncTicker();
    onChange(state);
  }

  /** Runs the clock only while a timer runs (not paused) and the page is active, with one interval at most. */
  function syncTicker() {
    const running = state.tracking?.running;
    const shouldTick = !disposed && active && Boolean(running) && !isPaused(running);
    if (shouldTick && ticker === null) {
      ticker = setInterval(() => onTick(), tickMs);
    } else if (!shouldTick && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  /**
   * Logs a failure (expected refusals, such as a pending worklog, aren't faults) and returns its
   * message; `notify` also shows it.
   */
  function report(err, operation, notify = true) {
    const message = timerErrorMessage(err, operation);
    if (!OWN_MESSAGE_CODES.has(err?.code)) logError(err);
    if (notify) onError(message);
    return message;
  }

  /** Shows the stored state: a read only, never a write. */
  async function refresh() {
    if (!store || disposed) return;
    const read = ++readCount;
    try {
      const tracking = await store.load();
      if (read !== readCount || disposed) return;
      emit({ status: 'ready', tracking, message: '' });
    } catch (err) {
      if (read !== readCount || disposed) return;
      const message = report(err, 'read');
      emit(UNAVAILABLE_CODES.has(err?.code)
        ? { status: 'unavailable', tracking: null, message }
        : { status: 'error', message });
    }
  }

  /**
   * Runs a change through the store. Shows the state it wrote, then reads storage again, since
   * another tab may have changed it since; after a failure, shows what storage holds.
   *
   * By default a failure is shown with onError() and this resolves to false. With `rethrow`, it
   * rejects with an Error carrying the user-facing message instead, for a panel or dialog that
   * shows the error itself and stays open.
   *
   * With `queue`, the change runs even while another is in progress (the lock serializes them):
   * for recording a submission's outcome, which must never be dropped like a second click.
   *
   * @param {() => Promise<{ state: object }>} change
   * @param {{ rethrow?: boolean, queue?: boolean }} [options]
   * @returns {Promise<object | false>} The store's result once the change is stored, or false
   */
  async function mutate(change, { rethrow = false, queue = false } = {}) {
    const refuse = (message) => {
      if (rethrow) throw new Error(message);
      onError(message);
      return false;
    };
    if (state.status === 'unavailable') return refuse(state.message);
    if (!store || disposed) return false;
    if (state.busy && !queue) {
      if (rethrow) throw new Error('The timer is busy with another change. Try again in a moment.');
      return false;
    }

    emit({ busy: true });
    let failure = null;
    let result = null;
    try {
      result = await change();
      if (disposed) return result;
      // Supersede any read still in flight: it may predate this change.
      readCount++;
      emit({ busy: false, status: 'ready', tracking: result.state, message: '' });
    } catch (err) {
      if (disposed) return false;
      const message = report(err, 'change', !rethrow);
      emit(UNAVAILABLE_CODES.has(err?.code)
        ? { busy: false, status: 'unavailable', tracking: null, message }
        : { busy: false });
      failure = new Error(message);
      failure.code = err?.code;
    }
    await refresh();
    if (failure && rethrow) throw failure;
    return failure ? false : result;
  }

  /** mutate() for start, stop, pause, and resume: true once stored, false after a shown failure. */
  const act = async (change) => Boolean(await mutate(change));

  function onStorageChange(changes) {
    if (changes && Object.prototype.hasOwnProperty.call(changes, TIME_TRACKING_KEY)) refresh();
  }

  return {
    /**
     * The current state: `status`, `tracking` (the stored { running, pending }, or null before the
     * first read), `busy` while a start or stop is in progress, and `message` when unavailable or
     * after a failed read.
     */
    getState: () => state,

    /**
     * Creates the store, follows storage changes, and loads the stored state. Calling it again only
     * reloads: there's never more than one listener.
     * @returns {Promise<void>}
     */
    async init() {
      if (disposed) return;
      if (initialized) return refresh();
      initialized = true;

      try {
        store = createStore();
      } catch (err) {
        const message = report(err, 'read');
        emit({ status: 'unavailable', tracking: null, message });
        return;
      }
      unsubscribe = watchStorage(onStorageChange);
      await refresh();
    },

    /**
     * Starts a timer on an issue; a timer on another issue stops and becomes a pending worklog.
     * Ignored while another change is in progress; a failure is shown with onError().
     * @param {{ site: string, issueId?: string, issueKey: string, issueSummary?: string }} issue
     * @returns {Promise<boolean>} True once the timer is running
     */
    start: (issue) => act(() => store.start(issue)),

    /**
     * Stops the running timer, keeping its session as a pending worklog. Nothing goes to Jira.
     * @returns {Promise<boolean>}
     */
    stop: () => act(() => store.stop()),

    /**
     * Pauses the running timer, banking its active time; it stays the current timer.
     * @returns {Promise<boolean>}
     */
    pause: () => act(() => store.pause()),

    /**
     * Resumes the paused timer; the time it was paused doesn't count.
     * @returns {Promise<boolean>}
     */
    resume: () => act(() => store.resume()),

    /**
     * Changes a pending worklog in this browser only (see timeTrackingStore's updatePending()).
     * Rejects with a user-facing Error, for the panel to show.
     * @param {string} id
     * @param {{ startedAt?: number, timeSpentSeconds?: number, comment?: string }} changes
     * @param {object} [expected] - The pending worklog as the edit started from it
     * @returns {Promise<boolean>}
     */
    updatePending: async (id, changes, expected) => Boolean(await mutate(() => store.updatePending(id, changes, expected), { rethrow: true })),

    /**
     * Removes a pending worklog from this browser only. Rejects with a user-facing Error, for the
     * confirmation to show.
     * @param {string} id
     * @returns {Promise<boolean>}
     */
    discardPending: async (id) => Boolean(await mutate(() => store.discardPending(id), { rethrow: true })),

    /**
     * Marks a pending worklog as being submitted (see timeTrackingStore's beginSubmission()).
     * Rejects with a user-facing Error when it can't be submitted.
     * @param {string} id
     * @param {{ site: string, expected?: object }} options
     * @returns {Promise<{ entry: object, previous: null | 'failed' | 'uncertain' }>}
     */
    beginSubmission: async (id, options) => {
      const { entry, previous } = await mutate(() => store.beginSubmission(id, options), { rethrow: true });
      return { entry, previous };
    },

    /**
     * Removes a submitted pending worklog, once Jira has it. Runs even while another change is in
     * progress. Rejects with a user-facing Error when storage fails.
     * @param {string} id
     * @returns {Promise<boolean>}
     */
    completeSubmission: async (id) => Boolean(await mutate(() => store.completeSubmission(id), { rethrow: true, queue: true })),

    /**
     * Records a failed or uncertain submission, keeping the pending worklog. Runs even while
     * another change is in progress.
     * @param {string} id
     * @param {{ uncertain: boolean, message?: string }} outcome
     * @returns {Promise<boolean>}
     */
    failSubmission: async (id, outcome) => Boolean(await mutate(() => store.failSubmission(id, outcome), { rethrow: true, queue: true })),

    /**
     * Pauses the clock while the page is hidden; showing it again updates the times at once.
     * @param {boolean} isActive
     */
    setActive(isActive) {
      active = Boolean(isActive);
      syncTicker();
      if (active && ticker !== null) onTick();
    },

    /** Stops following storage and the clock. */
    dispose() {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      syncTicker();
    }
  };
}
