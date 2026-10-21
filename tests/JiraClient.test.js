import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JiraClient } from '../src/jira/JiraClient.js';
import { JiraCloudTokenProvider } from '../src/auth/JiraCloudTokenProvider.js';
import { JiraPatProvider } from '../src/auth/JiraPatProvider.js';

describe('JiraClient', () => {
  it('successfully verifies connection for Jira Cloud', async () => {
    let capturedUrl = '';
    let capturedHeaders = {};

    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          displayName: 'Jane Cloud',
          emailAddress: 'jane@example.com',
          accountId: 'acc-12345',
          active: true
        })
      };
    };

    const provider = new JiraCloudTokenProvider('jane@example.com', 'my-token');
    const client = new JiraClient('https://company.atlassian.net', provider, { fetchFn: mockFetch });

    const result = await client.testConnection();

    assert.equal(result.success, true);
    assert.equal(result.user.displayName, 'Jane Cloud');
    assert.equal(result.user.emailAddress, 'jane@example.com');
    assert.equal(result.user.active, true);
    assert.equal(result.deploymentType, 'cloud');
    assert.equal(capturedUrl, 'https://company.atlassian.net/rest/api/3/myself');
    assert.ok(capturedHeaders['Authorization'].startsWith('Basic '));
    assert.equal(capturedHeaders['Accept'], 'application/json');
    assert.equal(capturedHeaders['X-Atlassian-Token'], 'no-check');
  });

  it('falls back to v2 myself endpoint for Cloud if v3 returns 404', async () => {
    const requestedUrls = [];
    const mockFetch = async (url) => {
      requestedUrls.push(url);
      if (url.includes('/rest/api/3/myself')) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ errorMessages: ['Not found'] })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          displayName: 'Jane Fallback',
          name: 'jane_fb'
        })
      };
    };

    const provider = new JiraCloudTokenProvider('jane@example.com', 'my-token');
    const client = new JiraClient('https://company.atlassian.net', provider, { fetchFn: mockFetch });

    const result = await client.testConnection();

    assert.equal(result.success, true);
    assert.equal(result.user.displayName, 'Jane Fallback');
    assert.deepEqual(requestedUrls, [
      'https://company.atlassian.net/rest/api/3/myself',
      'https://company.atlassian.net/rest/api/2/myself'
    ]);
  });

  it('successfully verifies connection and fetches serverInfo for Jira Data Center', async () => {
    const requestedUrls = [];
    const mockFetch = async (url, options) => {
      requestedUrls.push(url);
      if (url.includes('/myself')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            displayName: 'Bob Admin',
            name: 'badmin',
            active: true
          })
        };
      }
      if (url.includes('/serverInfo')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            version: '9.4.0',
            deploymentType: 'Data Center',
            serverTitle: 'Corp Jira DC'
          })
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    };

    const provider = new JiraPatProvider('pat-test-secret');
    const client = new JiraClient('https://jira.corp.internal/jira', provider, { fetchFn: mockFetch });

    const result = await client.testConnection();

    assert.equal(result.success, true);
    assert.equal(result.user.displayName, 'Bob Admin');
    assert.equal(result.deploymentType, 'server');
    assert.equal(result.serverInfo.version, '9.4.0');
    assert.equal(result.serverInfo.deploymentType, 'Data Center');
    assert.equal(requestedUrls[0], 'https://jira.corp.internal/jira/rest/api/2/myself');
    assert.equal(requestedUrls[1], 'https://jira.corp.internal/jira/rest/api/2/serverInfo');
  });

  it('handles 401 Unauthorized with meaningful error', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Unauthorized' })
    });

    const provider = new JiraCloudTokenProvider('jane@example.com', 'bad-token');
    const client = new JiraClient('https://company.atlassian.net', provider, { fetchFn: mockFetch });

    const result = await client.testConnection();
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 401);
    assert.equal(result.errorType, 'AUTH_INVALID');
    assert.match(result.error, /401 Unauthorized/);
  });

  it('handles 403 Forbidden with meaningful error', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: 'Forbidden' })
    });

    const provider = new JiraPatProvider('expired-pat');
    const client = new JiraClient('https://jira.corp.internal', provider, { fetchFn: mockFetch });

    const result = await client.testConnection();
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 403);
    assert.equal(result.errorType, 'FORBIDDEN');
    assert.match(result.error, /403 Forbidden/);
  });

  it('handles 404 Not Found with meaningful error', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({ errorMessages: ['Not found'] })
    });

    const provider = new JiraPatProvider('valid-pat');
    const client = new JiraClient('https://jira.corp.internal', provider, { fetchFn: mockFetch });

    const result = await client.testConnection();
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 404);
    assert.equal(result.errorType, 'NOT_FOUND');
    assert.match(result.error, /404 Not Found/);
  });

  it('handles 500 Server Error', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({ message: 'Service Unavailable' })
    });

    const provider = new JiraPatProvider('valid-pat');
    const client = new JiraClient('https://jira.corp.internal', provider, { fetchFn: mockFetch });

    const result = await client.testConnection();
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 503);
    assert.equal(result.errorType, 'SERVER_ERROR');
    assert.match(result.error, /internal error/);
  });

  it('handles network failure (TypeError Failed to fetch)', async () => {
    const mockFetch = async () => {
      throw new TypeError('Failed to fetch');
    };

    const provider = new JiraPatProvider('valid-pat');
    const client = new JiraClient('https://jira.corp.internal', provider, { fetchFn: mockFetch });

    const result = await client.testConnection();
    assert.equal(result.success, false);
    assert.equal(result.errorType, 'NETWORK_ERROR');
    assert.match(result.error, /Unable to reach/);
  });

  it('handles request timeout', async () => {
    const mockFetch = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    const provider = new JiraPatProvider('valid-pat');
    const client = new JiraClient('https://jira.corp.internal', provider, {
      fetchFn: mockFetch,
      timeoutMs: 1000
    });

    const result = await client.testConnection();
    assert.equal(result.success, false);
    assert.equal(result.errorType, 'TIMEOUT');
    assert.match(result.error, /timed out/);
  });

  it('handles invalid non-JSON response', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token < in JSON at position 0');
      }
    });

    const provider = new JiraPatProvider('valid-pat');
    const client = new JiraClient('https://jira.corp.internal', provider, { fetchFn: mockFetch });

    const result = await client.testConnection();
    assert.equal(result.success, false);
    assert.equal(result.errorType, 'INVALID_RESPONSE');
    assert.match(result.error, /not valid JSON/);
  });

  it('validates URL before network call', async () => {
    const provider = new JiraPatProvider('valid-pat');
    const client = new JiraClient('http://insecure-jira.com', provider);

    const result = await client.testConnection();
    assert.equal(result.success, false);
    assert.equal(result.errorType, 'CONFIG_ERROR');
    assert.match(result.error, /HTTPS/);
  });

  it('never leaks secret token in results or error outputs', async () => {
    const secret = 'SUPER_SECRET_PAT_987654321';
    const mockFetch = async () => {
      throw new TypeError('Failed to fetch to https://jira.corp.internal');
    };

    const provider = new JiraPatProvider(secret);
    const client = new JiraClient('https://jira.corp.internal', provider, { fetchFn: mockFetch });

    const result = await client.testConnection();
    const resultString = JSON.stringify(result);
    assert.equal(resultString.includes(secret), false);
  });
});

