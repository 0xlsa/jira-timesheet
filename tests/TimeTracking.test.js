import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIME_TRACKING_KEY,
  TIME_TRACKING_LOCK_NAME,
  TimeTrackingError,
  createTimeTrackingStore,
  createTimeTrackingLock,
  normalizeTimeTracking,
  emptyTimeTracking,
  elapsedSeconds,
  isTooShort,
  canStart,
  siteId,
  isPaused,
  submissionStatus,
  STALE_SUBMISSION_MS
} from '../src/timer/timeTrackingStore.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';

const SITE = siteId('cloud', 'https://acme.atlassian.net');
const T0 = Date.UTC(2026, 9, 26, 9, 0, 0);

const ABC_1 = { site: SITE, issueId: '10001', issueKey: 'ABC-1', issueSummary: 'Fix the login page' };
const ABC_2 = { site: SITE, issueId: '10002', issueKey: 'ABC-2', issueSummary: 'Write the release notes' };

/** A lock that runs one callback at a time, in call order, like a Web Lock within one page. */
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

/** Runs callbacks as they come, with no serialization: what changes would do without a lock. */
const noLock = { run: (fn) => fn() };

/** A clock the test moves forward. */
function createClock(start = T0) {
  let current = start;
  return {
    now: () => current,
    advance(ms) { current += ms; }
  };
}

/** IDs in creation order: id-1, id-2, ... */
function createIds() {
  let n = 0;
  return () => `id-${++n}`;
}

/** Wraps a storage area, counting writes and letting each read and write wait a turn first. */
function instrument(area, { delay = false } = {}) {
  const writes = [];
  const pause = () => (delay ? new Promise((resolve) => setTimeout(resolve, 0)) : Promise.resolve());
  return {
    writes,
    async get(keys) {
      await pause();
      return area.get(keys);
    },
    async set(items) {
      await pause();
      writes.push(items);
      return area.set(items);
    },
    remove: (keys) => area.remove(keys)
  };
}

function setup({ storage = createMemoryStorageArea(), lock = createSerialLock(), clock = createClock() } = {}) {
  const store = createTimeTrackingStore(storage, { lock, now: clock.now, newId: createIds() });
  return { store, storage, clock };
}

async function stored(storage) {
  return (await storage.get(TIME_TRACKING_KEY))[TIME_TRACKING_KEY];
}

describe('timeTrackingStore - start and stop', () => {
  it('starts with no timer and no pending worklogs', async () => {
    const { store } = setup();
    assert.deepEqual(await store.load(), emptyTimeTracking());
  });

  it('stops a timer into a pending worklog with its exact start, stop, and seconds', async () => {
    const { store, storage, clock } = setup();

    const { running } = await store.start(ABC_1);
    assert.deepEqual(running, { id: 'id-1', ...ABC_1, startedAt: T0, accumulatedMs: 0, resumedAt: T0 });

    clock.advance(25 * 60 * 1000 + 30 * 1000 + 999);
    const { stopped, state } = await store.stop();

    assert.deepEqual(stopped, {
      id: 'id-2',
      ...ABC_1,
      startedAt: T0,
      stoppedAt: T0 + 25 * 60 * 1000 + 30 * 1000 + 999,
      timeSpentSeconds: 25 * 60 + 30,
      comment: ''
    });
    assert.equal(state.running, null);
    assert.deepEqual(state.pending, [stopped]);
    assert.deepEqual(await stored(storage), state);
  });

  it('stores only the timed issue fields, never anything else the caller passes', async () => {
    const { store, storage } = setup();
    await store.start({ ...ABC_1, token: 'secret', issueStatus: { name: 'In Progress' } });
    assert.deepEqual(Object.keys((await stored(storage)).running).sort(),
      ['accumulatedMs', 'id', 'issueId', 'issueKey', 'issueSummary', 'resumedAt', 'site', 'startedAt']);
  });

  it('keeps the time tracking key apart from the settings keys', async () => {
    const storage = createMemoryStorageArea({ jiraBaseUrl: 'https://acme.atlassian.net', token: 'api-token' });
    const { store } = setup({ storage });
    await store.start(ABC_1);
    assert.deepEqual(await storage.get(['jiraBaseUrl', 'token']), { jiraBaseUrl: 'https://acme.atlassian.net', token: 'api-token' });
  });

  it('switches issues in one write: the running timer becomes pending and the new one starts', async () => {
    const storage = instrument(createMemoryStorageArea());
    const { store, clock } = setup({ storage });
    await store.start(ABC_1);
    clock.advance(10 * 60 * 1000);
    storage.writes.length = 0;

    const { running, stopped, state } = await store.start(ABC_2);

    assert.equal(storage.writes.length, 1);
    assert.equal(stopped.issueKey, 'ABC-1');
    assert.equal(stopped.timeSpentSeconds, 600);
    // The new timer starts at the moment the old one stopped.
    assert.equal(running.issueKey, 'ABC-2');
    assert.equal(running.startedAt, stopped.stoppedAt);
    assert.deepEqual(state.pending, [stopped]);
    assert.deepEqual(state.running, running);
  });

  it('refuses to start an issue that has a pending worklog, and leaves the state alone', async () => {
    const { store, storage } = setup();
    await store.start(ABC_1);
    await store.stop();
    await store.start(ABC_2);
    const before = await stored(storage);

    await assert.rejects(store.start(ABC_1), (err) => err instanceof TimeTrackingError && err.code === 'PENDING_EXISTS');
    assert.deepEqual(await stored(storage), before);
  });

  it('matches a pending issue by its ID even when its key changed, and by key when an ID is missing', async () => {
    const { store } = setup();
    await store.start(ABC_1);
    await store.stop();

    await assert.rejects(store.start({ ...ABC_1, issueKey: 'XYZ-9' }), { code: 'PENDING_EXISTS' });
    await assert.rejects(store.start({ site: SITE, issueKey: 'ABC-1' }), { code: 'PENDING_EXISTS' });
    // The same key on another site is another issue.
    await store.start({ ...ABC_1, site: siteId('server', 'https://jira.example.com') });
  });

  it('changes nothing when starting the issue already running, or stopping with no timer', async () => {
    const storage = instrument(createMemoryStorageArea());
    const { store, clock } = setup({ storage });

    assert.deepEqual(await store.stop(), { state: emptyTimeTracking(), stopped: null });
    const { running } = await store.start(ABC_1);
    clock.advance(5000);
    const again = await store.start(ABC_1);

    assert.deepEqual(again.running, running);
    assert.equal(again.stopped, null);
    assert.equal(storage.writes.length, 1);
  });

  it('keeps pending worklogs for different issues side by side', async () => {
    const { store, clock } = setup();
    await store.start(ABC_1);
    clock.advance(60_000);
    await store.start(ABC_2);
    clock.advance(120_000);
    const { state } = await store.stop();

    assert.deepEqual(state.pending.map((p) => [p.issueKey, p.timeSpentSeconds]), [['ABC-1', 60], ['ABC-2', 120]]);
    assert.equal(state.running, null);
  });

  it('rejects an issue without a site or a valid key, writing nothing', async () => {
    const storage = instrument(createMemoryStorageArea());
    const { store } = setup({ storage });

    for (const issue of [null, { issueKey: 'ABC-1' }, { site: SITE, issueKey: 'abc-1' }, { site: SITE, issueKey: 'ABC-1', issueId: '10x' }]) {
      await assert.rejects(store.start(issue), { code: 'INVALID_ISSUE' });
    }
    assert.equal(storage.writes.length, 0);
  });

  it('accepts a numeric issue ID and stores it as text', async () => {
    const { store } = setup();
    const { running } = await store.start({ ...ABC_1, issueId: 10001 });
    assert.equal(running.issueId, '10001');
  });
});

