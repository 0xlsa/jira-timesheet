import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIssueKeyQuery,
  buildIssueKeySuggestionJql,
  issueKeyMatchesQuery,
  rankIssueKeyMatches,
  ISSUE_SUGGESTION_LIMIT
} from '../src/jira/issueKeySearch.js';
import { JiraClient } from '../src/jira/JiraClient.js';
import { JiraCloudTokenProvider } from '../src/auth/JiraCloudTokenProvider.js';
import { JiraPatProvider } from '../src/auth/JiraPatProvider.js';

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Issues whose keys are prefixes of one another: EKB-308 ⊂ EKB-3086 ⊂ EKB-30860 / EKB-30864, KAN-1 ⊂ KAN-10.
const SUMMARIES = {
  'EKB-308': 'Release checklist',
  'EKB-3086': 'Create Patch for 19.1.2',
  'EKB-30860': 'Unrelated work item',
  'EKB-30864': 'The issue being looked for',
  'KAN-1': 'Creating Jira Extension',
  'KAN-10': 'Align worklog card actions with the duration badge',
  'KAN-11': 'Implement Log work from worklog cards'
};

const toIssue = (key) => ({
  id: String(10000 + Object.keys(SUMMARIES).indexOf(key)),
  key,
  fields: { summary: SUMMARIES[key], status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } }
});

/**
 * A fake Jira that evaluates the suggestion JQL (`key in (...) ORDER BY key ASC`) against SUMMARIES.
 * Cloud skips missing keys and answers 400 only when none exist (checked against a live Jira Cloud
 * site). Data Center answers 400 for any missing key unless the search has `validateQuery=warn`.
 */
