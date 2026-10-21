import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJiraClient } from '../src/jira/createJiraClient.js';
import { isWorklogByUser } from '../src/jira/JiraClient.js';
import { createPlatform } from '../src/compat/browser-api.js';
import { handleFetchWorklogs } from '../background.js';

describe('createJiraClient', () => {
  it('builds a Cloud client with a sanitized base URL', () => {
    const { client, error } = createJiraClient({
      baseUrl: 'https://acme.atlassian.net/rest/api/3', deploymentType: 'cloud', email: 'a@b.co', token: 't'
    });
    assert.equal(error, null);
    assert.equal(client.deploymentType, 'cloud');
    assert.equal(client.baseUrl, 'https://acme.atlassian.net');
  });

  it('builds a Data Center / Server client', () => {
    const { client } = createJiraClient({ baseUrl: 'https://jira.example.com/jira', deploymentType: 'server', token: 'pat' });
    assert.equal(client.deploymentType, 'server');
    assert.equal(client.baseUrl, 'https://jira.example.com/jira');
  });

  it('rejects an insecure URL and an unknown edition', () => {
    assert.match(createJiraClient({ baseUrl: 'http://jira.example.com', deploymentType: 'server', token: 't' }).error, /HTTPS/);
    assert.match(createJiraClient({ baseUrl: 'https://jira.example.com', deploymentType: 'other', token: 't' }).error, /Invalid Jira edition/);
  });

  it('reports configuration errors from the background worklog handler', async () => {
    const result = await handleFetchWorklogs({ baseUrl: 'https://jira.example.com', deploymentType: 'other', token: 't' });
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid Jira edition/);
  });
});

describe('isWorklogByUser', () => {
  it('matches by accountId when both sides have one', () => {
    assert.equal(isWorklogByUser({ author: { accountId: 'a1' } }, { accountId: 'a1' }), true);
    assert.equal(isWorklogByUser({ author: { accountId: 'a2', displayName: 'Dev' } }, { accountId: 'a1', displayName: 'Dev' }), false);
  });

  it('matches Data Center usernames case-insensitively', () => {
    assert.equal(isWorklogByUser({ author: { name: 'JDoe' } }, { name: 'jdoe' }), true);
  });

  it('trusts the JQL filter when the author is missing, and rejects a missing worklog', () => {
    assert.equal(isWorklogByUser({}, { accountId: 'a1' }), true);
    assert.equal(isWorklogByUser(null, { accountId: 'a1' }), false);
  });

  it('falls back to display name, then reports no match without identifiers', () => {
    assert.equal(isWorklogByUser({ author: { displayName: ' Dev User ' } }, { displayName: 'dev user' }), true);
    assert.equal(isWorklogByUser({ author: { foo: 1 } }, { displayName: 'Dev' }), false);
  });
});

describe('createPlatform', () => {
  it('uses the extension tabs API when available', () => {
    const opened = [];
    const platform = createPlatform({ storage: { local: 'ext-storage' }, tabs: { create: (o) => opened.push(o.url) } });
    platform.openTab('https://jira.example.com');
    assert.deepEqual(opened, ['https://jira.example.com']);
    assert.equal(platform.storage, 'ext-storage');
  });

  it('falls back to window.open and in-memory storage outside an extension', async () => {
    const opened = [];
    const platform = createPlatform(null, { open: (...args) => opened.push(args) });
    platform.openTab('https://jira.example.com');
    assert.deepEqual(opened, [['https://jira.example.com', '_blank', 'noopener,noreferrer']]);

    await platform.storage.set({ a: 1 });
    assert.deepEqual(await platform.storage.get(['a', 'b']), { a: 1 });
  });
});