describe('timeTrackingStore - short sessions', () => {
  it('keeps a session under a minute as a pending worklog, flagged as too short', async () => {
    const { store, clock } = setup();
    await store.start(ABC_1);
    clock.advance(59_999);
    const { stopped } = await store.stop();

    assert.equal(stopped.timeSpentSeconds, 59);
    assert.equal(isTooShort(stopped), true);
  });

  it('treats a minute or more as long enough', () => {
    assert.equal(isTooShort({ timeSpentSeconds: 60 }), false);
    assert.equal(isTooShort({ timeSpentSeconds: 3725 }), false);
    assert.equal(isTooShort({ timeSpentSeconds: 0 }), true);
  });
});

describe('timeTrackingStore - persistence and recovery', () => {
  it('restores a running timer in a new store, with elapsed time from its start', async () => {
    const storage = createMemoryStorageArea();
    const clock = createClock();
    await setup({ storage, clock }).store.start(ABC_1);

    // Another page (or the same page after a browser restart) reads the same storage later.
    clock.advance(3 * 60 * 60 * 1000);
    const reopened = setup({ storage, clock }).store;
    const { running } = await reopened.load();

    assert.equal(running.issueKey, 'ABC-1');
    assert.equal(elapsedSeconds(running, clock.now()), 3 * 60 * 60);
    const { stopped } = await reopened.stop();
    assert.equal(stopped.timeSpentSeconds, 3 * 60 * 60);
  });

  it('never reports negative time when the clock moves back', async () => {
    const { store, clock } = setup();
    const { running } = await store.start(ABC_1);
    clock.advance(-60_000);

    assert.equal(elapsedSeconds(running, clock.now()), 0);
    const { stopped } = await store.stop();
    assert.equal(stopped.timeSpentSeconds, 0);
    assert.equal(stopped.stoppedAt, stopped.startedAt);
    // The session stays valid when read back.
    assert.equal((await store.load()).pending.length, 1);
  });

  it('reports no elapsed time without a running timer', () => {
    assert.equal(elapsedSeconds(null, T0), 0);
  });
});

