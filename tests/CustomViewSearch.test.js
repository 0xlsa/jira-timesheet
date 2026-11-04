import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCustomViewSearch } from '../src/jira/customViewSearch.js';

/** A search the test answers itself: its calls, each with the signal and how to answer or fail it. */
function controlledSearch() {
  const calls = [];
  const search = (signal) => new Promise((resolve, reject) => calls.push({ signal, resolve, reject }));
  return { search, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const RESULT = { issues: [{ issueKey: 'KAN-2' }], total: 1, hasMore: false };

function setup() {
  const changes = [];
  const errors = [];
  const results = createCustomViewSearch(() => changes.push('change'), { logError: (err) => errors.push(err) });
  return { results, changes, errors };
}

describe('Custom view results - searching', () => {
  it('knows nothing of a view until it\'s searched', () => {
    assert.equal(setup().results.get('site\nreporter = currentUser()'), null);
  });

  it('shows a view as searching, then its issues, once Jira answers', async () => {
    const { results, changes } = setup();
    const { search, calls } = controlledSearch();
    results.load('a', search);
    assert.deepEqual(results.get('a'), { status: 'loading', issues: [], total: null, hasMore: false, stale: false, message: '' });
    assert.equal(changes.length, 0, 'never reported during load()');
    await settle();
    calls[0].resolve(RESULT);
    await settle();
    assert.deepEqual(results.get('a'), { status: 'ready', issues: RESULT.issues, total: 1, hasMore: false, stale: false, message: '' });
    assert.equal(changes.length, 1);
  });

  it('keeps Jira\'s total and whether more match', async () => {
    const { results } = setup();
    results.load('a', async () => ({ issues: new Array(20).fill({ issueKey: 'X' }), total: 147, hasMore: true }));
    await settle();
    assert.deepEqual({ total: results.get('a').total, hasMore: results.get('a').hasMore }, { total: 147, hasMore: true });
  });

  it('searches a view once: asking again while it loads, or once it has, reuses it', async () => {
    const { results } = setup();
    const { search, calls } = controlledSearch();
    results.load('a', search);
    results.load('a', search);
    await settle();
    assert.equal(calls.length, 1, 'no second search while the first one runs');
    calls[0].resolve(RESULT);
    await settle();
    results.load('a', search);
    await settle();
    assert.equal(calls.length, 1, 'the loaded results are reused');
  });

  it('searches each view on its own', async () => {
    const { results } = setup();
    const { search, calls } = controlledSearch();
    results.load('a', search);
    results.load('b', search);
    await settle();
    assert.equal(calls.length, 2);
  });

  it('says why when the search fails, keeping none of its results, and doesn\'t try again by itself', async () => {
    const { results, errors } = setup();
    const { search, calls } = controlledSearch();
    results.load('a', search);
    await settle();
    calls[0].reject(new Error('Jira refused the search.'));
    await settle();
    assert.deepEqual(results.get('a'), { status: 'error', issues: [], total: null, hasMore: false, stale: false, message: 'Jira refused the search.' });
    assert.equal(errors.length, 1);
    results.load('a', search);
    await settle();
    assert.equal(calls.length, 1);
  });
});

describe('Custom view results - refreshing and forgetting', () => {
  it('searches again on refresh, cancelling the search in progress and ignoring its late answer', async () => {
    const { results } = setup();
    const { search, calls } = controlledSearch();
    results.load('a', search);
    await settle();
    results.refresh('a', search);
    await settle();
    assert.equal(calls[0].signal.aborted, true);
    calls[1].resolve({ issues: [{ issueKey: 'NEW-1' }], total: 1, hasMore: false });
    calls[0].resolve({ issues: [{ issueKey: 'OLD-1' }], total: 1, hasMore: false });
    await settle();
    assert.deepEqual(results.get('a').issues, [{ issueKey: 'NEW-1' }]);
  });

  it('retries a failed view on refresh', async () => {
    const { results } = setup();
    let fail = true;
    const search = async () => {
      if (fail) throw new Error('Offline');
      return RESULT;
    };
    results.load('a', search);
    await settle();
    assert.equal(results.get('a').status, 'error');
    fail = false;
    results.refresh('a', search);
    assert.equal(results.get('a').status, 'loading');
    await settle();
    assert.equal(results.get('a').status, 'ready');
  });

  it('forgets an edited or deleted view\'s results, cancelling their search', async () => {
    const { results, changes } = setup();
    const { search, calls } = controlledSearch();
    results.load('old condition', search);
    results.load('kept', search);
    await settle();
    results.retain(['kept', 'new condition']);
    assert.equal(results.get('old condition'), null);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls[1].signal.aborted, false);
    calls[0].resolve(RESULT);
    await settle();
    assert.equal(results.get('old condition'), null, 'a late answer doesn\'t bring it back');
    assert.equal(changes.length, 0);
  });

  it('forgets everything on clear (Sync), so each view is searched again when shown', async () => {
    const { results } = setup();
    const { search, calls } = controlledSearch();
    results.load('a', search);
    await settle();
    calls[0].resolve(RESULT);
    await settle();
    results.clear();
    assert.equal(results.get('a'), null);
    results.load('a', search);
    await settle();
    assert.equal(calls.length, 2);
  });
});

describe('Custom view results - kept while searched again', () => {
  const OLD = { issues: [{ issueKey: 'KAN-1' }, { issueKey: 'KAN-2' }], total: 2, hasMore: false };
  const NEW = { issues: [{ issueKey: 'KAN-2' }, { issueKey: 'KAN-1' }], total: 2, hasMore: false };

  async function loadedOld() {
    const { results, changes } = setup();
    const { search, calls } = controlledSearch();
    results.load('reporter ORDER BY updated DESC', search);
    await settle();
    calls[0].resolve(OLD);
    await settle();
    return { results, changes, search, calls };
  }

  it('keeps an edited view\'s issues shown, stale, until its new order\'s search answers', async () => {
    const { results, search, calls } = await loadedOld();
    results.load('reporter ORDER BY priority ASC', search, { from: 'reporter ORDER BY updated DESC' });
    assert.deepEqual(results.get('reporter ORDER BY priority ASC'), { status: 'loading', issues: OLD.issues, total: 2, hasMore: false, stale: true, message: '' });
    await settle();
    assert.equal(calls.length, 2, 'the new order is a new search');
    calls[1].resolve(NEW);
    await settle();
    assert.deepEqual(results.get('reporter ORDER BY priority ASC'), { status: 'ready', issues: NEW.issues, total: 2, hasMore: false, stale: false, message: '' });
  });

  it('keeps them, stale, beside the error when that search fails', async () => {
    const { results, search, calls } = await loadedOld();
    results.load('reporter ORDER BY priority ASC', search, { from: 'reporter ORDER BY updated DESC' });
    await settle();
    calls[1].reject(new Error('Offline'));
    await settle();
    assert.deepEqual(results.get('reporter ORDER BY priority ASC'), { status: 'error', issues: OLD.issues, total: 2, hasMore: false, stale: true, message: 'Offline' });
  });

  it('keeps a view\'s issues shown while Retry searches it again', async () => {
    const { results, search, calls } = await loadedOld();
    results.refresh('reporter ORDER BY updated DESC', search);
    assert.equal(results.get('reporter ORDER BY updated DESC').stale, true);
    assert.deepEqual(results.get('reporter ORDER BY updated DESC').issues, OLD.issues);
    await settle();
    calls[1].resolve(NEW);
    await settle();
    assert.equal(results.get('reporter ORDER BY updated DESC').stale, false);
  });

  it('never lets an older order\'s search replace the newer one\'s results', async () => {
    const { results, search, calls } = await loadedOld();
    results.load('order 2', search, { from: 'reporter ORDER BY updated DESC' });
    results.retain(['order 2']);
    results.load('order 3', search, { from: 'order 2' });
    results.retain(['order 3']);
    await settle();
    assert.equal(calls[1].signal.aborted, true);
    calls[2].resolve(NEW);
    calls[1].resolve({ issues: [{ issueKey: 'OLD-9' }], total: 1, hasMore: false });
    await settle();
    assert.deepEqual(results.get('order 3').issues, NEW.issues);
    assert.equal(results.get('order 2'), null);
  });

  it('starts afresh without a previous key, or when the previous one had no issues to show', async () => {
    const { results } = setup();
    const { search, calls } = controlledSearch();
    results.load('first', search);
    await settle();
    calls[0].reject(new Error('Offline'));
    await settle();
    results.load('second', search, { from: 'first' });
    assert.deepEqual(results.get('second'), { status: 'loading', issues: [], total: null, hasMore: false, stale: false, message: '' });
    results.load('third', search, { from: 'unknown' });
    assert.equal(results.get('third').stale, false);
  });
});
