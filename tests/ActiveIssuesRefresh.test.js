import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDocument } from './support/fakeDom.js';
import { createWorkingIssuesLoader } from '../src/worklog/workingIssuesLoader.js';
import { renderWorkingIssues, REFRESHING_ISSUES } from '../src/ui/weekView.js';

/** A client whose loads wait until resolved by hand, in any order, recording what each asked for. */
function controllableClient(site = 'https://acme.atlassian.net') {
  const pending = [];
  return {
    baseUrl: site,
    deploymentType: 'cloud',
    pending,
    getActiveIssues: (start, end, options) => new Promise((resolve, reject) => {
      pending.push({ resolve, reject, signal: options.signal, includeLogged: options.includeLogged !== false });
    })
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

const ASSIGNED = [{ issueKey: 'KAN-1', inProgress: true }];
const WITH_LOGGED = [{ issueKey: 'KAN-1', inProgress: true }, { issueKey: 'KAN-7', inProgress: false, loggedInRange: true }];

/** A loader with the switch off and its issues shown (ready), recording every state after that. */
async function loaded() {
  const states = [];
  const errors = [];
  const loader = createWorkingIssuesLoader((state) => states.push(state), { logError: (err) => errors.push(err) });
  const client = controllableClient();
  const first = loader.refresh(client, { includeRecentlyLogged: false });
  await tick();
  client.pending[0].resolve(ASSIGNED);
  await first;
  states.length = 0;
  return { loader, client, states, errors };
}

describe('Active issues - kept while Show recently logged loads them again', () => {
  it('keeps the issues shown while the new load runs, marked refreshing', async () => {
    const { loader, client, states } = await loaded();
    const flip = loader.refresh(client, { force: true, includeRecentlyLogged: true, keepShown: true });
    await tick();
    assert.deepEqual(states, [{ status: 'ready', issues: ASSIGNED, includeRecentlyLogged: false, refreshing: true }]);
    assert.equal(client.pending.length, 2, 'one new request, from the one loader');
    assert.equal(client.pending[1].includeLogged, true);
    client.pending[1].resolve(WITH_LOGGED);
    await flip;
  });

  it('replaces them with Jira\'s new issues in one state once they\'re in', async () => {
    const { loader, client, states } = await loaded();
    const flip = loader.refresh(client, { force: true, includeRecentlyLogged: true, keepShown: true });
    await tick();
    client.pending[1].resolve(WITH_LOGGED);
    await flip;
    assert.deepEqual(states.at(-1), { status: 'ready', issues: WITH_LOGGED, includeRecentlyLogged: true });
    assert.equal(states.length, 2, 'never empty, never loading in between');
    assert.ok(states.every((state) => state.status === 'ready'));
  });

  it('keeps the issues shown when the new load fails, saying why, and stops refreshing', async () => {
    const { loader, client, states, errors } = await loaded();
    const flip = loader.refresh(client, { force: true, includeRecentlyLogged: true, keepShown: true });
    await tick();
    client.pending[1].reject(new Error('Jira is unavailable.'));
    await flip;
    assert.deepEqual(states.at(-1), { status: 'ready', issues: ASSIGNED, includeRecentlyLogged: false, refreshError: 'Jira is unavailable.' });
    assert.equal(states.at(-1).refreshing, undefined);
    assert.equal(errors.length, 1);
  });

  it('loads again after a failure, keeping the same issues shown meanwhile', async () => {
    const { loader, client, states } = await loaded();
    const failed = loader.refresh(client, { force: true, includeRecentlyLogged: true, keepShown: true });
    await tick();
    client.pending[1].reject(new Error('Offline'));
    await failed;
    const retry = loader.refresh(client, { force: true, includeRecentlyLogged: true, keepShown: true });
    await tick();
    assert.deepEqual(states.at(-1), { status: 'ready', issues: ASSIGNED, includeRecentlyLogged: false, refreshing: true });
    client.pending[2].resolve(WITH_LOGGED);
    await retry;
    assert.deepEqual(states.at(-1), { status: 'ready', issues: WITH_LOGGED, includeRecentlyLogged: true });
  });

  it('applies only the last of quick flips: older loads are cancelled and their answers ignored', async () => {
    const { loader, client, states } = await loaded();
    const flips = [true, false, true].map((on) => loader.refresh(client, { force: true, includeRecentlyLogged: on, keepShown: true }));
    await tick();
    assert.deepEqual(client.pending.slice(1).map((load) => load.signal.aborted), [true, true, false]);
    // The newest answers first, then the older ones, late.
    client.pending[3].resolve(WITH_LOGGED);
    client.pending[2].resolve(ASSIGNED);
    client.pending[1].reject(new Error('Too late'));
    await Promise.all(flips);
    assert.deepEqual(states.at(-1), { status: 'ready', issues: WITH_LOGGED, includeRecentlyLogged: true });
    // Each flip showed the same issues while waiting; nothing older came after the newest.
    assert.deepEqual(states.slice(0, 3).map((state) => [state.issues, state.refreshing]), [[ASSIGNED, true], [ASSIGNED, true], [ASSIGNED, true]]);
    assert.equal(states.length, 4);
  });

  it('never shows an older answer that comes after a newer failure', async () => {
    const { loader, client, states } = await loaded();
    const older = loader.refresh(client, { force: true, includeRecentlyLogged: true, keepShown: true });
    const newer = loader.refresh(client, { force: true, includeRecentlyLogged: false, keepShown: true });
    await tick();
    client.pending[2].reject(new Error('Offline'));
    client.pending[1].resolve(WITH_LOGGED);
    await Promise.all([older, newer]);
    assert.deepEqual(states.at(-1), { status: 'ready', issues: ASSIGNED, includeRecentlyLogged: false, refreshError: 'Offline' });
  });

  it('loads as before without keepShown: loading first, and an error that replaces the issues', async () => {
    const { loader, client, states } = await loaded();
    const sync = loader.refresh(client, { force: true, includeRecentlyLogged: false });
    await tick();
    assert.deepEqual(states, [{ status: 'loading' }]);
    client.pending[1].reject(new Error('Offline'));
    await sync;
    assert.deepEqual(states.at(-1), { status: 'error', message: 'Offline' });
  });

  it('keeps nothing from another Jira site, nor before anything was loaded', async () => {
    const { loader, states } = await loaded();
    const other = controllableClient('https://other.atlassian.net');
    const flip = loader.refresh(other, { force: true, includeRecentlyLogged: true, keepShown: true });
    await tick();
    assert.deepEqual(states, [{ status: 'loading' }]);
    other.pending[0].reject(new Error('Offline'));
    await flip;
    assert.deepEqual(states.at(-1), { status: 'error', message: 'Offline' });

    const fresh = [];
    const first = createWorkingIssuesLoader((state) => fresh.push(state), { logError: () => {} });
    const client = controllableClient();
    const load = first.refresh(client, { keepShown: true });
    await tick();
    assert.deepEqual(fresh, [{ status: 'loading' }]);
    client.pending[0].resolve(ASSIGNED);
    await load;
  });

  it('keeps nothing once cleared', async () => {
    const { loader, client, states } = await loaded();
    loader.clear();
    const flip = loader.refresh(client, { force: true, includeRecentlyLogged: true, keepShown: true });
    await tick();
    assert.deepEqual(states, [null, { status: 'loading' }]);
    client.pending[1].resolve(WITH_LOGGED);
    await flip;
  });
});

describe('Active issues - the list while they load again', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  const SITE = 'cloud|https://acme.atlassian.net';
  const issue = (key) => ({ issueId: key.slice(4), issueKey: key, issueSummary: `Summary of ${key}`, issueStatus: { name: 'In Progress', categoryKey: 'indeterminate' }, inProgress: true });
  const SHOWN = [issue('KAN-1'), issue('KAN-2')];
  const REPORTED = { id: 'reported', name: 'Reported', description: 'Reporter is Me', unavailable: false, result: { status: 'ready', issues: [issue('OPS-7')], total: 1, hasMore: false, message: '' } };

  function render(state, { selectedId = 'all' } = {}) {
    const section = document.createElement('section');
    renderWorkingIssues(section, {
      state,
      expanded: true,
      pending: { entries: [], site: SITE, onEdit() {}, onDiscard() {} },
      recentlyLogged: { checked: true, onChange() {} },
      views: { items: [REPORTED], selectedId, canCreate: true, onSelect() {}, onCreate() {}, onEdit() {}, onRefresh() {} }
    });
    return section;
  }
  const rowKeys = (section) => section.querySelectorAll('.working-issue').map((row) => row.querySelector('.issue-key-badge').textContent);
  const status = (section) => section.querySelector('.working-issues-recent-status');

  it('keeps listing the issues shown, with their count, and a spinner beside the switch', () => {
    const section = render({ status: 'ready', issues: SHOWN, includeRecentlyLogged: false, refreshing: true });
    assert.deepEqual(rowKeys(section), ['KAN-1', 'KAN-2']);
    assert.equal(section.querySelector('#workingIssuesGroupToggle-active').textContent, 'Issues (2)');
    assert.equal(section.querySelector('[role="tab"]').textContent, 'Active (2)');
    assert.ok(status(section).querySelector('.working-issues-spinner'));
    assert.equal(status(section).getAttribute('role'), 'status');
    assert.equal(status(section).textContent, REFRESHING_ISSUES);
    assert.equal(section.querySelector('#workingIssuesViewPanel').getAttribute('aria-busy'), 'true');
    // Not the blank, loading list.
    assert.equal(section.querySelector('#workingIssuesViewPanel').querySelectorAll('.working-issues-empty').length, 0);
    assert.equal(section.querySelector('.working-issues-indicator').querySelector('.working-issues-spinner'), null, 'no spinner on My Work\'s header');
  });

  it('keeps the spinner out of the switch\'s label', () => {
    const section = render({ status: 'ready', issues: SHOWN, includeRecentlyLogged: false, refreshing: true });
    assert.equal(section.querySelector('.working-issues-recent').querySelector('.working-issues-spinner'), null);
  });

  it('stops the spinner once the new issues are in', () => {
    const section = render({ status: 'ready', issues: [issue('KAN-9')], includeRecentlyLogged: true });
    assert.deepEqual(rowKeys(section), ['KAN-9']);
    assert.equal(status(section).querySelector('.working-issues-spinner'), null);
    assert.equal(status(section).textContent, '');
    assert.equal(section.querySelector('#workingIssuesViewPanel').getAttribute('aria-busy'), null);
  });

  it('leaves a custom view\'s own results alone while Active loads again', () => {
    const section = render({ status: 'ready', issues: SHOWN, includeRecentlyLogged: false, refreshing: true }, { selectedId: 'reported' });
    assert.deepEqual(rowKeys(section), ['OPS-7']);
    assert.equal(section.querySelector('#workingIssuesViewPanel').getAttribute('aria-busy'), null);
    assert.equal(section.querySelector('.working-issues-recent-status'), null);
  });
});
