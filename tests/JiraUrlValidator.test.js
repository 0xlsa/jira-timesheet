import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JiraUrlValidator } from '../src/validation/JiraUrlValidator.js';

describe('JiraUrlValidator', () => {
  it('validates a standard Jira Cloud URL', () => {
    const result = JiraUrlValidator.validate('https://company.atlassian.net');
    assert.equal(result.isValid, true);
    assert.equal(result.sanitizedUrl, 'https://company.atlassian.net');
    assert.equal(result.originPattern, 'https://company.atlassian.net/*');
    assert.equal(result.error, null);
  });

  it('normalizes trailing slashes on root URLs', () => {
    const result = JiraUrlValidator.validate('https://company.atlassian.net///');
    assert.equal(result.isValid, true);
    assert.equal(result.sanitizedUrl, 'https://company.atlassian.net');
    assert.equal(result.originPattern, 'https://company.atlassian.net/*');
  });

  it('preserves context paths and normalizes trailing slashes', () => {
    const result = JiraUrlValidator.validate('https://jira.example.com/jira/');
    assert.equal(result.isValid, true);
    assert.equal(result.sanitizedUrl, 'https://jira.example.com/jira');
    assert.equal(result.originPattern, 'https://jira.example.com/*');
  });

  it('preserves nested context paths', () => {
    const result = JiraUrlValidator.validate('https://jira.example.com/apps/jira');
    assert.equal(result.isValid, true);
    assert.equal(result.sanitizedUrl, 'https://jira.example.com/apps/jira');
    assert.equal(result.originPattern, 'https://jira.example.com/*');
  });

  it('supports custom ports with context paths', () => {
    const result = JiraUrlValidator.validate('https://jira.internal:8443/jira/');
    assert.equal(result.isValid, true);
    assert.equal(result.sanitizedUrl, 'https://jira.internal:8443/jira');
    assert.equal(result.originPattern, 'https://jira.internal:8443/*');
  });

  it('strips accidental REST API suffixes', () => {
    const res1 = JiraUrlValidator.validate('https://jira.example.com/jira/rest/api/2/myself');
    assert.equal(res1.isValid, true);
    assert.equal(res1.sanitizedUrl, 'https://jira.example.com/jira');

    const res2 = JiraUrlValidator.validate('https://company.atlassian.net/rest/api/3');
    assert.equal(res2.isValid, true);
    assert.equal(res2.sanitizedUrl, 'https://company.atlassian.net');
  });

  it('rejects HTTP (non-HTTPS)', () => {
    const result = JiraUrlValidator.validate('http://jira.example.com/jira');
    assert.equal(result.isValid, false);
    assert.match(result.error, /HTTPS/);
  });

  it('rejects embedded credentials', () => {
    const result = JiraUrlValidator.validate('https://user:password@jira.example.com');
    assert.equal(result.isValid, false);
    assert.match(result.error, /credentials/i);
  });

  it('rejects query strings', () => {
    const result = JiraUrlValidator.validate('https://jira.example.com?test=1');
    assert.equal(result.isValid, false);
    assert.match(result.error, /Query strings/i);
  });

  it('rejects hash fragments', () => {
    const result = JiraUrlValidator.validate('https://jira.example.com#section');
    assert.equal(result.isValid, false);
    assert.match(result.error, /hash fragments/i);
  });

  it('rejects empty or whitespace input', () => {
    assert.equal(JiraUrlValidator.validate('').isValid, false);
    assert.equal(JiraUrlValidator.validate('   ').isValid, false);
    assert.equal(JiraUrlValidator.validate(null).isValid, false);
  });

  it('rejects malformed URLs', () => {
    const result = JiraUrlValidator.validate('not a valid url');
    assert.equal(result.isValid, false);
  });

  it('correctly checks isSameOrigin', () => {
    assert.equal(
      JiraUrlValidator.isSameOrigin('https://jira.example.com/jira/rest/api/2/myself', 'https://jira.example.com/jira'),
      true
    );
    assert.equal(
      JiraUrlValidator.isSameOrigin('https://evil.com/jira/rest/api/2/myself', 'https://jira.example.com/jira'),
      false
    );
    assert.equal(
      JiraUrlValidator.isSameOrigin('https://jira.example.com:8443/rest/api/2/myself', 'https://jira.example.com/jira'),
      false
    );
  });

  it('uses the example URL for the selected Jira edition in format errors', () => {
    assert.match(JiraUrlValidator.validate('not a url').error, /your-domain\.atlassian\.net/);
    assert.match(JiraUrlValidator.validate('not a url', { deploymentType: 'cloud' }).error, /your-domain\.atlassian\.net/);

    const serverError = JiraUrlValidator.validate('not a url', { deploymentType: 'server' }).error;
    assert.match(serverError, /jira\.your-company\.com/);
    assert.doesNotMatch(serverError, /atlassian/);
  });
});