describe('timeTrackingStore - storage failures', () => {
  it('rejects a change whose write fails, leaving the stored state unchanged', async () => {
    const area = createMemoryStorageArea();
    const { store } = setup({ storage: area });
    await store.start(ABC_1);
    const before = await stored(area);

    const failing = { ...area, get: area.get, set: async () => { throw new Error('QUOTA_BYTES quota exceeded'); } };
    const broken = setup({ storage: failing }).store;

    await assert.rejects(broken.start(ABC_2), /quota exceeded/);
    await assert.rejects(broken.stop(), /quota exceeded/);
    assert.deepEqual(await stored(area), before);
  });

  it('rejects a change whose read fails, without writing', async () => {
    let writes = 0;
    const storage = {
      get: async () => { throw new Error('storage unavailable'); },
      set: async () => { writes++; }
    };
    const { store } = setup({ storage });

    await assert.rejects(store.start(ABC_1), /storage unavailable/);
    await assert.rejects(store.load(), /storage unavailable/);
    assert.equal(writes, 0);
  });

  it('releases the lock after a failed change, so the next one runs', async () => {
    let failNext = true;
    const area = createMemoryStorageArea();
    const storage = {
      get: (keys) => area.get(keys),
      set: async (items) => {
        if (failNext) {
          failNext = false;
          throw new Error('write failed');
        }
        return area.set(items);
      }
    };
    const { store } = setup({ storage });

    await assert.rejects(store.start(ABC_1), /write failed/);
    const { running } = await store.start(ABC_1);
    assert.equal(running.issueKey, 'ABC-1');
  });
});

describe('timeTrackingStore - unsupported versions', () => {
  // As a newer version of the extension might store it.
  const newer = {
    version: 3,
    running: { id: 'r9', site: SITE, issueKey: 'ABC-9', startedAt: T0, timezone: 'Europe/Lisbon' },
    pending: [{ id: 'p9', issueKey: 'ABC-8', segments: [{ from: T0, to: T0 + 60_000 }] }]
  };

  it('refuses to load it', async () => {
    const storage = createMemoryStorageArea({ [TIME_TRACKING_KEY]: newer });
    const { store } = setup({ storage });
    await assert.rejects(store.load(), (err) => err instanceof TimeTrackingError && err.code === 'UNSUPPORTED_VERSION');
  });

  it('never overwrites it when starting or stopping a timer', async () => {
    const storage = instrument(createMemoryStorageArea({ [TIME_TRACKING_KEY]: structuredClone(newer) }));
    const { store } = setup({ storage });

    await assert.rejects(store.start(ABC_1), { code: 'UNSUPPORTED_VERSION' });
    await assert.rejects(store.stop(), { code: 'UNSUPPORTED_VERSION' });
    assert.equal(storage.writes.length, 0);
    assert.deepEqual(await stored(storage), newer);
  });

  it('releases the lock, so a store on supported data still works', async () => {
    const lock = createSerialLock();
    const blocked = setup({ storage: createMemoryStorageArea({ [TIME_TRACKING_KEY]: newer }), lock }).store;
    const working = setup({ lock }).store;

    await assert.rejects(blocked.start(ABC_1), { code: 'UNSUPPORTED_VERSION' });
    const { running } = await working.start(ABC_1);
    assert.equal(running.issueKey, 'ABC-1');
  });
});

describe('timeTrackingStore - concurrency', () => {
  /**
   * Two pages, each with its own store, start timers on different issues at the same moment,
   * on shared storage whose reads and writes each take a turn (so the calls interleave).
   */
  async function startTwoAtOnce(lock) {
    const storage = instrument(createMemoryStorageArea(), { delay: true });
    const clock = createClock();
    const ids = createIds();
    const pageA = createTimeTrackingStore(storage, { lock, now: clock.now, newId: ids });
    const pageB = createTimeTrackingStore(storage, { lock, now: clock.now, newId: ids });

    await Promise.all([pageA.start(ABC_1), pageB.start(ABC_2)]);
    return normalizeTimeTracking(await stored(storage));
  }

  it('with a shared lock, ends with one running timer and the other session pending', async () => {
    const state = await startTwoAtOnce(createSerialLock());

    assert.ok(state.running);
    assert.equal(state.pending.length, 1);
    // Both issues are accounted for: one running, one pending.
    assert.deepEqual([state.running.issueKey, state.pending[0].issueKey].sort(), ['ABC-1', 'ABC-2']);
  });

  it('without a lock, one start overwrites the other and its session is lost', async () => {
    // This is the race the lock prevents: both read the empty state, and the last write wins.
    const state = await startTwoAtOnce(noLock);

    assert.ok(state.running);
    assert.equal(state.pending.length, 0);
  });

  it('with the Web Locks API, serializes stores the same way', { skip: typeof globalThis.navigator?.locks?.request !== 'function' && 'no navigator.locks in this runtime' }, async () => {
    const state = await startTwoAtOnce(createTimeTrackingLock());

    assert.ok(state.running);
    assert.equal(state.pending.length, 1);
  });

  it('keeps every session through a burst of switches across pages', async () => {
    const storage = instrument(createMemoryStorageArea(), { delay: true });
    const lock = createSerialLock();
    const clock = createClock();
    const pages = [0, 1, 2].map(() => createTimeTrackingStore(storage, { lock, now: clock.now, newId: () => crypto.randomUUID() }));
    const issues = [1, 2, 3, 4, 5, 6].map((n) => ({ site: SITE, issueId: String(10000 + n), issueKey: `ABC-${n}` }));

    await Promise.all(issues.map((issue, i) => pages[i % pages.length].start(issue)));
    const state = normalizeTimeTracking(await stored(storage));

    assert.ok(state.running);
    assert.equal(state.pending.length, issues.length - 1);
    const timed = [state.running, ...state.pending].map((r) => r.issueKey).sort();
    assert.deepEqual(timed, issues.map((i) => i.issueKey).sort());
  });
});

