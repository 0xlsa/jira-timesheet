process.env.TZ = 'Europe/London';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JiraClient } from '../src/jira/JiraClient.js';
import { JiraCloudTokenProvider } from '../src/auth/JiraCloudTokenProvider.js';
import { submitPendingWorklog, isDefiniteFailure, findSubmittedWorklog } from '../src/worklog/pendingSubmission.js';
import { createTimeTrackingStore, siteId, TIME_TRACKING_KEY, STALE_SUBMISSION_MS } from '../src/timer/timeTrackingStore.js';
import { createTimerController } from '../src/timer/timerController.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';

const SITE = siteId('cloud', 'https://acme.atlassian.net');
// Monday 26 October 2026, 09:15 in London (GMT).
const T0 = Date.UTC(2026, 9, 26, 9, 15);
const ME = { accountId: 'u1', displayName: 'Test User' };

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

/**
 * A Jira Cloud client whose fetch records each request and answers with `respond(request)`;
 * `respond` may throw, as fetch does on a network failure.
 */
function jira(respond) {
  const requests = [];
  const fetchFn = async (url, options) => {
    const request = { url: new URL(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    // Like fetch, an aborted request (the client's timeout) rejects with an AbortError.
    const aborted = new Promise((_, reject) => {
      options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    return Promise.race([Promise.resolve().then(() => respond(request)), aborted]);
  };
  const client = new JiraClient('https://acme.atlassian.net', new JiraCloudTokenProvider('dev@example.com', 'token'), { fetchFn, timeoutMs: 1000 });
  const posts = () => requests.filter((r) => r.method === 'POST');
  return { client, requests, posts };
}

/** A page's timer on in-memory storage, with one pending worklog for KAN-20 (25 min, a comment). */
async function pageWithPending({ seconds = 1500, comment = 'Wrote the setup guide', site = SITE } = {}) {
  const storage = createMemoryStorageArea();
  let tail = Promise.resolve();
  const lock = { run(fn) { const r = tail.then(() => fn()); tail = r.catch(() => {}); return r; } };
  let clock = T0;
  const store = createTimeTrackingStore(storage, { lock, now: () => clock });
  const timer = createTimerController({
    createStore: () => store,
    watchStorage: () => () => {},
    onChange: () => {}, onTick: () => {}, onError: () => {}, logError: () => {},
    setInterval: () => 1, clearInterval: () => {}
  });
  await timer.init();
  await timer.start({ site, issueId: '10020', issueKey: 'KAN-20', issueSummary: 'Write the docs' });
  clock += seconds * 1000;
  await timer.stop();
  const [entry] = timer.getState().tracking.pending;
  if (comment) await timer.updatePending(entry.id, { comment });
  const pending = () => timer.getState().tracking.pending;
  return { storage, store, timer, entry: pending()[0], pending, advance: (ms) => { clock += ms; } };
}

const submit = (page, client, extra = {}) =>
  submitPendingWorklog({ timer: page.timer, client, id: page.entry.id, site: SITE, author: ME, ...extra });

const created = (request) => json(201, {
  id: '50001', started: request.body.started, timeSpentSeconds: request.body.timeSpentSeconds, timeSpent: '25m',
  comment: request.body.comment, author: ME
});

describe('Submitting a pending worklog', () => {
  it('creates the worklog with the session\'s issue, start, duration, and comment, then removes it', async () => {
    const page = await pageWithPending();
    const { client, posts } = jira(created);

    const result = await submit(page, client);

    assert.equal(result.status, 'submitted');
    assert.equal(posts().length, 1);
    assert.equal(posts()[0].url.pathname, '/rest/api/3/issue/10020/worklog');
    assert.equal(posts()[0].body.started, '2026-10-26T09:15:00.000+0000');
    assert.equal(posts()[0].body.timeSpentSeconds, 1500);
    assert.deepEqual(posts()[0].body.comment, {
      type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Wrote the setup guide' }] }]
    });
    assert.deepEqual([result.worklog.id, result.worklog.issueKey, result.worklog.timeSpentSeconds], ['50001', 'KAN-20', 1500]);
    assert.deepEqual(page.pending(), []);
  });

  it('leaves out a blank comment, as logging work by hand does', async () => {
    const page = await pageWithPending({ comment: '' });
    const { client, posts } = jira(created);
    await submit(page, client);
    assert.equal('comment' in posts()[0].body, false);
  });

  it('keeps the pending worklog while Jira hasn\'t answered, marked as being submitted', async () => {
    const page = await pageWithPending();
    let answer;
    const { client } = jira((request) => new Promise((resolve) => { answer = () => resolve(created(request)); }));

    const submitting = submit(page, client);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(page.pending().length, 1);
    assert.equal(page.pending()[0].submission.state, 'submitting');
    // A second click (or tab) can't send it again meanwhile.
    await assert.rejects(submit(page, client), /already being submitted/);

    answer();
    assert.equal((await submitting).status, 'submitted');
    assert.deepEqual(page.pending(), []);
  });

  it('keeps it as not submitted when Jira refuses, with Jira\'s reason; submitting again sends it again', async () => {
    const page = await pageWithPending();
    let refuse = true;
    const { client, posts } = jira((request) => (refuse
      ? json(403, { errorMessages: ['You do not have the permission to log work on this issue.'] })
      : created(request)));

    const result = await submit(page, client);
    assert.equal(result.status, 'failed');
    assert.match(result.message, /permission to log work/);
    assert.equal(page.pending()[0].submission.state, 'failed');

    refuse = false;
    assert.equal((await submit(page, client)).status, 'submitted');
    assert.equal(posts().length, 2);
    assert.deepEqual(page.pending(), []);
  });

  for (const [what, respond] of [
    ['a timeout', () => new Promise(() => {})],
    ['a network failure', () => { throw new TypeError('Failed to fetch'); }],
    ['a server error', () => json(503, {})],
    ['an unreadable answer to an accepted request', () => ({ ok: true, status: 201, json: async () => { throw new SyntaxError('Unexpected token <'); } })]
  ]) {
    it(`keeps it as possibly in Jira after ${what}, never sending it again blindly`, async () => {
      const page = await pageWithPending();
      const { client, posts } = jira(respond);

      const result = await submit(page, client);

      assert.equal(result.status, 'uncertain');
      assert.match(result.message, /may or may not have KAN-20's worklog/);
      assert.equal(posts().length, 1);
      assert.equal(page.pending().length, 1);
      assert.equal(page.pending()[0].submission.state, 'uncertain');
    });
  }

  it('after an uncertain submission, finds the worklog in Jira and removes it without sending it again', async () => {
    const page = await pageWithPending();
    let jiraHasIt = false;
    const { client, posts, requests } = jira((request) => {
      if (request.method === 'POST') {
        jiraHasIt = true;
        throw new TypeError('Failed to fetch');
      }
      if (request.url.pathname.endsWith('/myself')) return json(200, ME);
      // The issue's worklogs: Jira kept the start to the minute.
      return json(200, { startAt: 0, total: 1, worklogs: jiraHasIt ? [{ id: '50001', author: ME, started: '2026-10-26T09:15:00.000+0000', timeSpentSeconds: 1500 }] : [] });
    });

    assert.equal((await submit(page, client)).status, 'uncertain');
    const result = await submit(page, client);

    assert.equal(result.status, 'already-in-jira');
    assert.equal(result.worklog.id, '50001');
    assert.equal(posts().length, 1, 'sent once only');
    assert.ok(requests.some((r) => r.url.pathname === '/rest/api/3/issue/10020/worklog' && r.method === 'GET'));
    assert.deepEqual(page.pending(), []);
  });

  it('after an uncertain submission, sends it once more when Jira doesn\'t have it', async () => {
    const page = await pageWithPending();
    let failPost = true;
    const { client, posts } = jira((request) => {
      if (request.method === 'POST') {
        if (failPost) return json(502, {});
        return created(request);
      }
      if (request.url.pathname.endsWith('/myself')) return json(200, ME);
      // Someone else's worklog, and one of the user's at another time, aren't this one.
      return json(200, { startAt: 0, total: 2, worklogs: [
        { id: '1', author: { accountId: 'other' }, started: '2026-10-26T09:15:00.000+0000', timeSpentSeconds: 1500 },
        { id: '2', author: ME, started: '2026-10-26T14:00:00.000+0000', timeSpentSeconds: 1500 }
      ] });
    });

    assert.equal((await submit(page, client)).status, 'uncertain');
    failPost = false;
    assert.equal((await submit(page, client)).status, 'submitted');
    assert.equal(posts().length, 2);
  });

  it('sends nothing when it can\'t check Jira after an uncertain submission', async () => {
    const page = await pageWithPending();
    let checks = 0;
    const { client, posts } = jira((request) => {
      if (request.method === 'POST') return json(504, {});
      checks++;
      throw new TypeError('Failed to fetch');
    });

    await submit(page, client);
    const result = await submit(page, client);

    assert.equal(result.status, 'uncertain');
    assert.match(result.message, /Couldn't check whether Jira already has/);
    assert.ok(checks > 0);
    assert.equal(posts().length, 1);
    assert.equal(page.pending()[0].submission.state, 'uncertain');
  });

  it('treats a submission left running (its page closed mid-request) as uncertain: checks before sending', async () => {
    const page = await pageWithPending();
    await page.timer.beginSubmission(page.entry.id, { site: SITE });
    page.advance(STALE_SUBMISSION_MS + 1000);
    const { client, posts } = jira((request) => {
      if (request.method === 'POST') return created(request);
      if (request.url.pathname.endsWith('/myself')) return json(200, ME);
      return json(200, { startAt: 0, total: 1, worklogs: [{ id: '50001', author: ME, started: '2026-10-26T09:15:00.000+0000', timeSpentSeconds: 1500 }] });
    });

    assert.equal((await submit(page, client)).status, 'already-in-jira');
    assert.equal(posts().length, 0);
  });

  it('refuses a session under a minute, sending nothing', async () => {
    const page = await pageWithPending({ seconds: 45 });
    const { client, requests } = jira(created);
    await assert.rejects(submit(page, client), /at least 1 minute/);
    assert.equal(requests.length, 0);
    assert.equal(page.pending().length, 1);
  });

  it('refuses a worklog tracked on another Jira site, sending nothing', async () => {
    const page = await pageWithPending({ site: siteId('server', 'https://jira.example.com') });
    const { client, requests } = jira(created);
    await assert.rejects(submit(page, client), /tracked on jira\.example\.com, not the Jira site you're connected to/);
    assert.equal(requests.length, 0);
  });

  it('refuses a worklog changed in another tab since the user chose to submit it', async () => {
    const page = await pageWithPending();
    const { client, requests } = jira(created);
    const expected = { startedAt: page.entry.startedAt, timeSpentSeconds: page.entry.timeSpentSeconds, comment: page.entry.comment };
    await page.store.updatePending(page.entry.id, { timeSpentSeconds: 600 });
    await assert.rejects(submit(page, client, { expected }), /changed in another tab/);
    assert.equal(requests.length, 0);
  });

  it('reports a submission Jira accepted even when Pending can\'t be updated afterwards', async () => {
    const page = await pageWithPending();
    const { client } = jira(created);
    const set = page.storage.set;
    let writes = 0;
    // The mark before sending is stored; the removal after Jira's answer fails.
    page.storage.set = async (items) => {
      if (++writes > 1) throw new Error('QUOTA_BYTES quota exceeded');
      return set(items);
    };

    const result = await submit(page, client);
    assert.equal(result.status, 'submitted');
    assert.match(result.message, /couldn't be removed from Pending/);
    // Still marked as being submitted: once stale, it's checked in Jira, never sent twice.
    assert.equal((await page.store.load()).pending[0].submission.state, 'submitting');
  });
});

describe('Submitting a pending worklog - outcomes', () => {
  it('treats only Jira\'s refusals as definite failures', () => {
    for (const errorType of ['AUTH_INVALID', 'XSRF', 'FORBIDDEN', 'NOT_FOUND', 'INVALID', 'HTTP_ERROR']) {
      assert.equal(isDefiniteFailure(Object.assign(new Error('x'), { errorType })), true, errorType);
    }
    for (const errorType of ['TIMEOUT', 'NETWORK_ERROR', 'UNKNOWN_ERROR', 'SERVER_ERROR', undefined]) {
      assert.equal(isDefiniteFailure(Object.assign(new Error('x'), { errorType })), false, String(errorType));
    }
  });

  it('matches Jira\'s worklog by author, start, and duration, to the minute', async () => {
    const entry = { issueId: '10020', issueKey: 'KAN-20', startedAt: T0 + 30_000, timeSpentSeconds: 1530 };
    const worklogs = [
      { id: 'a', author: ME, started: '2026-10-26T09:15:00.000+0000', timeSpentSeconds: 1500 },
      { id: 'b', author: ME, started: '2026-10-26T09:20:00.000+0000', timeSpentSeconds: 1530 }
    ];
    const client = { getCurrentUser: async () => ME, getAllIssueWorklogs: async () => worklogs };
    assert.equal((await findSubmittedWorklog(client, entry)).id, 'a');
    assert.equal(await findSubmittedWorklog(client, { ...entry, timeSpentSeconds: 3600 }), null);
  });

  it('never stores Jira credentials with the pending worklog', async () => {
    const page = await pageWithPending();
    const { client } = jira(() => json(403, {}));
    await submit(page, client);
    assert.doesNotMatch(JSON.stringify((await page.storage.get(TIME_TRACKING_KEY))[TIME_TRACKING_KEY]), /token|dev@example\.com/);
  });
});