function fakeJira(edition, { issues = SUMMARIES, searchOverride } = {}) {
  const requests = [];
  const fetchFn = async (rawUrl, options) => {
    const url = new URL(rawUrl);
    requests.push({ url, options });

    if (/\/search(\/jql)?$/.test(url.pathname)) {
      if (searchOverride) return searchOverride(url);
      const keys = [...url.searchParams.get('jql').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      const existing = keys.filter((k) => k in issues);
      const strict = edition === 'server' && url.searchParams.get('validateQuery') !== 'warn';
      if (existing.length === 0 || (strict && existing.length < keys.length)) {
        return jsonResponse(400, { errorMessages: ['Issue does not exist or you do not have permission to see it.'] });
      }
      const byNumber = (k) => Number(k.split('-')[1]);
      existing.sort((a, b) => byNumber(a) - byNumber(b));
      return jsonResponse(200, { issues: existing.slice(0, Number(url.searchParams.get('maxResults'))).map(toIssue) });
    }

    const key = decodeURIComponent(url.pathname.split('/issue/')[1] ?? '');
    return key in issues ? jsonResponse(200, toIssue(key)) : jsonResponse(404, { errorMessages: ['Issue does not exist'] });
  };

  const provider = edition === 'cloud'
    ? new JiraCloudTokenProvider('dev@example.com', 'cloud-token')
    : new JiraPatProvider('server-pat');
  const baseUrl = edition === 'cloud' ? 'https://acme.atlassian.net' : 'https://jira.example.com/jira';
  return { client: new JiraClient(baseUrl, provider, { fetchFn }), requests };
}

const keysOf = (issues) => issues.map((issue) => issue.issueKey);

describe('Issue key autocomplete - query parsing', () => {
  it('needs the project key, the hyphen, and at least one digit', () => {
    for (const text of ['', ' ', 'E', 'EKB', 'EKB-', 'ekb-', '-3', '3', '303']) {
      assert.equal(parseIssueKeyQuery(text), null, `"${text}" should not be searched yet`);
    }
  });

  it('accepts any project prefix, ignoring case and surrounding spaces', () => {
    assert.deepEqual(parseIssueKeyQuery('EKB-3'), { key: 'EKB-3', projectKey: 'EKB', number: '3' });
    assert.deepEqual(parseIssueKeyQuery('EKB-30864'), { key: 'EKB-30864', projectKey: 'EKB', number: '30864' });
    assert.deepEqual(parseIssueKeyQuery(' kan-3 '), { key: 'KAN-3', projectKey: 'KAN', number: '3' });
    assert.deepEqual(parseIssueKeyQuery('VOSS-3'), { key: 'VOSS-3', projectKey: 'VOSS', number: '3' });
    assert.deepEqual(parseIssueKeyQuery('A1_B2-12'), { key: 'A1_B2-12', projectKey: 'A1_B2', number: '12' });
  });

  it('rejects text that cannot be part of an issue key', () => {
    for (const text of ['EKB-0', 'EKB-03', 'EKB-3a', '1EKB-3', 'EK B-3', 'EKB--3', 'EKB-3-4', 'EKB-1234567890123']) {
      assert.equal(parseIssueKeyQuery(text), null, `"${text}" is not a partial issue key`);
    }
  });
});

describe('Issue key autocomplete - JQL and matching', () => {
  it('lists the typed key and the ten keys one digit longer, in key order', () => {
    assert.equal(buildIssueKeySuggestionJql(parseIssueKeyQuery('EKB-3086')),
      'key in ("EKB-3086", "EKB-30860", "EKB-30861", "EKB-30862", "EKB-30863", "EKB-30864", ' +
      '"EKB-30865", "EKB-30866", "EKB-30867", "EKB-30868", "EKB-30869") ORDER BY key ASC');
  });

  it('builds the same query shape for any project prefix', () => {
    const shape = (text) => buildIssueKeySuggestionJql(parseIssueKeyQuery(text)).replace(/"[A-Z0-9_]+-/g, '"P-');
    assert.equal(shape('KAN-3'), shape('EKB-3'));
    assert.equal(shape('VOSS-3'), shape('EKB-3'));
    assert.doesNotMatch(buildIssueKeySuggestionJql(parseIssueKeyQuery('KAN-3')), /EKB/);
  });

  it('uses no key ranges, which Jira Cloud rejects when a bound does not exist', () => {
    assert.doesNotMatch(buildIssueKeySuggestionJql(parseIssueKeyQuery('EKB-30864')), /[<>]=?/);
  });

  it('never treats a shorter key as a match for a longer one', () => {
    const query = parseIssueKeyQuery('EKB-30864');
    assert.equal(issueKeyMatchesQuery('EKB-30864', query), true);
    assert.equal(issueKeyMatchesQuery('EKB-308641', query), true);
    for (const key of ['EKB-3086', 'EKB-308', 'EKB-30865', 'EKB-130864', 'XEKB-30864', 'EKB-30864X', 'KAN-30864']) {
      assert.equal(issueKeyMatchesQuery(key, query), false, `${key} must not match EKB-30864`);
    }
  });

  it('puts the exact key first, then shorter numbers, and drops non-matches', () => {
    const issues = ['EKB-30861', 'EKB-3086', 'EKB-308', 'EKB-30860', 'KAN-3086'].map((issueKey) => ({ issueKey }));
    assert.deepEqual(keysOf(rankIssueKeyMatches(issues, parseIssueKeyQuery('EKB-3086'))), ['EKB-3086', 'EKB-30860', 'EKB-30861']);
  });
});

for (const edition of ['cloud', 'server']) {
  const label = edition === 'cloud' ? 'Jira Cloud' : 'Jira Data Center / Server';

  describe(`Issue key autocomplete - prefix keys on ${label}`, () => {
    it('EKB-30864 finds EKB-30864 only, never EKB-3086', async () => {
      const { client } = fakeJira(edition);
      assert.deepEqual(keysOf(await client.suggestIssuesByKey('EKB-30864')), ['EKB-30864']);
    });

    it('EKB-3086 lists the exact key first, then the longer keys that start with it', async () => {
      const { client } = fakeJira(edition);
      const issues = await client.suggestIssuesByKey('ekb-3086');
      assert.deepEqual(keysOf(issues), ['EKB-3086', 'EKB-30860', 'EKB-30864']);
      assert.equal(issues[0].issueSummary, 'Create Patch for 19.1.2');
    });

    it('EKB-308 lists EKB-308 first, then EKB-3086', async () => {
      const { client } = fakeJira(edition);
      assert.deepEqual(keysOf(await client.suggestIssuesByKey('EKB-308')), ['EKB-308', 'EKB-3086']);
    });

    it('a key that does not exist suggests nothing, even when a shorter key does (EKB-30865, KAN-15)', async () => {
      const { client } = fakeJira(edition);
      assert.deepEqual(await client.suggestIssuesByKey('EKB-30865'), []);
      assert.deepEqual(await client.suggestIssuesByKey('KAN-15'), []);
    });

    it('KAN-1 lists KAN-1 first, then KAN-10 and KAN-11', async () => {
      const { client } = fakeJira(edition);
      assert.deepEqual(keysOf(await client.suggestIssuesByKey('KAN-1')), ['KAN-1', 'KAN-10', 'KAN-11']);
    });

    it('drops shorter keys and other projects even if Jira returns them, and looks up the exact key', async () => {
      const { client, requests } = fakeJira(edition, {
        searchOverride: () => jsonResponse(200, { issues: [toIssue('EKB-3086'), toIssue('EKB-308'), toIssue('KAN-10')] })
      });

      assert.deepEqual(keysOf(await client.suggestIssuesByKey('EKB-30864')), ['EKB-30864']);
      assert.match(requests.at(-1).url.pathname, /\/rest\/api\/[23]\/issue\/EKB-30864$/);
    });
  });
}

describe('Issue key autocomplete - Jira Cloud requests', () => {
  it('runs one bounded search on /rest/api/3/search/jql for the summary and status only', async () => {
    const { client, requests } = fakeJira('cloud');

    await client.suggestIssuesByKey('EKB-3086');

    assert.equal(requests.length, 1, 'no lookup needed when the exact key is in the results');
    const { url, options } = requests[0];
    assert.equal(url.origin + url.pathname, 'https://acme.atlassian.net/rest/api/3/search/jql');
    assert.equal(options.method ?? 'GET', 'GET');
    assert.equal(url.searchParams.get('jql'), buildIssueKeySuggestionJql(parseIssueKeyQuery('EKB-3086')));
    assert.equal(url.searchParams.get('maxResults'), String(ISSUE_SUGGESTION_LIMIT));
    assert.equal(url.searchParams.get('fields'), 'summary,status');
    assert.equal(url.searchParams.has('startAt'), false);
    assert.equal(url.searchParams.has('validateQuery'), false, '/search/jql has no validateQuery parameter');
    assert.match(options.headers.Authorization, /^Basic /);
  });

  it('never asks for or returns more than 10 issues', async () => {
    const many = Object.fromEntries(['EKB-3', ...Array.from({ length: 10 }, (_, i) => `EKB-3${i}`)].map((k) => [k, k]));
    const { client, requests } = fakeJira('cloud', { issues: many });

    const issues = await client.suggestIssuesByKey('EKB-3', { maxResults: 50 });

    assert.equal(requests[0].url.searchParams.get('maxResults'), '10');
    assert.equal(issues.length, 10);
    assert.equal(issues[0].issueKey, 'EKB-3');
  });

  it('does not contact Jira until the input has a digit after the hyphen', async () => {
    const { client, requests } = fakeJira('cloud');
    for (const text of ['E', 'EKB', 'EKB-']) {
      assert.deepEqual(await client.suggestIssuesByKey(text), []);
    }
    assert.equal(requests.length, 0);
  });

  it('suggests the issue a moved key now belongs to, which Jira returns for the old key', async () => {
    const provider = new JiraCloudTokenProvider('dev@example.com', 'cloud-token');
    const client = new JiraClient('https://acme.atlassian.net', provider, {
      fetchFn: async (url) => (new URL(url).pathname.endsWith('/search/jql')
        ? jsonResponse(400, {})
        : jsonResponse(200, toIssue('KAN-10')))
    });

    assert.deepEqual(keysOf(await client.suggestIssuesByKey('OLD-7')), ['KAN-10']);
  });

  it('reports missing permission with its HTTP status and does not retry', async () => {
    const { client, requests } = fakeJira('cloud', { searchOverride: () => jsonResponse(403, {}) });

    await assert.rejects(client.suggestIssuesByKey('EKB-3'), (err) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /403 Forbidden/);
      return true;
    });
    assert.equal(requests.length, 1);
  });

  it('turns network failures into a user-facing message', async () => {
    const provider = new JiraCloudTokenProvider('dev@example.com', 'cloud-token');
    const client = new JiraClient('https://acme.atlassian.net', provider, {
      fetchFn: async () => { throw new TypeError('Failed to fetch'); }
    });

    await assert.rejects(client.suggestIssuesByKey('EKB-3'), /Unable to reach the Jira server/);
  });

  it('can be cancelled by the caller, rejecting with an AbortError rather than a timeout', async () => {
    const provider = new JiraCloudTokenProvider('dev@example.com', 'cloud-token');
    const client = new JiraClient('https://acme.atlassian.net', provider, {
      // Like fetch: rejects at once for an aborted signal, or as soon as it's aborted.
      fetchFn: (url, { signal }) => new Promise((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        if (signal.aborted) abort();
        signal.addEventListener('abort', abort);
      })
    });
    const controller = new AbortController();

    const pending = client.suggestIssuesByKey('EKB-3', { signal: controller.signal });
    controller.abort();

    await assert.rejects(pending, (err) => err.name === 'AbortError' && err.code !== 'TIMEOUT');
  });
});