describe('timeTrackingStore - lock', () => {
  it('requests the shared Web Lock by name for each change', async () => {
    const names = [];
    const lock = createTimeTrackingLock({
      locks: { request: (name, callback) => { names.push(name); return Promise.resolve(callback()); } }
    });
    const { store } = setup({ lock });

    await store.start(ABC_1);
    await store.stop();
    assert.deepEqual(names, [TIME_TRACKING_LOCK_NAME, TIME_TRACKING_LOCK_NAME]);
  });

  it('throws when the browser has no Web Locks, rather than using a lock only one tab respects', () => {
    for (const nav of [{}, null, { locks: {} }, { locks: { request: 'no' } }]) {
      assert.throws(() => createTimeTrackingLock(nav),
        (err) => err instanceof TimeTrackingError && err.code === 'LOCK_UNAVAILABLE');
    }
  });

  it('refuses to create a store without a lock', () => {
    assert.throws(() => createTimeTrackingStore(createMemoryStorageArea()), TypeError);
    assert.throws(() => createTimeTrackingStore(createMemoryStorageArea(), { lock: {} }), TypeError);
  });
});

describe('timeTrackingStore - canStart', () => {
  it('allows another issue while a timer runs, but not the running issue or one with a pending worklog', async () => {
    const { store } = setup();
    await store.start(ABC_1);
    await store.stop();
    const { state } = await store.start(ABC_2);

    assert.equal(canStart(state, ABC_1), false);
    assert.equal(canStart(state, ABC_2), false);
    assert.equal(canStart(state, { site: SITE, issueId: '10003', issueKey: 'ABC-3' }), true);
  });
});

describe('normalizeTimeTracking', () => {
  const running = { id: 'r1', site: SITE, issueId: '10001', issueKey: 'ABC-1', issueSummary: 'Fix', startedAt: T0 };
  const pending = { id: 'p1', site: SITE, issueId: '10002', issueKey: 'ABC-2', issueSummary: 'Notes', startedAt: T0, stoppedAt: T0 + 60_000, timeSpentSeconds: 60, comment: '' };

  it('gives the empty state for a missing or malformed value', () => {
    for (const value of [undefined, null, 'x', 42, [], {}, { running, pending: [pending] }]) {
      assert.deepEqual(normalizeTimeTracking(value), emptyTimeTracking());
    }
  });

  it('throws for a value that declares another version, rather than reading it as empty', () => {
    for (const version of [3, 0, '1', null, undefined]) {
      assert.throws(() => normalizeTimeTracking({ version, running, pending: [pending] }),
        (err) => err instanceof TimeTrackingError && err.code === 'UNSUPPORTED_VERSION');
    }
  });

  it('keeps a valid version 2 state as it is', () => {
    const value = { version: 2, running: { ...running, accumulatedMs: 5000, resumedAt: null }, pending: [{ ...pending, submission: { state: 'failed', at: T0, message: 'No permission' } }] };
    assert.deepEqual(normalizeTimeTracking(value), value);
  });

  it('reads version 1 as version 2: its timer ran from its start with nothing banked', () => {
    const state = normalizeTimeTracking({ version: 1, running, pending: [pending] });
    assert.deepEqual(state, { version: 2, running: { ...running, accumulatedMs: 0, resumedAt: T0 }, pending: [pending] });
  });

  it('fills in an empty issue ID, summary, and comment when they are missing', () => {
    const { issueId, issueSummary, comment, ...bare } = pending;
    const state = normalizeTimeTracking({ version: 1, running: null, pending: [bare] });
    assert.deepEqual(state.pending, [{ ...bare, issueId: '', issueSummary: '', comment: '' }]);
  });

  it('drops a malformed running timer', () => {
    for (const bad of [{ ...running, startedAt: 'yesterday' }, { ...running, issueKey: '' }, { ...running, site: undefined }, { ...running, id: '' }, 'ABC-1']) {
      assert.equal(normalizeTimeTracking({ version: 1, running: bad, pending: [] }).running, null);
    }
  });

  it('drops malformed pending worklogs and keeps the valid ones', () => {
    const bad = [
      { ...pending, id: 'b1', timeSpentSeconds: -5 },
      { ...pending, id: 'b2', timeSpentSeconds: 1.5 },
      { ...pending, id: 'b3', timeSpentSeconds: '60' },
      { ...pending, id: 'b4', stoppedAt: T0 - 1 },
      { ...pending, id: 'b5', startedAt: NaN },
      { ...pending, id: 'b6', issueKey: 'not a key' },
      { ...pending, id: 'b7', issueId: 10002 },
      { ...pending, id: 'b8', comment: { type: 'doc' } },
      { ...pending, id: undefined },
      null
    ];
    const other = { ...pending, id: 'p2', issueKey: 'ABC-3', issueId: '10003' };

    const state = normalizeTimeTracking({ version: 1, running, pending: [pending, ...bad, other] });
    assert.deepEqual(state.pending, [pending, other]);
    assert.deepEqual(state.running, { ...running, accumulatedMs: 0, resumedAt: T0 });
  });

  it('keeps the first of two pending worklogs with the same ID', () => {
    const state = normalizeTimeTracking({ version: 1, running: null, pending: [pending, { ...pending, timeSpentSeconds: 999 }] });
    assert.deepEqual(state.pending, [pending]);
  });

  it('drops extra fields from stored records', () => {
    const state = normalizeTimeTracking({ version: 1, running: { ...running, token: 'secret' }, pending: [{ ...pending, extra: 1 }] });
    assert.deepEqual(state.running, { ...running, accumulatedMs: 0, resumedAt: T0 });
    assert.deepEqual(state.pending, [pending]);
  });
});

