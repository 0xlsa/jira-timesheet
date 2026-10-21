import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JiraCloudTokenProvider } from '../src/auth/JiraCloudTokenProvider.js';
import { JiraPatProvider } from '../src/auth/JiraPatProvider.js';

describe('JiraCloudTokenProvider', () => {
  it('constructs correct HTTP Basic Authorization header', () => {
    const provider = new JiraCloudTokenProvider('user@example.com', 'dummy-token-12345');
    const headers = provider.getAuthHeaders();

    assert.ok(headers['Authorization']);
    assert.ok(headers['Authorization'].startsWith('Basic '));

    const base64Part = headers['Authorization'].replace('Basic ', '');
    const decoded = Buffer.from(base64Part, 'base64').toString('utf-8');
    assert.equal(decoded, 'user@example.com:dummy-token-12345');
  });

  it('correctly targets Cloud v3 identity endpoint', () => {
    const provider = new JiraCloudTokenProvider('user@example.com', 'dummy-token');
    assert.equal(provider.getIdentityEndpoint(), '/rest/api/3/myself');
    assert.equal(provider.getDeploymentType(), 'cloud');
  });

  it('validates required email and token', () => {
    const valid = new JiraCloudTokenProvider('user@example.com', 'token');
    assert.equal(valid.validate().isValid, true);

    const noEmail = new JiraCloudTokenProvider('', 'token');
    assert.equal(noEmail.validate().isValid, false);
    assert.match(noEmail.validate().error, /email/i);

    const invalidEmail = new JiraCloudTokenProvider('notanemail', 'token');
    assert.equal(invalidEmail.validate().isValid, false);
    assert.match(invalidEmail.validate().error, /format/i);

    const noToken = new JiraCloudTokenProvider('user@example.com', '');
    assert.equal(noToken.validate().isValid, false);
    assert.match(noToken.validate().error, /token/i);
  });

  it('throws when getting headers with invalid configuration', () => {
    const invalid = new JiraCloudTokenProvider('', '');
    assert.throws(() => invalid.getAuthHeaders(), /require/i);
  });

  it('redacts sensitive data in toJSON and toString', () => {
    const provider = new JiraCloudTokenProvider('secret-user@example.com', 'secret-token-xyz');
    const serialized = JSON.stringify(provider);
    assert.equal(serialized.includes('secret-token-xyz'), false);
    assert.equal(provider.toString().includes('secret-token-xyz'), false);
  });
});

describe('JiraPatProvider', () => {
  it('constructs correct Bearer Authorization header', () => {
    const provider = new JiraPatProvider('dummy-pat-value-67890');
    const headers = provider.getAuthHeaders();

    assert.equal(headers['Authorization'], 'Bearer dummy-pat-value-67890');
  });

  it('correctly targets Server/Data Center v2 identity endpoint', () => {
    const provider = new JiraPatProvider('dummy-pat');
    assert.equal(provider.getIdentityEndpoint(), '/rest/api/2/myself');
    assert.equal(provider.getDeploymentType(), 'server');
  });

  it('validates required PAT', () => {
    const valid = new JiraPatProvider('pat-123');
    assert.equal(valid.validate().isValid, true);

    const empty = new JiraPatProvider('');
    assert.equal(empty.validate().isValid, false);
    assert.match(empty.validate().error, /PAT/i);
  });

  it('throws when getting headers with empty PAT', () => {
    const empty = new JiraPatProvider('');
    assert.throws(() => empty.getAuthHeaders(), /required/i);
  });

  it('redacts sensitive data in toJSON and toString', () => {
    const provider = new JiraPatProvider('my-super-secret-pat');
    const serialized = JSON.stringify(provider);
    assert.equal(serialized.includes('my-super-secret-pat'), false);
    assert.equal(provider.toString().includes('my-super-secret-pat'), false);
  });
});
