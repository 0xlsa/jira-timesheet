import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTimerController, timerErrorMessage } from '../src/timer/timerController.js';
import {
  TIME_TRACKING_KEY,
  TimeTrackingError,
  createTimeTrackingStore,
  siteId
} from '../src/timer/timeTrackingStore.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';

const SITE = siteId('cloud', 'https://acme.atlassian.net');
const ABC_1 = { site: SITE, issueId: '10001', issueKey: 'ABC-1', issueSummary: 'Fix the login page' };
const ABC_2 = { site: SITE, issueId: '10002', issueKey: 'ABC-2', issueSummary: 'Write the release notes' };

// Lets storage events, reads, and writes that are already under way finish.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A lock that runs one callback at a time, in call order. */
function createSerialLock() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const result = tail.then(() => fn());
      tail = result.catch(() => {});
      return result;
    }
  };
}

/** setInterval and clearInterval stand-ins that record what's running. */
function createFakeIntervals() {
  const active = new Map();
  let next = 0;
  return {
    active,
    created: 0,
    setInterval(fn) {
      this.created++;
      active.set(++next, fn);
      return next;
    },
    clearInterval(id) {
      active.delete(id);
    },
    fire() {
      for (const fn of active.values()) fn();
    }
  };
}

/**
 * One Timesheet for Jira page: a timer controller on the shared storage, with everything it
 * reports recorded.
 */
function createPage(storage, { lock = createSerialLock(), createStore, now = () => Date.UTC(2026, 9, 26, 9) } = {}) {
  const intervals = createFakeIntervals();
  const states = [];
  const errors = [];
  const logged = [];
  let ticks = 0;
  let listeners = 0;
  const store = createTimeTrackingStore(storage, { lock, now });

  const controller = createTimerController({
    createStore: createStore ?? (() => store),
    watchStorage: (listener) => {
      listeners++;
      // Pages share `storage`, as tabs share storage.local.
      const handler = (changes) => listener(changes);
      storage.onChanged.addListener(handler);
      return () => {
        listeners--;
        storage.onChanged.removeListener(handler);
      };
    },
    onChange: (state) => states.push(state),
    onTick: () => ticks++,
    onError: (message) => errors.push(message),
    logError: (err) => logged.push(err),
    setInterval: (fn, ms) => intervals.setInterval(fn, ms),
    clearInterval: (id) => intervals.clearInterval(id)
  });

  return {
    controller, store, intervals, states, errors, logged,
    get ticks() { return ticks; },
    get listeners() { return listeners; },
    get state() { return controller.getState(); }
  };
}