describe('timeTrackingStore - editing and discarding pending worklogs', () => {
  /** Two pending worklogs (ABC-1 for 10 minutes, then ABC-2 for 45 seconds) and ABC-3 running. */
  async function withPending() {
    const ctx = setup({ storage: instrument(createMemoryStorageArea()) });
    const { store, clock } = ctx;
    await store.start(ABC_1);
    clock.advance(10 * 60_000);
    await store.start(ABC_2);
    clock.advance(45_000);
    await store.start({ site: SITE, issueId: '10003', issueKey: 'ABC-3' });
    const state = await store.load();
    ctx.storage.writes.length = 0;
    return { ...ctx, state, first: state.pending[0], second: state.pending[1] };
  }

  it('changes only the chosen pending worklog, keeping its ID, issue, and place', async () => {
    const { store, state, first, second, storage } = await withPending();
    const startedAt = first.startedAt + 3_600_000;

    const { updated, state: next } = await store.updatePending(first.id, { startedAt, timeSpentSeconds: 1500, comment: 'Reviewed the PR' });

    assert.deepEqual(updated, {
      ...first, startedAt, timeSpentSeconds: 1500, comment: 'Reviewed the PR', stoppedAt: startedAt + 1_500_000
    });
    assert.deepEqual(next.pending, [updated, second]);
    assert.deepEqual(next.running, state.running);
    assert.equal(storage.writes.length, 1);
    assert.deepEqual(await stored(storage), next);
  });

  it('changes only the fields given', async () => {
    const { store, first } = await withPending();
    const { updated } = await store.updatePending(first.id, { comment: 'Notes' });
    assert.equal(updated.timeSpentSeconds, first.timeSpentSeconds);
    assert.equal(updated.startedAt, first.startedAt);
    assert.equal(updated.comment, 'Notes');
  });

  it('keeps a pending worklog edited under a minute, flagged as too short', async () => {
    const { store, first } = await withPending();
    const { updated, state } = await store.updatePending(first.id, { timeSpentSeconds: 30 });
    assert.equal(isTooShort(updated), true);
    assert.equal(state.pending.length, 2);
  });

  it('refuses an edit when the stored values changed since the edit began, writing nothing', async () => {
    const { store, first, storage } = await withPending();
    const expected = { startedAt: first.startedAt, timeSpentSeconds: first.timeSpentSeconds, comment: first.comment };
    // Another tab edits it first.
    await store.updatePending(first.id, { comment: 'From the other tab' });
    const before = await stored(storage);

    await assert.rejects(store.updatePending(first.id, { comment: 'Mine' }, expected), { code: 'PENDING_CHANGED' });
    assert.deepEqual(await stored(storage), before);
  });

  it('applies an edit when the stored values still match', async () => {
    const { store, first } = await withPending();
    const expected = { startedAt: first.startedAt, timeSpentSeconds: first.timeSpentSeconds, comment: first.comment };
    const { updated } = await store.updatePending(first.id, { comment: 'Mine' }, expected);
    assert.equal(updated.comment, 'Mine');
  });

  it('rejects invalid values and an unknown ID without writing', async () => {
    const { store, first, storage } = await withPending();
    for (const changes of [{ startedAt: 'today' }, { timeSpentSeconds: -1 }, { timeSpentSeconds: 1.5 }, { comment: 42 }]) {
      await assert.rejects(store.updatePending(first.id, changes), { code: 'INVALID_PENDING' });
    }
    await assert.rejects(store.updatePending('missing', { comment: 'x' }), { code: 'PENDING_NOT_FOUND' });
    assert.equal(storage.writes.length, 0);
  });

  it('discards only the chosen pending worklog, keeping the others and the running timer', async () => {
    const { store, state, first, second } = await withPending();

    const { discarded, state: next } = await store.discardPending(first.id);

    assert.deepEqual(discarded, first);
    assert.deepEqual(next.pending, [second]);
    assert.deepEqual(next.running, state.running);
  });

  it('reports a pending worklog that is already gone, changing nothing', async () => {
    const { store, first, storage } = await withPending();
    await store.discardPending(first.id);
    const before = await stored(storage);

    await assert.rejects(store.discardPending(first.id), { code: 'PENDING_NOT_FOUND' });
    assert.deepEqual(await stored(storage), before);
  });

  it('keeps refusing a timer on an issue with a pending worklog, and allows it once that is discarded', async () => {
    const { store, first } = await withPending();

    await assert.rejects(store.start(ABC_1), { code: 'PENDING_EXISTS' });
    await store.discardPending(first.id);
    const { running, stopped } = await store.start(ABC_1);

    assert.equal(running.issueKey, 'ABC-1');
    // The timer that was running became pending, as with any switch.
    assert.equal(stopped.issueKey, 'ABC-3');
  });

  it('serializes edits, discards, and starts from several pages, losing nothing unrelated', async () => {
    const storage = instrument(createMemoryStorageArea(), { delay: true });
    const lock = createSerialLock();
    const clock = createClock();
    const ids = createIds();
    const [pageA, pageB, pageC] = [0, 1, 2].map(() => createTimeTrackingStore(storage, { lock, now: clock.now, newId: ids }));
    await pageA.start(ABC_1);
    await pageA.start(ABC_2);
    await pageA.stop();
    const [first, second] = (await pageA.load()).pending;

    await Promise.all([
      pageA.updatePending(first.id, { comment: 'Edited in A' }),
      pageB.discardPending(second.id),
      pageC.start({ site: SITE, issueId: '10003', issueKey: 'ABC-3' })
    ]);

    const state = normalizeTimeTracking(await stored(storage));
    assert.deepEqual(state.pending.map((p) => [p.id, p.comment]), [[first.id, 'Edited in A']]);
    assert.equal(state.running.issueKey, 'ABC-3');
  });

  it('without the lock, an edit and a discard at once overwrite each other', async () => {
    const storage = instrument(createMemoryStorageArea(), { delay: true });
    const clock = createClock();
    const ids = createIds();
    const setupStore = createTimeTrackingStore(storage, { lock: createSerialLock(), now: clock.now, newId: ids });
    await setupStore.start(ABC_1);
    await setupStore.start(ABC_2);
    await setupStore.stop();
    const [first, second] = (await setupStore.load()).pending;
    const [pageA, pageB] = [0, 1].map(() => createTimeTrackingStore(storage, { lock: noLock, now: clock.now, newId: ids }));

    await Promise.all([pageA.updatePending(first.id, { comment: 'Edited in A' }), pageB.discardPending(second.id)]);

    // The last write wins: either the edit or the discard is lost.
    const state = normalizeTimeTracking(await stored(storage));
    const editKept = state.pending.some((p) => p.comment === 'Edited in A');
    const discardKept = !state.pending.some((p) => p.id === second.id);
    assert.equal(editKept && discardKept, false);
  });
});

