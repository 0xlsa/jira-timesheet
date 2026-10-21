import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JiraUrlValidator } from '../src/validation/JiraUrlValidator.js';
import { JiraCloudTokenProvider } from '../src/auth/JiraCloudTokenProvider.js';
import { JiraPatProvider } from '../src/auth/JiraPatProvider.js';
import { JiraClient } from '../src/jira/JiraClient.js';
import { handleFetchWorklogs } from '../background.js';

describe('Background and End-to-End Handlers', () => {
  it('validates and handles Cloud test connection requests', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        displayName: 'Integration User',
        emailAddress: 'integration@example.com',
        active: true
      })
    });

    const payload = {
      baseUrl: 'https://test-company.atlassian.net',
      deploymentType: 'cloud',
      email: 'integration@example.com',
      token: 'valid-api-token'
    };

    const urlCheck = JiraUrlValidator.validate(payload.baseUrl);
    assert.equal(urlCheck.isValid, true);

    const provider = new JiraCloudTokenProvider(payload.email, payload.token);
    const client = new JiraClient(urlCheck.sanitizedUrl, provider, { fetchFn: mockFetch });
    const result = await client.testConnection();

    assert.equal(result.success, true);
    assert.equal(result.user.displayName, 'Integration User');
    assert.equal(result.deploymentType, 'cloud');
  });

  it('validates and handles Server/Data Center test connection requests', async () => {
    const mockFetch = async (url) => {
      if (url.includes('/myself')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            displayName: 'DC Admin',
            name: 'admin'
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          version: '9.12.0',
          deploymentType: 'Data Center',
          serverTitle: 'Jira Enterprise'
        })
      };
    };

    const payload = {
      baseUrl: 'https://jira.enterprise.local/jira',
      deploymentType: 'server',
      token: 'sample-pat-token'
    };

    const urlCheck = JiraUrlValidator.validate(payload.baseUrl);
    assert.equal(urlCheck.isValid, true);
    assert.equal(urlCheck.sanitizedUrl, 'https://jira.enterprise.local/jira');

    const provider = new JiraPatProvider(payload.token);
    const client = new JiraClient(urlCheck.sanitizedUrl, provider, { fetchFn: mockFetch });
    const result = await client.testConnection();

    assert.equal(result.success, true);
    assert.equal(result.user.displayName, 'DC Admin');
    assert.equal(result.deploymentType, 'server');
    assert.equal(result.serverInfo.version, '9.12.0');
  });

  it('rejects connection if host origin validation fails', async () => {
    const payload = {
      baseUrl: 'http://insecure.example.com',
      deploymentType: 'server',
      token: 'pat'
    };

    const urlCheck = JiraUrlValidator.validate(payload.baseUrl);
    assert.equal(urlCheck.isValid, false);
    assert.match(urlCheck.error, /HTTPS/i);
  });

  it('handles FETCH_WORKLOGS requests via handleFetchWorklogs', async () => {
    const mockFetch = async (url) => {
      if (url.includes('/myself')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            displayName: 'Backend Worker User',
            accountId: 'acc-worker-1',
            emailAddress: 'worker@example.com'
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
                id: '2001',
                key: 'SYNC-100',
                fields: {
                  summary: 'Build weekly calendar synchronization',
                  worklog: {
                    total: 1,
                    worklogs: [
                      {
                        id: 'w-100',
                        started: '2026-10-21T11:00:00.000Z',
                        timeSpentSeconds: 14400, // 4h
                        timeSpent: '4h',
                        comment: 'Implemented backend messaging',
                        author: { accountId: 'acc-worker-1', displayName: 'Backend Worker User' }
                      }
                    ]
                  }
                }
              }
            ]
          })
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    };

    const payload = {
      baseUrl: 'https://test-company.atlassian.net',
      deploymentType: 'cloud',
      email: 'worker@example.com',
      token: 'valid-api-token',
      startDate: new Date(2026, 9, 19),
      endDate: new Date(2026, 9, 25)
    };

    const result = await handleFetchWorklogs(payload, { fetchFn: mockFetch });
    assert.equal(result.success, true);
    assert.equal(result.user.displayName, 'Backend Worker User');
    assert.equal(result.weekTotalSeconds, 14400);
    assert.equal(result.formattedWeekTotal, '4h 00m');
    assert.equal(result.totalWorklogsCount, 1);
    assert.equal(result.weekDays.length, 7);

    // Wednesday (Oct 21) should have the 4h worklog
    const wednesday = result.weekDays.find((d) => d.dateKey === '2026-10-21');
    assert.ok(wednesday);
    assert.equal(wednesday.worklogCount, 1);
    assert.equal(wednesday.totalDurationSeconds, 14400);
    assert.equal(wednesday.formattedTotal, '4h 00m');
    assert.equal(wednesday.worklogs[0].issueKey, 'SYNC-100');
  });
});