describe('Issue key autocomplete - Jira Data Center / Server requests', () => {
  it('runs one bounded search on /rest/api/2/search with validateQuery=warn and Bearer authentication', async () => {
    const { client, requests } = fakeJira('server');

    const issues = await client.suggestIssuesByKey('kan-1');

    assert.equal(requests.length, 1);
    const { url, options } = requests[0];
    assert.equal(url.origin + url.pathname, 'https://jira.example.com/jira/rest/api/2/search');
    assert.equal(url.searchParams.get('jql'), buildIssueKeySuggestionJql(parseIssueKeyQuery('KAN-1')));
    assert.equal(url.searchParams.get('validateQuery'), 'warn');
    assert.equal(url.searchParams.get('startAt'), '0');
    assert.equal(url.searchParams.get('maxResults'), '10');
    assert.equal(url.searchParams.get('fields'), 'summary,status');
    assert.equal(options.headers.Authorization, 'Bearer server-pat');
    assert.deepEqual(keysOf(issues), ['KAN-1', 'KAN-10', 'KAN-11']);
  });

  it('looks up the exact key on the v2 issue endpoint when it is not among the results', async () => {
    const { client, requests } = fakeJira('server');

    assert.deepEqual(await client.suggestIssuesByKey('KAN-3'), []);
    assert.equal(requests[1].url.pathname, '/jira/rest/api/2/issue/KAN-3');
    assert.equal(requests[1].url.searchParams.get('fields'), 'summary,status');
  });

  it('reports an expired token with its HTTP status', async () => {
    const { client } = fakeJira('server', { searchOverride: () => jsonResponse(401, {}) });
    await assert.rejects(client.suggestIssuesByKey('KAN-3'), (err) => err.status === 401 && /Personal Access Token/.test(err.message));
  });
});