describe('timeTrackingStore - pause and resume', () => {
  it('pauses a running timer: its time so far is banked, and it stops counting', async () => {
    const { store, clock } = setup();
    await store.start(ABC_1);
    clock.advance(10 * 60_000);

    const { paused, state } = await store.pause();

    assert.equal(paused.accumulatedMs, 600_000);
    assert.equal(paused.resumedAt, null);
    assert.equal(isPaused(state.running), true);
    assert.deepEqual(state.pending, [], 'a paused timer is still the current one, not a pending worklog');
    clock.advance(60 * 60_000);
    assert.equal(elapsedSeconds(state.running, clock.now()), 600, 'time paused doesn\'t count');
  });

  it('resumes from the banked time, without the time it was paused', async () => {
    const { store, clock } = setup();
    await store.start(ABC_1);
    clock.advance(5 * 60_000);
    await store.pause();
    clock.advance(30 * 60_000);

    const { resumed } = await store.resume();
    assert.equal(resumed.resumedAt, clock.now());
    clock.advance(2 * 60_000);
    assert.equal(elapsedSeconds(resumed, clock.now()), 7 * 60);
    // The session still starts when it first started (the worklog's start in Jira).
    assert.equal(resumed.startedAt, T0);
  });

  it('stops a paused or resumed timer into a pending worklog of its active time only', async () => {
    const { store, clock } = setup();
    await store.start(ABC_1);
    clock.advance(10 * 60_000);
    await store.pause();
    clock.advance(45 * 60_000);
    await store.resume();
    clock.advance(5 * 60_000);
    await store.pause();
    clock.advance(20 * 60_000);

    const { stopped, state } = await store.stop();
    assert.equal(stopped.timeSpentSeconds, 15 * 60);
    assert.equal(stopped.startedAt, T0);
    assert.equal(stopped.stoppedAt, clock.now());
    assert.equal(state.running, null);
  });

  it('switches from a paused timer: its active time becomes pending, and the new one starts', async () => {
    const { store, clock } = setup();
    await store.start(ABC_1);
    clock.advance(3 * 60_000);
    await store.pause();
    clock.advance(60 * 60_000);

    const { stopped, running } = await store.start(ABC_2);
    assert.equal(stopped.issueKey, 'ABC-1');
    assert.equal(stopped.timeSpentSeconds, 180);
    assert.deepEqual([running.issueKey, running.accumulatedMs, running.resumedAt], ['ABC-2', 0, clock.now()]);
  });

  it('resumes when the paused issue is started again, and keeps refusing an issue with a pending worklog', async () => {
    const { store, clock } = setup();
    await store.start(ABC_1);
    clock.advance(60_000);
    await store.pause();
    clock.advance(60_000);
    const { running, stopped } = await store.start(ABC_1);
    assert.equal(stopped, null);
    assert.equal(isPaused(running), false);
    assert.equal(running.accumulatedMs, 60_000);

    await store.start(ABC_2);
    await assert.rejects(store.start(ABC_1), { code: 'PENDING_EXISTS' });
  });

  it('changes nothing when pausing a paused timer, resuming a running one, or either with no timer', async () => {
    const storage = instrument(createMemoryStorageArea());
    const { store } = setup({ storage });
    assert.equal((await store.pause()).paused, null);
    assert.equal((await store.resume()).resumed, null);
    await store.start(ABC_1);
    assert.equal((await store.resume()).resumed, null);
    await store.pause();
    assert.equal((await store.pause()).paused, null);
    assert.equal(storage.writes.length, 2, 'only the start and the first pause wrote');
  });

  it('keeps the paused state for a new store on the same storage (a reopened page or restarted browser)', async () => {
    const storage = createMemoryStorageArea();
    const clock = createClock();
    const first = setup({ storage, clock }).store;
    await first.start(ABC_1);
    clock.advance(90_000);
    await first.pause();
    clock.advance(24 * 60 * 60_000);

    const reopened = setup({ storage, clock }).store;
    const { running } = await reopened.load();
    assert.equal(isPaused(running), true);
    assert.equal(elapsedSeconds(running, clock.now()), 90);
    const { resumed } = await reopened.resume();
    clock.advance(30_000);
    assert.equal(elapsedSeconds(resumed, clock.now()), 120);
  });

  it('never counts negative time when the clock moves back while running', async () => {
    const { store, clock } = setup();
    await store.start(ABC_1);
    clock.advance(-60_000);
    const { paused } = await store.pause();
    assert.equal(paused.accumulatedMs, 0);
  });

  it('serializes pause, resume, stop, and start from several pages: one timer, nothing lost', async () => {
    const storage = instrument(createMemoryStorageArea(), { delay: true });
    const lock = createSerialLock();
    const clock = createClock();
    const ids = createIds();
    const [pageA, pageB, pageC] = [0, 1, 2].map(() => createTimeTrackingStore(storage, { lock, now: clock.now, newId: ids }));
    await pageA.start(ABC_1);
    clock.advance(60_000);

    await Promise.all([pageA.pause(), pageB.start(ABC_2), pageC.resume()]);

    const state = normalizeTimeTracking(await stored(storage));
    assert.ok(state.running);
    assert.deepEqual([state.running.issueKey, ...state.pending.map((p) => p.issueKey)].sort(), ['ABC-1', 'ABC-2']);
    assert.equal(state.pending.length, 1);
  });

  it('without the lock, a stop and a pause at once lose the stop', async () => {
    const storage = instrument(createMemoryStorageArea(), { delay: true });
    const clock = createClock();
    await createTimeTrackingStore(storage, { lock: createSerialLock(), now: clock.now, newId: createIds() }).start(ABC_1);
    clock.advance(60_000);
    const [pageA, pageB] = [0, 1].map(() => createTimeTrackingStore(storage, { lock: noLock, now: clock.now, newId: createIds() }));

    await Promise.all([pageA.stop(), pageB.pause()]);

    // The pause, written last, overwrote the stop: no pending worklog, and the timer still there.
    const state = normalizeTimeTracking(await stored(storage));
    assert.deepEqual([Boolean(state.running), state.pending.length], [true, 0]);
  });

  it('with the lock, a stop and a pause at once keep the stopped session', async () => {
    const storage = instrument(createMemoryStorageArea(), { delay: true });
    const lock = createSerialLock();
    const clock = createClock();
    const [pageA, pageB] = [0, 1].map(() => createTimeTrackingStore(storage, { lock, now: clock.now, newId: createIds() }));
    await pageA.start(ABC_1);
    clock.advance(60_000);

    await Promise.all([pageA.stop(), pageB.pause()]);

    const state = normalizeTimeTracking(await stored(storage));
    assert.deepEqual([state.running, state.pending.map((p) => [p.issueKey, p.timeSpentSeconds])], [null, [['ABC-1', 60]]]);
  });
});

