import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsStore, normalizeSettings, isConfigured } from '../src/settings/settingsStore.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';

describe('settingsStore', () => {
  it('assigns a legacy single URL and token to the saved edition only', () => {
    const settings = normalizeSettings({ deploymentType: 'server', jiraBaseUrl: 'https://jira.example.com', token: 'pat-123' });
    assert.deepEqual(settings.baseUrlsByType, { cloud: '', server: 'https://jira.example.com' });
    assert.deepEqual(settings.tokensByType, { cloud: '', server: 'pat-123' });
  });

  it('prefers per-edition URLs and tokens over the legacy values', () => {
    const settings = normalizeSettings({
      deploymentType: 'cloud',
      jiraBaseUrl: 'https://old.example.com',
      token: 'old',
      cloudBaseUrl: 'https://acme.atlassian.net',
      serverBaseUrl: 'https://jira.example.com',
      cloudToken: 'api-token',
      serverToken: 'pat'
    });
    assert.deepEqual(settings.baseUrlsByType, { cloud: 'https://acme.atlassian.net', server: 'https://jira.example.com' });
    assert.deepEqual(settings.tokensByType, { cloud: 'api-token', server: 'pat' });
  });

  it('defaults to Jira Cloud with empty values', () => {
    const settings = normalizeSettings({});
    assert.equal(settings.deploymentType, 'cloud');
    assert.equal(settings.jiraBaseUrl, '');
    assert.equal(settings.lastTestResult, null);
  });

  it('requires an email for Cloud but not for Data Center / Server', () => {
    const base = { jiraBaseUrl: 'https://jira.example.com', token: 't' };
    assert.equal(isConfigured({ ...base, deploymentType: 'cloud', email: '' }), false);
    assert.equal(isConfigured({ ...base, deploymentType: 'cloud', email: 'a@b.co' }), true);
    assert.equal(isConfigured({ ...base, deploymentType: 'server', email: '' }), true);
    assert.equal(isConfigured({ ...base, token: '', deploymentType: 'server', email: '' }), false);
  });

  it('saves the active edition URL and token alongside both per-edition values', async () => {
    const storage = createMemoryStorageArea();
    const store = createSettingsStore(storage);

    await store.save({
      deploymentType: 'server',
      email: '',
      baseUrlsByType: { cloud: 'https://acme.atlassian.net', server: 'https://jira.example.com' },
      tokensByType: { cloud: 'api', server: 'pat' }
    });

    const raw = await storage.get([
      'jiraBaseUrl', 'token', 'cloudBaseUrl', 'serverBaseUrl', 'cloudToken', 'serverToken', 'deploymentType'
    ]);
    assert.deepEqual(raw, {
      jiraBaseUrl: 'https://jira.example.com',
      token: 'pat',
      cloudBaseUrl: 'https://acme.atlassian.net',
      serverBaseUrl: 'https://jira.example.com',
      cloudToken: 'api',
      serverToken: 'pat',
      deploymentType: 'server'
    });

    const loaded = await store.load();
    assert.equal(loaded.jiraBaseUrl, 'https://jira.example.com');
    assert.equal(loaded.token, 'pat');
    assert.deepEqual(loaded.baseUrlsByType, { cloud: 'https://acme.atlassian.net', server: 'https://jira.example.com' });
    assert.deepEqual(loaded.tokensByType, { cloud: 'api', server: 'pat' });
  });

  it('keeps the Cloud account email when Data Center / Server is saved', async () => {
    const store = createSettingsStore(createMemoryStorageArea());

    await store.save({
      deploymentType: 'server',
      email: 'dev@example.com',
      baseUrlsByType: { cloud: 'https://acme.atlassian.net', server: 'https://jira.example.com' },
      tokensByType: { cloud: 'api', server: 'pat' }
    });

    const loaded = await store.load();
    assert.equal(loaded.deploymentType, 'server');
    assert.equal(loaded.email, 'dev@example.com');
  });

  it('stores and clears the last successful test result', async () => {
    const store = createSettingsStore(createMemoryStorageArea());

    await store.saveTestResult({ user: { displayName: 'Dev' }, testedAt: '2026-10-21T10:00:00.000Z', extra: 'ignored' });
    assert.deepEqual((await store.load()).lastTestResult, {
      success: true, user: { displayName: 'Dev' }, serverInfo: undefined, testedAt: '2026-10-21T10:00:00.000Z'
    });

    await store.clearTestResult();
    assert.equal((await store.load()).lastTestResult, null);
  });
});
