import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JiraClient, toIssueStatus } from '../src/jira/JiraClient.js';
import { JiraCloudTokenProvider } from '../src/auth/JiraCloudTokenProvider.js';
import { JiraPatProvider } from '../src/auth/JiraPatProvider.js';

describe('JiraClient - Worklog & Search Methods', () => {
  it('retrieves and caches current user profile', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          displayName: 'Test Dev',
          accountId: 'acc-456',
          emailAddress: 'test@example.com'
        })
      };
    };

    const provider = new JiraCloudTokenProvider('test@example.com', 'token');
    const client = new JiraClient('https://acme.atlassian.net', provider, { fetchFn: mockFetch });

    const user1 = await client.getCurrentUser();
    assert.equal(user1.displayName, 'Test Dev');
    assert.equal(user1.accountId, 'acc-456');

    // Second call should return cached profile without second fetch
    const user2 = await client.getCurrentUser();
    assert.equal(user2.accountId, 'acc-456');
    assert.equal(callCount, 1);
  });

  it('searches issues with JQL and handles pagination parameters', async () => {
    let capturedMethod = null;
    let capturedParams = null;
    let capturedPath = null;
    const mockFetch = async (url, options) => {
      capturedMethod = options.method || 'GET';
      capturedParams = new URL(url).searchParams;
      capturedPath = new URL(url).pathname;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          startAt: 0,
          maxResults: 50,
          total: 1,
          issues: [
            {
              id: '1001',
              key: 'TEST-1',
              fields: {
                summary: 'Sample Jira Issue',
                worklog: { total: 0, worklogs: [] }
              }
            }
          ]
        })
      };
    };

    const provider = new JiraCloudTokenProvider('test@example.com', 'token');
    const client = new JiraClient('https://acme.atlassian.net', provider, { fetchFn: mockFetch });

    const result = await client.searchIssues('project = TEST', { nextPageToken: 'page-2', maxResults: 25 });
    assert.equal(result.issues[0].key, 'TEST-1');
    assert.equal(capturedMethod, 'GET');
    assert.equal(capturedPath, '/rest/api/3/search/jql');
    assert.equal(capturedParams.get('nextPageToken'), 'page-2');
    assert.equal(capturedParams.has('startAt'), false);
    assert.equal(capturedParams.get('maxResults'), '25');
    assert.equal(capturedParams.get('jql'), 'project = TEST');
    assert.equal(capturedParams.get('fields'), 'summary,worklog');
  });

  it('searches Data Center / Server issues with startAt pagination on /rest/api/2/search', async () => {
    let capturedUrl = null;
    const mockFetch = async (url) => {
      capturedUrl = new URL(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ startAt: 10, maxResults: 25, total: 11, issues: [] })
      };
    };

    const provider = new JiraPatProvider('pat');
    const client = new JiraClient('https://jira.example.com', provider, { fetchFn: mockFetch });

    await client.searchIssues('project = TEST', { startAt: 10, maxResults: 25, nextPageToken: 'ignored' });
    assert.equal(capturedUrl.pathname, '/rest/api/2/search');
    assert.equal(capturedUrl.searchParams.get('startAt'), '10');
    assert.equal(capturedUrl.searchParams.has('nextPageToken'), false);
  });

  it('follows nextPageToken across Jira Cloud search pages until isLast', async () => {
    const searchTokens = [];
    const makeIssue = (id) => ({
      id,
      key: `PROJ-${id}`,
      fields: {
        summary: `Issue ${id}`,
        worklog: {
          total: 1,
          worklogs: [{
            id: `wl-${id}`,
            started: '2026-10-20T10:00:00.000',
            timeSpentSeconds: 3600,
            author: { accountId: 'acc-1', displayName: 'Dev' }
          }]
        }
      }
    });

    const mockFetch = async (url) => {
      if (url.includes('/myself')) {
        return { ok: true, status: 200, json: async () => ({ accountId: 'acc-1', displayName: 'Dev' }) };
      }
      const token = new URL(url).searchParams.get('nextPageToken');
      searchTokens.push(token);
      const body = token === 'page-2'
        ? { issues: [makeIssue('2')], isLast: true }
        : { issues: [makeIssue('1')], nextPageToken: 'page-2', isLast: false };
      return { ok: true, status: 200, json: async () => body };
    };

    const provider = new JiraCloudTokenProvider('dev@example.com', 'token');
    const client = new JiraClient('https://acme.atlassian.net', provider, { fetchFn: mockFetch });

    const result = await client.getWorklogsForDateRange(new Date(2026, 9, 19), new Date(2026, 9, 25, 23, 59, 59));
    assert.deepEqual(searchTokens, [null, 'page-2']);
    assert.deepEqual(result.worklogs.map((w) => w.issueKey), ['PROJ-1', 'PROJ-2']);
  });

  it('paginates full worklogs for issues exceeding 20 worklogs', async () => {
    const urlsRequested = [];
    const mockFetch = async (url) => {
      urlsRequested.push(url);
      if (url.includes('/worklog?startAt=0')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            startAt: 0,
            maxResults: 2,
            total: 3,
            worklogs: [
              { id: 'w1', started: '2026-10-19T09:00:00.000Z', timeSpentSeconds: 3600 },
              { id: 'w2', started: '2026-10-19T10:00:00.000Z', timeSpentSeconds: 3600 }
            ]
          })
        };
      }
      if (url.includes('/worklog?startAt=2')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            startAt: 2,
            maxResults: 2,
            total: 3,
            worklogs: [
              { id: 'w3', started: '2026-10-19T11:00:00.000Z', timeSpentSeconds: 3600 }
            ]
          })
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    };

    const provider = new JiraPatProvider('pat-test');
    const client = new JiraClient('https://jira.server.local', provider, { fetchFn: mockFetch });

    const worklogs = await client.getAllIssueWorklogs('PROJ-99');
    assert.equal(worklogs.length, 3);
    assert.equal(worklogs[0].id, 'w1');
    assert.equal(worklogs[1].id, 'w2');
    assert.equal(worklogs[2].id, 'w3');
    assert.equal(urlsRequested.length, 2);
  });

  it('fetches worklogs for date range, matches currentUser, and filters by local dates', async () => {
    const mockFetch = async (url, options) => {
      if (url.includes('/myself')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            displayName: 'Sarah Engineer',
            accountId: 'acc-sarah',
            emailAddress: 'sarah@example.com'
          })
        };
      }

      if (url.includes('/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            startAt: 0,
            maxResults: 50,
            total: 1,
            issues: [
              {
                id: '100',
                key: 'PROJ-101',
                fields: {
                  summary: 'Add weekly timesheet summary',
                  worklog: {
                    total: 2,
                    worklogs: [
                      {
                        id: 'wl-1',
                        started: '2026-10-19T09:30:00.000Z',
                        timeSpentSeconds: 7200,
                        timeSpent: '2h',
                        comment: 'Implemented daily cards',
                        author: { accountId: 'acc-sarah', displayName: 'Sarah Engineer' }
                      },
                      {
                        // Worklog by someone else
                        id: 'wl-2',
                        started: '2026-10-19T10:00:00.000Z',
                        timeSpentSeconds: 3600,
                        timeSpent: '1h',
                        comment: 'Code review',
                        author: { accountId: 'acc-other', displayName: 'Other Dev' }
                      }
                    ]
                  }
                }
              }
            ]
          })
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const provider = new JiraCloudTokenProvider('sarah@example.com', 'api-token');
    const client = new JiraClient('https://acme.atlassian.net', provider, { fetchFn: mockFetch });

    const startDate = new Date(2026, 9, 19); // Oct 19, 2026
    const endDate = new Date(2026, 9, 25);   // Oct 25, 2026

    const result = await client.getWorklogsForDateRange(startDate, endDate);

    assert.equal(result.user.accountId, 'acc-sarah');
    // Only Sarah's worklog should be included
    assert.equal(result.worklogs.length, 1);
    assert.equal(result.worklogs[0].id, 'wl-1');
    assert.equal(result.worklogs[0].issueKey, 'PROJ-101');
    assert.equal(result.worklogs[0].issueSummary, 'Add weekly timesheet summary');
    assert.equal(result.worklogs[0].timeSpentSeconds, 7200);
    assert.equal(result.worklogs[0].comment, 'Implemented daily cards');
  });

  it('handles empty week results gracefully', async () => {
    const mockFetch = async (url) => {
      if (url.includes('/myself')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            displayName: 'Dev User',
            name: 'devuser'
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          startAt: 0,
          maxResults: 50,
          total: 0,
          issues: []
        })
      };
    };

    const provider = new JiraPatProvider('pat-val');
    const client = new JiraClient('https://jira.corp.internal', provider, { fetchFn: mockFetch });

    const result = await client.getWorklogsForDateRange(new Date(2026, 9, 19), new Date(2026, 9, 25));
    assert.equal(result.worklogs.length, 0);
  });

  it('requests the issue status in the same search and attaches it to each worklog', async () => {
    const searchFields = [];
    const makeFetch = (status) => async (url) => {
      if (url.includes('/myself')) {
        return { ok: true, status: 200, json: async () => ({ accountId: 'acc-1', name: 'dev', displayName: 'Dev' }) };
      }
      searchFields.push(new URL(url).searchParams.get('fields'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total: 1,
          issues: [{
            id: '1',
            key: 'EKB-30755',
            fields: {
              summary: 'Status test',
              status,
              worklog: {
                total: 1,
                worklogs: [{
                  id: 'wl-1',
                  started: '2026-10-20T10:00:00.000',
                  timeSpentSeconds: 3600,
                  author: { accountId: 'acc-1', name: 'dev', displayName: 'Dev' }
                }]
              }
            }
          }]
        })
      };
    };

    const cloud = new JiraClient('https://acme.atlassian.net', new JiraCloudTokenProvider('dev@example.com', 'token'), {
      fetchFn: makeFetch({ name: 'In Review', statusCategory: { key: 'indeterminate', colorName: 'yellow' } })
    });
    const cloudResult = await cloud.getWorklogsForDateRange(new Date(2026, 9, 19), new Date(2026, 9, 25));
    assert.deepEqual(cloudResult.worklogs[0].issueStatus, { name: 'In Review', categoryKey: 'indeterminate' });

    const dataCenter = new JiraClient('https://jira.example.com', new JiraPatProvider('pat'), {
      fetchFn: makeFetch({ name: 'Closed', statusCategory: { key: 'done' } })
    });
    const dcResult = await dataCenter.getWorklogsForDateRange(new Date(2026, 9, 19), new Date(2026, 9, 25));
    assert.deepEqual(dcResult.worklogs[0].issueStatus, { name: 'Closed', categoryKey: 'done' });

    const missing = new JiraClient('https://jira.example.com', new JiraPatProvider('pat'), { fetchFn: makeFetch(undefined) });
    const missingResult = await missing.getWorklogsForDateRange(new Date(2026, 9, 19), new Date(2026, 9, 25));
    assert.equal(missingResult.worklogs[0].issueStatus, null);

    // One search per load, with status requested alongside the existing fields
    assert.deepEqual(searchFields, ['summary,status,worklog', 'summary,status,worklog', 'summary,status,worklog']);
  });
});

describe('toIssueStatus', () => {
  it('keeps the status name and category key', () => {
    assert.deepEqual(
      toIssueStatus({ name: ' Waiting for Customer ', statusCategory: { key: 'indeterminate' } }),
      { name: 'Waiting for Customer', categoryKey: 'indeterminate' }
    );
  });

  it('keeps custom statuses without a category', () => {
    assert.deepEqual(toIssueStatus({ name: 'Parked' }), { name: 'Parked', categoryKey: '' });
  });

  it('returns null when the status or its name is missing', () => {
    assert.equal(toIssueStatus(undefined), null);
    assert.equal(toIssueStatus(null), null);
    assert.equal(toIssueStatus({}), null);
    assert.equal(toIssueStatus({ name: '   ', statusCategory: { key: 'done' } }), null);
  });
});