describe('Timer controller - loading', () => {
  it('starts out loading, with no timer controls to show yet', () => {
    const page = createPage(createMemoryStorageArea());
    assert.equal(page.state.status, 'loading');
    assert.equal(page.state.tracking, null);
  });

  it('restores a running timer from storage when the page opens, and starts the clock', async () => {
    const storage = createMemoryStorageArea();
    await createPage(storage).store.start(ABC_1);

    const reopened = createPage(storage);
    await reopened.controller.init();

    assert.equal(reopened.state.status, 'ready');
    assert.equal(reopened.state.tracking.running.issueKey, 'ABC-1');
    assert.equal(reopened.intervals.active.size, 1);
  });

  it('runs no clock when no timer is running', async () => {
    const page = createPage(createMemoryStorageArea());
    await page.controller.init();
    assert.equal(page.state.tracking.running, null);
    assert.equal(page.intervals.active.size, 0);
  });

  it('keeps one storage listener and one clock however often it is initialized', async () => {
    const storage = createMemoryStorageArea();
    await createPage(storage).store.start(ABC_1);
    const page = createPage(storage);

    await page.controller.init();
    await page.controller.init();
    await page.controller.init();

    assert.equal(page.listeners, 1);
    assert.equal(page.intervals.active.size, 1);
    assert.equal(page.intervals.created, 1);
  });

  it('explains a storage read failure, keeping the timer usable', async () => {
    const storage = createMemoryStorageArea();
    storage.get = async () => { throw new Error('IO error: LevelDB corruption at /home/user/profile'); };
    const page = createPage(storage);

    await page.controller.init();

    assert.equal(page.state.status, 'error');
    assert.equal(page.errors.length, 1);
    assert.match(page.errors[0], /Couldn't read the timer/);
    assert.doesNotMatch(page.errors[0], /LevelDB|profile/, 'the browser error itself is only logged');
    assert.equal(page.logged.length, 1);
  });
});

describe('Timer controller - unavailable timer', () => {
  it('turns the timer off when the browser has no Web Locks, explaining why on every attempt', async () => {
    const storage = createMemoryStorageArea();
    const page = createPage(storage, {
      createStore: () => { throw new TimeTrackingError('no locks', 'LOCK_UNAVAILABLE'); }
    });

    await page.controller.init();
    assert.equal(page.state.status, 'unavailable');
    assert.match(page.state.message, /can't coordinate the timer between open tabs/);
    assert.equal(page.listeners, 0);

    await page.controller.start(ABC_1);
    assert.equal(page.errors.length, 2);
    assert.deepEqual(await storage.get(TIME_TRACKING_KEY), {});
  });

  it('leaves timer data from another version as it is, and says why the timer is off', async () => {
    const newer = { version: 3, running: { issueKey: 'ABC-9', startedAt: 1 }, pending: [] };
    const storage = createMemoryStorageArea({ [TIME_TRACKING_KEY]: newer });
    const page = createPage(storage);

    await page.controller.init();
    assert.equal(page.state.status, 'unavailable');
    assert.match(page.state.message, /another version of Timesheet for Jira/);
    assert.match(page.state.message, /left as it is/);

    await page.controller.start(ABC_1);
    await page.controller.stop();
    assert.deepEqual((await storage.get(TIME_TRACKING_KEY))[TIME_TRACKING_KEY], newer);
    assert.equal(page.intervals.active.size, 0);
  });
});

describe('Timer controller - start and stop', () => {
  it('starts a timer through the store and shows it at once', async () => {
    const storage = createMemoryStorageArea();
    const page = createPage(storage);
    await page.controller.init();

    await page.controller.start(ABC_1);

    assert.equal(page.state.tracking.running.issueKey, 'ABC-1');
    assert.equal(page.state.busy, false);
    assert.equal((await storage.get(TIME_TRACKING_KEY))[TIME_TRACKING_KEY].running.issueKey, 'ABC-1');
    assert.equal(page.intervals.active.size, 1);
  });

  it('reports busy while a change is in progress', async () => {
    const page = createPage(createMemoryStorageArea());
    await page.controller.init();

    const starting = page.controller.start(ABC_1);
    assert.equal(page.state.busy, true);
    await starting;
    assert.equal(page.state.busy, false);
  });

  it('ignores another click while a change is in progress', async () => {
    const page = createPage(createMemoryStorageArea());
    await page.controller.init();
    let starts = 0;
    const start = page.store.start;
    page.store.start = (issue) => { starts++; return start(issue); };

    await Promise.all([page.controller.start(ABC_1), page.controller.start(ABC_2)]);

    assert.equal(starts, 1);
    assert.equal(page.state.tracking.running.issueKey, 'ABC-1');
  });

  it('switches issues: the new one runs and the previous session is kept as pending', async () => {
    const page = createPage(createMemoryStorageArea());
    await page.controller.init();

    await page.controller.start(ABC_1);
    await page.controller.start(ABC_2);

    assert.equal(page.state.tracking.running.issueKey, 'ABC-2');
    assert.deepEqual(page.state.tracking.pending.map((p) => p.issueKey), ['ABC-1']);
  });

  it('stops into a pending worklog and stops the clock', async () => {
    const page = createPage(createMemoryStorageArea());
    await page.controller.init();
    await page.controller.start(ABC_1);

    await page.controller.stop();

    assert.equal(page.state.tracking.running, null);
    assert.deepEqual(page.state.tracking.pending.map((p) => p.issueKey), ['ABC-1']);
    assert.equal(page.intervals.active.size, 0);
    assert.deepEqual(page.errors, []);
  });

  it('never reaches Jira: the timer modules import nothing from it', () => {
    for (const file of ['../src/timer/timerController.js', '../src/timer/timeTrackingStore.js']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /from\s+['"][^'"]*(jira|worklog)\//i, `${file} imports no Jira or worklog module`);
    }
  });

  it('explains that a pending worklog must be submitted or discarded first, and starts nothing', async () => {
    const page = createPage(createMemoryStorageArea());
    await page.controller.init();
    await page.controller.start(ABC_1);
    await page.controller.start(ABC_2);

    await page.controller.start(ABC_1);

    assert.equal(page.errors.length, 1);
    assert.match(page.errors[0], /ABC-1 already has a pending worklog/);
    assert.match(page.errors[0], /Submit or discard it/);
    assert.equal(page.state.tracking.running.issueKey, 'ABC-2');
    assert.equal(page.state.tracking.pending.length, 1);
    assert.equal(page.state.busy, false);
    // An expected refusal, not a fault.
    assert.deepEqual(page.logged, []);
  });

  it('shows what storage holds after a failed write, never the change that failed', async () => {
    const storage = createMemoryStorageArea();
    const page = createPage(storage);
    await page.controller.init();
    await page.controller.start(ABC_1);
    const set = storage.set;
    storage.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };

    await page.controller.start(ABC_2);

    assert.equal(page.state.tracking.running.issueKey, 'ABC-1');
    assert.equal(page.state.tracking.pending.length, 0);
    assert.equal(page.state.busy, false);
    assert.match(page.errors[0], /Couldn't save the timer/);
    assert.doesNotMatch(page.errors[0], /QUOTA/);

    // The controls work again once storage does.
    storage.set = set;
    await page.controller.start(ABC_2);
    assert.equal(page.state.tracking.running.issueKey, 'ABC-2');
  });
});

describe('Timer controller - other tabs', () => {
  it('follows a timer another tab starts and stops, without writing anything itself', async () => {
    const storage = createMemoryStorageArea();
    const lock = createSerialLock();
    const tabA = createPage(storage, { lock });
    const tabB = createPage(storage, { lock });
    await tabA.controller.init();
    await tabB.controller.init();
    let writes = 0;
    const set = storage.set;
    storage.set = async (items) => { writes++; return set(items); };

    await tabA.controller.start(ABC_1);
    await settle();
    assert.equal(tabB.state.tracking.running.issueKey, 'ABC-1');
    assert.equal(tabB.intervals.active.size, 1);

    await tabB.controller.stop();
    await settle();
    assert.equal(tabA.state.tracking.running, null);
    assert.equal(tabA.intervals.active.size, 0);
    // One write for the start and one for the stop: following a change never writes.
    assert.equal(writes, 2);
  });

  it('ignores changes to other storage keys', async () => {
    const storage = createMemoryStorageArea();
    const page = createPage(storage);
    await page.controller.init();
    let reads = 0;
    const get = storage.get;
    storage.get = async (keys) => { reads++; return get(keys); };
    const statesBefore = page.states.length;

    await storage.set({ jiraBaseUrl: 'https://acme.atlassian.net', token: 'x' });
    await storage.remove('lastTestResult');
    await settle();

    assert.equal(reads, 0);
    assert.equal(page.states.length, statesBefore);
  });

  it('converges with another tab on one timer when both start at once', async () => {
    const storage = createMemoryStorageArea();
    const lock = createSerialLock();
    const tabA = createPage(storage, { lock });
    const tabB = createPage(storage, { lock });
    await tabA.controller.init();
    await tabB.controller.init();

    await Promise.all([tabA.controller.start(ABC_1), tabB.controller.start(ABC_2)]);
    await settle();

    const stored = (await storage.get(TIME_TRACKING_KEY))[TIME_TRACKING_KEY];
    assert.deepEqual(tabA.state.tracking, stored);
    assert.deepEqual(tabB.state.tracking, stored);
    assert.equal(stored.pending.length, 1);
    assert.deepEqual([stored.running.issueKey, stored.pending[0].issueKey].sort(), ['ABC-1', 'ABC-2']);
  });

  it('stops following storage and the clock once disposed', async () => {
    const storage = createMemoryStorageArea();
    const page = createPage(storage);
    await page.controller.init();
    await page.controller.start(ABC_1);

    page.controller.dispose();
    await createPage(storage).store.stop();
    await settle();

    assert.equal(page.listeners, 0);
    assert.equal(page.intervals.active.size, 0);
    assert.equal(page.state.tracking.running.issueKey, 'ABC-1');
  });
});

describe('Timer controller - clock', () => {
  it('ticks through one interval while a timer runs', async () => {
    const page = createPage(createMemoryStorageArea());
    await page.controller.init();
    await page.controller.start(ABC_1);

    page.intervals.fire();
    page.intervals.fire();
    assert.equal(page.ticks, 2);
  });

  it('pauses the clock while the page is hidden, and updates at once when it is shown again', async () => {
    const page = createPage(createMemoryStorageArea());
    await page.controller.init();
    await page.controller.start(ABC_1);

    page.controller.setActive(false);
    assert.equal(page.intervals.active.size, 0);

    page.controller.setActive(true);
    assert.equal(page.intervals.active.size, 1);
    assert.equal(page.ticks, 1);
  });

  it('starts no clock while hidden, even when a timer starts', async () => {
    const page = createPage(createMemoryStorageArea());
    page.controller.setActive(false);
    await page.controller.init();
    await page.controller.start(ABC_1);
    assert.equal(page.intervals.active.size, 0);
  });
});

describe('Timer controller - error messages', () => {
  it('uses its own message for each engine error, and a general one for storage failures', () => {
    assert.match(timerErrorMessage(new TimeTrackingError('x', 'LOCK_UNAVAILABLE'), 'read'), /turned off/);
    assert.match(timerErrorMessage(new TimeTrackingError('x', 'INVALID_ISSUE'), 'change'), /can't be timed/);
    assert.match(timerErrorMessage(new TimeTrackingError('x', 'UNSUPPORTED_VERSION'), 'read'), /another version/);
    assert.equal(timerErrorMessage(new TimeTrackingError('ABC-1 already has a pending worklog.', 'PENDING_EXISTS'), 'change'),
      'ABC-1 already has a pending worklog.');
    assert.match(timerErrorMessage(new Error('boom'), 'read'), /Couldn't read/);
    assert.match(timerErrorMessage(new Error('boom'), 'change'), /Couldn't save/);
    assert.match(timerErrorMessage(undefined, 'change'), /Couldn't save/);
  });
});

describe('Timer controller - pending worklogs', () => {
  async function withPending(storage = createMemoryStorageArea(), lock = createSerialLock()) {
    const page = createPage(storage, { lock });
    await page.controller.init();
    await page.controller.start(ABC_1);
    await page.controller.start(ABC_2);
    await page.controller.stop();
    return page;
  }

  it('edits a pending worklog and shows the stored result', async () => {
    const page = await withPending();
    const [first, second] = page.state.tracking.pending;

    assert.equal(await page.controller.updatePending(first.id, { comment: 'Reviewed' }), true);

    assert.deepEqual(page.state.tracking.pending.map((p) => p.comment), ['Reviewed', '']);
    assert.deepEqual(page.state.tracking.pending[1], second);
    assert.deepEqual(page.errors, []);
  });

  it('discards a pending worklog, keeping the others', async () => {
    const page = await withPending();
    const [first, second] = page.state.tracking.pending;

    assert.equal(await page.controller.discardPending(first.id), true);
    assert.deepEqual(page.state.tracking.pending, [second]);
  });

  it('rejects with the message for the panel or dialog to show, without a toast', async () => {
    const page = await withPending();
    const [first] = page.state.tracking.pending;
    await page.controller.discardPending(first.id);

    await assert.rejects(page.controller.discardPending(first.id), /no longer here/);
    await assert.rejects(page.controller.updatePending(first.id, { comment: 'x' }), /no longer here/);
    assert.deepEqual(page.errors, []);
    assert.equal(page.state.busy, false);
  });

  it('rejects a storage failure as a failure, and shows what storage holds', async () => {
    const storage = createMemoryStorageArea();
    const page = await withPending(storage);
    const before = page.state.tracking;
    storage.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };

    await assert.rejects(page.controller.discardPending(before.pending[0].id), /Couldn't save the timer/);
    assert.deepEqual(page.state.tracking, before);
  });

  it('follows another tab editing and discarding pending worklogs, without writing', async () => {
    const storage = createMemoryStorageArea();
    const lock = createSerialLock();
    const tabA = await withPending(storage, lock);
    const tabB = createPage(storage, { lock });
    await tabB.controller.init();
    const [first, second] = tabA.state.tracking.pending;
    let writes = 0;
    const set = storage.set;
    storage.set = async (items) => { writes++; return set(items); };

    await tabA.controller.updatePending(first.id, { comment: 'From A' });
    await tabA.controller.discardPending(second.id);
    await settle();

    assert.deepEqual(tabB.state.tracking.pending.map((p) => [p.id, p.comment]), [[first.id, 'From A']]);
    assert.equal(writes, 2);
  });
});

describe('Timer controller - pause and resume', () => {
  it('pauses and resumes through the store, stopping the clock while paused', async () => {
    const page = createPage(createMemoryStorageArea());
    await page.controller.init();
    await page.controller.start(ABC_1);
    assert.equal(page.intervals.active.size, 1);

    assert.equal(await page.controller.pause(), true);
    assert.equal(page.state.tracking.running.resumedAt, null);
    assert.equal(page.intervals.active.size, 0, 'nothing to update while paused');

    assert.equal(await page.controller.resume(), true);
    assert.notEqual(page.state.tracking.running.resumedAt, null);
    assert.equal(page.intervals.active.size, 1);
  });

  it('follows a pause made in another tab', async () => {
    const storage = createMemoryStorageArea();
    const lock = createSerialLock();
    const tabA = createPage(storage, { lock });
    const tabB = createPage(storage, { lock });
    await tabA.controller.init();
    await tabB.controller.init();
    await tabA.controller.start(ABC_1);
    await settle();
    assert.equal(tabB.intervals.active.size, 1);

    await tabA.controller.pause();
    await settle();
    assert.equal(tabB.state.tracking.running.resumedAt, null);
    assert.equal(tabB.intervals.active.size, 0);
  });
});