describe('timeTrackingStore - version 1 compatibility', () => {
  const v1 = {
    version: 1,
    running: { id: 'r1', site: SITE, issueId: '10001', issueKey: 'ABC-1', issueSummary: 'Fix', startedAt: T0 },
    pending: [{ id: 'p1', site: SITE, issueId: '10002', issueKey: 'ABC-2', issueSummary: '', startedAt: T0, stoppedAt: T0 + 60_000, timeSpentSeconds: 60, comment: '' }]
  };

  it('reads a version 1 timer as running from its start, without writing', async () => {
    const storage = instrument(createMemoryStorageArea({ [TIME_TRACKING_KEY]: structuredClone(v1) }));
    const clock = createClock(T0 + 5 * 60_000);
    const { store } = setup({ storage, clock });

    const state = await store.load();
    assert.equal(elapsedSeconds(state.running, clock.now()), 300);
    assert.equal(isPaused(state.running), false);
    assert.equal(storage.writes.length, 0);
    assert.deepEqual(await stored(storage), v1, 'reading leaves it as it is');
  });

  it('writes version 2 on the next change, keeping the version 1 data', async () => {
    const storage = createMemoryStorageArea({ [TIME_TRACKING_KEY]: structuredClone(v1) });
    const clock = createClock(T0 + 5 * 60_000);
    const { store } = setup({ storage, clock });

    await store.pause();
    const written = await stored(storage);
    assert.equal(written.version, 2);
    assert.equal(written.running.accumulatedMs, 300_000);
    assert.deepEqual(written.pending, v1.pending);
  });
});

