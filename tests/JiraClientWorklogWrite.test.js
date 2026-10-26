process.env.TZ = 'Europe/London';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JiraClient } from '../src/jira/JiraClient.js';
import { JiraCloudTokenProvider } from '../src/auth/JiraCloudTokenProvider.js';
import { JiraPatProvider } from '../src/auth/JiraPatProvider.js';

/**
 * Builds a client whose fetch records each request and answers with `respond(request)`.
 */
function setup(edition, respond) {
  const requests = [];
  const fetchFn = async (url, options) => {
    const request = { url: new URL(url), method: options.method || 'GET', headers: options.headers, body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    return respond(request);
  };
  const client = edition === 'cloud'
    ? new JiraClient('https://acme.atlassian.net', new JiraCloudTokenProvider('dev@example.com', 'token'), { fetchFn })
    : new JiraClient('https://jira.example.com/jira', new JiraPatProvider('pat'), { fetchFn });
  return { client, requests };
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('JiraClient - updateWorklog', () => {
  it('updates a Jira Cloud worklog by ID with only the changed fields, comment as ADF', async () => {
    const { client, requests } = setup('cloud', () => json(200, { id: '10042', timeSpentSeconds: 5400 }));

    const saved = await client.updateWorklog('100', '10042', {
      started: new Date(2026, 9, 22, 9, 39),
      timeSpentSeconds: 5400,
      comment: 'Line 1\nLine 2'
    });

    assert.equal(saved.id, '10042');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'PUT');
    assert.equal(requests[0].url.pathname, '/rest/api/3/issue/100/worklog/10042');
    assert.equal(requests[0].headers['Content-Type'], 'application/json');
    assert.deepEqual(requests[0].body, {
      started: '2026-10-22T09:39:00.000+0100',
      timeSpentSeconds: 5400,
      comment: {
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Line 1' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Line 2' }] }
        ]
      }
    });
  });

  it('updates a Data Center / Server worklog on API v2 with a plain-text comment', async () => {
    const { client, requests } = setup('server', () => json(200, { id: '7' }));

    await client.updateWorklog('PROJ-1', '7', { comment: 'Reviewed' });

    assert.equal(requests[0].url.pathname, '/jira/rest/api/2/issue/PROJ-1/worklog/7');
    assert.deepEqual(requests[0].body, { comment: 'Reviewed' });
  });

  it('leaves out fields that were not changed', async () => {
    const { client, requests } = setup('cloud', () => json(200, {}));
    await client.updateWorklog('100', '10042', { timeSpentSeconds: 60 });
    assert.deepEqual(requests[0].body, { timeSpentSeconds: 60 });
  });

  it('refuses invalid durations and empty updates without calling Jira', async () => {
    const { client, requests } = setup('cloud', () => json(200, {}));
    await assert.rejects(client.updateWorklog('100', '1', { timeSpentSeconds: 0 }), /at least 1 minute/);
    await assert.rejects(client.updateWorklog('100', '1', { timeSpentSeconds: 90.5 }), /whole number/);
    await assert.rejects(client.updateWorklog('100', '1', {}), /No worklog changes/);
    await assert.rejects(client.updateWorklog('', '1', { timeSpentSeconds: 60 }), /required/);
    assert.equal(requests.length, 0);
  });

  it('explains permission, authentication, missing-worklog, validation, and server errors', async () => {
    const cases = [
      [403, { errorMessages: ['You do not have the permission to edit this worklog.'] }, 'FORBIDDEN', /don't have permission to edit this worklog.*Jira says: You do not have the permission/],
      [401, {}, 'AUTH_INVALID', /token may have expired/],
      [404, {}, 'NOT_FOUND', /no longer exists/],
      [400, { errors: { timeLogged: 'Time Spent: Invalid time duration entered.' } }, 'INVALID', /didn't accept the changes.*Invalid time duration/],
      [503, {}, 'SERVER_ERROR', /server error \(503\)/]
    ];

    for (const [status, body, errorType, message] of cases) {
      const { client } = setup('cloud', () => json(status, body));
      await assert.rejects(client.updateWorklog('100', '10042', { timeSpentSeconds: 60 }), (err) => {
        assert.equal(err.errorType, errorType);
        assert.equal(err.status, status);
        assert.match(err.message, message);
        return true;
      });
    }
  });

  it('handles a non-JSON error body', async () => {
    const { client } = setup('server', () => ({ ok: false, status: 403, json: async () => { throw new SyntaxError('html'); } }));
    await assert.rejects(client.updateWorklog('A-1', '1', { comment: 'x' }), /^Error: You don't have permission to edit this worklog in Jira\.$/);
  });

  it('reports network failures and timeouts clearly', async () => {
    const offline = setup('cloud', () => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(offline.client.updateWorklog('100', '1', { timeSpentSeconds: 60 }), (err) => {
      assert.equal(err.errorType, 'NETWORK_ERROR');
      assert.match(err.message, /Unable to reach the Jira server/);
      return true;
    });

    const slow = setup('cloud', () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
    await assert.rejects(slow.client.updateWorklog('100', '1', { timeSpentSeconds: 60 }), (err) => err.errorType === 'TIMEOUT');
  });
});

describe('JiraClient - deleteWorklog', () => {
  it('deletes the worklog by ID on each edition', async () => {
    const cloud = setup('cloud', () => ({ ok: true, status: 204, json: async () => { throw new Error('no body'); } }));
    await cloud.client.deleteWorklog('100', '10042');
    assert.equal(cloud.requests[0].method, 'DELETE');
    assert.equal(cloud.requests[0].url.pathname, '/rest/api/3/issue/100/worklog/10042');

    const server = setup('server', () => ({ ok: true, status: 204, json: async () => ({}) }));
    await server.client.deleteWorklog('PROJ-1', '7');
    assert.equal(server.requests[0].url.pathname, '/jira/rest/api/2/issue/PROJ-1/worklog/7');
  });

  it('explains a failed deletion', async () => {
    const { client } = setup('cloud', () => json(403, {}));
    await assert.rejects(client.deleteWorklog('100', '1'), (err) => {
      assert.equal(err.errorType, 'FORBIDDEN');
      assert.match(err.message, /permission to delete this worklog/);
      return true;
    });
  });
});

describe('JiraClient - createWorklog', () => {
  it('creates a Jira Cloud worklog on the issue with an ADF comment', async () => {
    const { client, requests } = setup('cloud', () => json(201, { id: '10099', timeSpentSeconds: 1800 }));

    const created = await client.createWorklog('100', {
      started: new Date(2026, 9, 22, 9, 39),
      timeSpentSeconds: 1800,
      comment: 'Pairing'
    });

    assert.equal(created.id, '10099');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url.pathname, '/rest/api/3/issue/100/worklog');
    assert.equal(requests[0].headers['Content-Type'], 'application/json');
    assert.deepEqual(requests[0].body, {
      started: '2026-10-22T09:39:00.000+0100',
      timeSpentSeconds: 1800,
      comment: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pairing' }] }] }
    });
  });

  it('creates a Data Center / Server worklog on API v2, without a comment when none is given', async () => {
    const { client, requests } = setup('server', () => json(201, { id: '8' }));
    await client.createWorklog('PROJ-1', { started: new Date(2026, 11, 1, 9, 0), timeSpentSeconds: 900 });
    assert.equal(requests[0].url.pathname, '/jira/rest/api/2/issue/PROJ-1/worklog');
    assert.deepEqual(requests[0].body, { started: '2026-12-01T09:00:00.000+0000', timeSpentSeconds: 900 });
  });

  it('refuses incomplete or invalid worklogs without calling Jira', async () => {
    const { client, requests } = setup('cloud', () => json(201, {}));
    await assert.rejects(client.createWorklog('', { started: new Date(), timeSpentSeconds: 60 }), /issue is required/);
    await assert.rejects(client.createWorklog('100', { timeSpentSeconds: 60 }), /start time and a duration/);
    await assert.rejects(client.createWorklog('100', { started: new Date(), timeSpentSeconds: 30 }), /at least 1 minute/);
    assert.equal(requests.length, 0);
  });

  it('explains permission, missing-issue, validation, and network errors', async () => {
    const cases = [
      [403, {}, 'FORBIDDEN', /don't have permission to log work on this issue/],
      [404, {}, 'NOT_FOUND', /issue no longer exists/],
      [400, { errorMessages: ['Time Tracking is not enabled.'] }, 'INVALID', /didn't accept the worklog.*Time Tracking is not enabled/],
      [401, {}, 'AUTH_INVALID', /token may have expired/]
    ];
    for (const [status, body, errorType, message] of cases) {
      const { client } = setup('server', () => json(status, body));
      await assert.rejects(client.createWorklog('PROJ-1', { started: new Date(), timeSpentSeconds: 60 }), (err) => {
        assert.equal(err.errorType, errorType);
        assert.match(err.message, message);
        return true;
      });
    }

    const offline = setup('cloud', () => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(offline.client.createWorklog('100', { started: new Date(), timeSpentSeconds: 60 }), (err) => err.errorType === 'NETWORK_ERROR');
  });
});

describe('JiraClient - Jira XSRF check on write requests', () => {
  const text = (status, body) => ({ ok: false, status, text: async () => body, json: async () => JSON.parse(body) });

  it('sends a non-browser User-Agent on create, update, and delete, but not on search', async () => {
    const { client, requests } = setup('cloud', (req) => (req.method === 'GET'
      ? json(200, { issues: [], isLast: true })
      : json(req.method === 'DELETE' ? 204 : 200, { id: '1' })));

    await client.createWorklog('100', { started: new Date(2026, 9, 22, 9, 0), timeSpentSeconds: 60 });
    await client.updateWorklog('100', '1', { timeSpentSeconds: 120 });
    await client.deleteWorklog('100', '1');
    await client.searchIssues('project = KAN');

    const userAgents = requests.map((r) => `${r.method} ${r.headers['User-Agent'] ?? '-'}`);
    assert.deepEqual(userAgents, ['POST Timesheet-for-Jira', 'PUT Timesheet-for-Jira', 'DELETE Timesheet-for-Jira', 'GET -']);
    // The XSRF bypass header is still sent.
    assert.ok(requests.every((r) => r.headers['X-Atlassian-Token'] === 'no-check'));
  });

  it('reports an XSRF rejection as such, not as a missing permission', async () => {
    const { client } = setup('cloud', () => text(403, 'XSRF check failed'));
    await assert.rejects(client.createWorklog('100', { started: new Date(), timeSpentSeconds: 60 }), (err) => {
      assert.equal(err.errorType, 'XSRF');
      assert.match(err.message, /XSRF\) protection rejected the request.*Jira says: XSRF check failed/);
      assert.doesNotMatch(err.message, /permission/);
      return true;
    });
  });

  it('shows a short plain-text reason, but not an HTML error page', async () => {
    const plain = setup('server', () => text(403, 'Forbidden by proxy rule 12'));
    await assert.rejects(plain.client.deleteWorklog('A-1', '1'), /permission to delete this worklog in Jira\. Jira says: Forbidden by proxy rule 12$/);

    const html = setup('server', () => text(403, '<!DOCTYPE html><html><body>Access denied</body></html>'));
    await assert.rejects(html.client.deleteWorklog('A-1', '1'), /^Error: You don't have permission to delete this worklog in Jira\.$/);
  });

  it('still reads JSON error bodies through text()', async () => {
    const { client } = setup('cloud', () => text(400, JSON.stringify({ errors: { timeLogged: 'Invalid time duration entered.' } })));
    await assert.rejects(client.createWorklog('100', { started: new Date(), timeSpentSeconds: 60 }), (err) => {
      assert.equal(err.errorType, 'INVALID');
      assert.match(err.message, /Jira says: Invalid time duration entered\./);
      return true;
    });
  });
});