describe('timeTrackingStore - submission state', () => {
  async function withPending({ seconds = 600 } = {}) {
    const ctx = setup({ storage: instrument(createMemoryStorageArea()) });
    await ctx.store.start(ABC_1);
    ctx.clock.advance(seconds * 1000);
    await ctx.store.stop();
    const [entry] = (await ctx.store.load()).pending;
    return { ...ctx, entry };
  }

  it('marks a pending worklog as being submitted, keeping it, and returns what to send', async () => {
    const { store, entry, clock } = await withPending();
    const { entry: sending, previous, state } = await store.beginSubmission(entry.id, { site: SITE });
    assert.equal(previous, null);
    assert.deepEqual(sending, { ...entry, submission: { state: 'submitting', at: clock.now() } });
    assert.equal(state.pending.length, 1);
    assert.equal(submissionStatus(sending, clock.now()), 'submitting');
  });

  it('refuses a second submission while one runs, another site, a short session, or a changed one', async () => {
    const { store, entry } = await withPending();
    await assert.rejects(store.beginSubmission(entry.id, { site: siteId('server', 'https://jira.example.com') }), { code: 'OTHER_SITE' });
    await assert.rejects(store.beginSubmission(entry.id, { site: SITE, expected: { ...entry, comment: 'old' } }), { code: 'PENDING_CHANGED' });
    await store.beginSubmission(entry.id, { site: SITE });
    await assert.rejects(store.beginSubmission(entry.id, { site: SITE }), { code: 'SUBMISSION_IN_PROGRESS' });

    const short = await withPending({ seconds: 59 });
    await assert.rejects(short.store.beginSubmission(short.entry.id, { site: SITE }), { code: 'TOO_SHORT' });
    assert.equal((await short.store.load()).pending[0].submission, undefined);
  });

  it('removes it only on completion, and keeps it as failed or uncertain otherwise', async () => {
    const { store, entry } = await withPending();
    await store.beginSubmission(entry.id, { site: SITE });
    const { failed } = await store.failSubmission(entry.id, { uncertain: false, message: 'No permission' });
    assert.deepEqual([failed.submission.state, failed.submission.message], ['failed', 'No permission']);

    await store.beginSubmission(entry.id, { site: SITE });
    const { failed: uncertain } = await store.failSubmission(entry.id, { uncertain: true });
    assert.equal(uncertain.submission.state, 'uncertain');

    const { previous } = await store.beginSubmission(entry.id, { site: SITE });
    assert.equal(previous, 'uncertain', 'the caller checks Jira first');
    const { completed, state } = await store.completeSubmission(entry.id);
    assert.equal(completed.id, entry.id);
    assert.deepEqual(state.pending, []);
    // Already gone: nothing to do.
    assert.equal((await store.completeSubmission(entry.id)).completed, null);
    assert.equal((await store.failSubmission(entry.id, { uncertain: true })).failed, null);
  });

  it('treats a submission left running too long (its page closed) as uncertain', async () => {
    const { store, entry, clock } = await withPending();
    await store.beginSubmission(entry.id, { site: SITE });
    clock.advance(STALE_SUBMISSION_MS + 1);
    const [stale] = (await store.load()).pending;
    assert.equal(submissionStatus(stale, clock.now()), 'uncertain');
    const { previous } = await store.beginSubmission(entry.id, { site: SITE });
    assert.equal(previous, 'uncertain');
  });

  it('refuses edits while submitting or uncertain, and clears a failed submission on edit', async () => {
    const { store, entry } = await withPending();
    await store.beginSubmission(entry.id, { site: SITE });
    await assert.rejects(store.updatePending(entry.id, { comment: 'x' }), { code: 'SUBMISSION_IN_PROGRESS' });
    await store.failSubmission(entry.id, { uncertain: true });
    await assert.rejects(store.updatePending(entry.id, { comment: 'x' }), { code: 'SUBMISSION_UNCERTAIN' });
    // Discarding stays possible.
    await store.beginSubmission(entry.id, { site: SITE });
    await store.failSubmission(entry.id, { uncertain: false, message: 'Refused' });
    const { updated } = await store.updatePending(entry.id, { comment: 'Fixed' });
    assert.equal(updated.submission, undefined);
    await store.discardPending(entry.id);
  });

  it('reads a damaged submission record as uncertain, never as none', () => {
    const base = { id: 'p1', site: SITE, issueKey: 'ABC-1', startedAt: T0, stoppedAt: T0 + 60_000, timeSpentSeconds: 60, comment: '' };
    for (const submission of [{ state: 'sent' }, { state: 'failed' }, 'yes', { state: 'submitting', at: 'now' }]) {
      const [entry] = normalizeTimeTracking({ version: 2, running: null, pending: [{ ...base, submission }] }).pending;
      assert.equal(entry.submission.state, 'uncertain', JSON.stringify(submission));
    }
    const [plain] = normalizeTimeTracking({ version: 2, running: null, pending: [base] }).pending;
    assert.equal('submission' in plain, false);
  });
});
