import { JiraUrlValidator } from '../validation/JiraUrlValidator.js';
import { JiraAuthProvider } from '../auth/JiraAuthProvider.js';
import { getLocalDateKey } from '../worklog/worklogUtils.js';
import { formatJiraDateTime, plainTextToAdf } from '../worklog/worklogEdit.js';
import { ISSUE_SUGGESTION_LIMIT, parseIssueKeyQuery, buildIssueKeySuggestionJql, rankIssueKeyMatches } from './issueKeySearch.js';

/**
 * Checks whether a worklog was logged by the given user. Compares the strongest
 * identifier both sides have: accountId (Cloud), then username or user key
 * (Data Center / Server), then display name, then email.
 *
 * @param {object} worklog
 * @param {{ accountId?: string, name?: string, key?: string, displayName?: string, emailAddress?: string }} user
 * @returns {boolean}
 */
export function isWorklogByUser(worklog, user) {
  if (!worklog) return false;
  if (!worklog.author) {
    // If Jira omitted the author object, we trust the JQL search which filtered worklogAuthor = currentUser()
    return true;
  }

  const author = worklog.author;

  // Cloud: Match by accountId
  if (user.accountId && author.accountId) {
    return author.accountId === user.accountId;
  }

  // Server/DC: Match by username
  if (user.name && author.name) {
    return author.name.toLowerCase() === user.name.toLowerCase();
  }

  // Server/DC: Match by user key
  if (user.key && author.key) {
    return author.key === user.key;
  }

  // Display Name match fallback
  if (user.displayName && author.displayName) {
    return author.displayName.trim().toLowerCase() === user.displayName.trim().toLowerCase();
  }

  // Email match fallback
  if (user.emailAddress && author.emailAddress) {
    return author.emailAddress.trim().toLowerCase() === user.emailAddress.trim().toLowerCase();
  }

  return false;
}

/**
 * Reduces a Jira issue `status` field to the name and status category key shown in the UI.
 * Cloud and Data Center / Server both return `{ name, statusCategory: { key } }`, where the
 * category key is `new`, `indeterminate`, `done`, or (for unmapped statuses) `undefined`.
 *
 * @param {object} [status]
 * @returns {{ name: string, categoryKey: string } | null} Null when the status has no name
 */
export function toIssueStatus(status) {
  const name = typeof status?.name === 'string' ? status.name.trim() : '';
  if (!name) return null;

  const categoryKey = status.statusCategory?.key;
  return { name, categoryKey: typeof categoryKey === 'string' ? categoryKey : '' };
}

/**
 * JiraClient
 * Centralized Jira REST API client for connection verification and API operations.
 *
 * Security Guarantees:
 * - Credentials are only sent in standard HTTP Authorization headers, never in URLs.
 * - Outgoing URLs are strictly checked against the configured Jira base origin.
 * - Sensitive values (tokens, credentials, auth headers) are never logged or exposed in error messages.
 * - Request timeouts prevent hanging requests.
 */
export class JiraClient {
  #baseUrl;
  #authProvider;
  #fetchFn;
  #timeoutMs;
  #currentUser = null;

  /**
   * @param {string} baseUrl - Validated Jira base URL (e.g. https://company.atlassian.net)
   * @param {JiraAuthProvider} authProvider - Authentication provider
   * @param {object} [options]
   * @param {typeof fetch} [options.fetchFn] - Custom fetch function (useful for tests)
   * @param {number} [options.timeoutMs] - Request timeout in milliseconds (default: 15000)
   */
  constructor(baseUrl, authProvider, options = {}) {
    if (!authProvider || !(authProvider instanceof JiraAuthProvider)) {
      throw new Error('A valid JiraAuthProvider instance is required.');
    }

    this.#baseUrl = baseUrl;
    this.#authProvider = authProvider;
    this.#fetchFn = options.fetchFn || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    this.#timeoutMs = options.timeoutMs || 15000;
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  get deploymentType() {
    return this.#authProvider.getDeploymentType();
  }

  /**
   * Returns the REST API path for a resource: v3 on Jira Cloud, v2 on Data Center / Server.
   * @param {string} resource - e.g. `issue/ABC-1/worklog`
   * @returns {string}
   */
  #apiPath(resource) {
    return `/rest/api/${this.deploymentType === 'cloud' ? '3' : '2'}/${resource}`;
  }

  /**
   * Requests a path and, if a v3 path returns 404, retries the same resource on v2.
   *
   * @param {string} path
   * @param {object} [options]
   * @param {boolean} [options.keepOriginalUnlessOk=false] - Only use the v2 response if it succeeds
   * @param {AbortSignal} [options.signal] - Cancels the request
   * @returns {Promise<{ response: Response, path: string }>}
   */
  async #requestWithV2Fallback(path, { keepOriginalUnlessOk = false, signal } = {}) {
    const response = await this.#request(path, { signal });

    if (response.status === 404 && path.startsWith('/rest/api/3/')) {
      const fallbackPath = path.replace('/rest/api/3/', '/rest/api/2/');
      const fallbackResponse = await this.#request(fallbackPath, { signal });
      if (!keepOriginalUnlessOk || fallbackResponse.ok) {
        return { response: fallbackResponse, path: fallbackPath };
      }
    }

    return { response, path };
  }

  /**
   * Maps a Jira `/myself` response to the user profile shape used by the app.
   * @param {object} data
   */
  #toUser(data) {
    return {
      displayName: data.displayName || data.name || 'Jira User',
      emailAddress: data.emailAddress || (this.deploymentType === 'cloud' && 'email' in this.#authProvider ? this.#authProvider.email : ''),
      name: data.name || '',
      accountId: data.accountId || '',
      key: data.key || '',
      active: data.active !== undefined ? data.active : true
    };
  }

  /**
   * Builds an absolute URL for a given Jira REST API path, verifying origin integrity.
   *
   * @param {string} path - API endpoint path (e.g. /rest/api/3/myself)
   * @returns {string} Fully qualified URL
   */
  #resolveApiUrl(path) {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const targetUrl = `${this.#baseUrl}${cleanPath}`;

    // Security check: Target must stay on the exact same origin as the validated baseUrl
    if (!JiraUrlValidator.isSameOrigin(targetUrl, this.#baseUrl)) {
      throw new Error('Security violation: Target URL origin does not match configured Jira Base URL.');
    }

    return targetUrl;
  }

  /**
   * Executes an authenticated HTTP request to the Jira API.
   *
   * @param {string} path
   * @param {RequestInit} [options] - `signal` cancels the request; it then rejects with the
   *   AbortError rather than a timeout error
   * @returns {Promise<Response>}
   */
  async #request(path, options = {}) {
    if (!this.#fetchFn) {
      throw new Error('Fetch API is not available.');
    }

    const { signal: callerSignal, ...requestOptions } = options;
    const url = this.#resolveApiUrl(path);
    const authHeaders = await this.#authProvider.getAuthHeaders();

    const headers = {
      'Accept': 'application/json',
      // Standard Atlassian header to bypass CSRF/XSRF checks on REST endpoints
      'X-Atlassian-Token': 'no-check',
      ...authHeaders,
      ...(requestOptions.headers || {})
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.#timeoutMs);
    const abortFromCaller = () => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

    try {
      const response = await this.#fetchFn(url, {
        ...requestOptions,
        headers,
        // Authenticate with the token only. Browser session cookies for the Jira host
        // (sent by Firefox for extension requests) can override the token and make Jira
        // answer with an HTML login/error page instead of JSON.
        credentials: 'omit',
        signal: controller.signal
      });
      return response;
    } catch (err) {
      if (err.name === 'AbortError' && !callerSignal?.aborted) {
        const timeoutError = new Error(`Request timed out after ${this.#timeoutMs / 1000} seconds.`);
        timeoutError.code = 'TIMEOUT';
        throw timeoutError;
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  }

  /**
   * Tests the connection to the Jira instance using the configured provider.
   *
   * For Jira Cloud: tests /rest/api/3/myself (with fallback to /rest/api/2/myself).
   * For Jira Data Center / Server: tests /rest/api/2/myself and fetches serverInfo.
   *
   * @returns {Promise<{
   *   success: boolean,
   *   user?: {
   *     displayName: string,
   *     emailAddress?: string,
   *     name?: string,
   *     accountId?: string,
   *     active?: boolean
   *   },
   *   serverInfo?: {
   *     version?: string,
   *     deploymentType?: string,
   *     serverTitle?: string
   *   },
   *   error?: string,
   *   errorType?: string,
   *   statusCode?: number,
   *   testedAt: string
   * }>}
   */
  async testConnection() {
    const testedAt = new Date().toISOString();

    // 1. Validate Base URL
    const urlValidation = JiraUrlValidator.validate(this.#baseUrl);
    if (!urlValidation.isValid) {
      return {
        success: false,
        error: urlValidation.error || 'Invalid Base URL.',
        errorType: 'CONFIG_ERROR',
        testedAt
      };
    }

    // 2. Validate Credentials format
    const credValidation = this.#authProvider.validate();
    if (!credValidation.isValid) {
      return {
        success: false,
        error: credValidation.error || 'Invalid credentials.',
        errorType: 'CONFIG_ERROR',
        testedAt
      };
    }

    try {
      // Cloud fallback: if /rest/api/3/myself returns 404, use /rest/api/2/myself when it succeeds
      const { response } = await this.#requestWithV2Fallback(
        this.#authProvider.getIdentityEndpoint(),
        { keepOriginalUnlessOk: true }
      );

      // Check HTTP Status
      if (!response.ok) {
        return this.#handleHttpError(response, testedAt);
      }

      // Parse JSON
      let data;
      try {
        data = await response.json();
      } catch {
        return {
          success: false,
          error: 'Jira returned a response, but it was not valid JSON. Please verify your Jira Base URL.',
          errorType: 'INVALID_RESPONSE',
          statusCode: response.status,
          testedAt
        };
      }

      // Validate identity structure
      if (!data || typeof data !== 'object' || (!data.displayName && !data.name && !data.accountId)) {
        return {
          success: false,
          error: 'Connected, but the endpoint did not return a recognizable Jira user profile.',
          errorType: 'INVALID_RESPONSE',
          statusCode: response.status,
          testedAt
        };
      }

      const result = {
        success: true,
        deploymentType: this.deploymentType,
        user: this.#toUser(data),
        testedAt
      };

      this.#currentUser = result.user;

      // For Data Center / Server, attempt to fetch serverInfo for version details
      if (typeof this.#authProvider.getServerInfoEndpoint === 'function') {
        try {
          const serverInfoResponse = await this.#request(this.#authProvider.getServerInfoEndpoint());
          if (serverInfoResponse.ok) {
            const serverInfoData = await serverInfoResponse.json();
            result.serverInfo = {
              version: serverInfoData.version || '',
              deploymentType: serverInfoData.deploymentType || 'Server / Data Center',
              serverTitle: serverInfoData.serverTitle || ''
            };
          }
        } catch {
          // Failure to get serverInfo is non-fatal if myself endpoint succeeded
        }
      }

      return result;
    } catch (err) {
      return this.#handleException(err, testedAt);
    }
  }

  /**
   * Parses a Jira REST response body as JSON, failing with a clear message when the
   * server returns something else (e.g. an HTML login page served by SSO or a proxy).
   *
   * @param {Response} response
   * @param {string} path - Endpoint path, used in the error message
   * @returns {Promise<any>}
   */
  async #parseJson(response, path) {
    try {
      return await response.json();
    } catch {
      const endpoint = path.split('?')[0];
      throw new Error(
        `Jira returned a non-JSON response for ${endpoint} (HTTP ${response.status}). ` +
        'This usually means a login or SSO page was served instead of the REST API. ' +
        'Verify your token and Jira Base URL, or log out of Jira in this browser and retry.'
      );
    }
  }

  /**
   * Maps non-2xx HTTP responses to meaningful, user-friendly error messages.
   *
   * @param {Response} response
   * @param {string} testedAt
   */
  async #handleHttpError(response, testedAt) {
    const status = response.status;
    let serverMessage = '';

    try {
      const errJson = await response.json();
      if (errJson.errorMessages && Array.isArray(errJson.errorMessages) && errJson.errorMessages.length > 0) {
        serverMessage = errJson.errorMessages.join('. ');
      } else if (errJson.message) {
        serverMessage = errJson.message;
      }
    } catch {
      // Body is not JSON (e.g. HTML 404 page from a reverse proxy)
    }

    if (status === 401) {
      return {
        success: false,
        statusCode: 401,
        error: this.deploymentType === 'cloud'
          ? 'Authentication failed (401 Unauthorized). Verify your Jira Cloud account email and Atlassian API token.'
          : 'Authentication failed (401 Unauthorized). Verify that your Personal Access Token (PAT) is active and valid.',
        errorType: 'AUTH_INVALID',
        serverMessage,
        testedAt
      };
    }

    if (status === 403) {
      return {
        success: false,
        statusCode: 403,
        error: 'Access forbidden (403 Forbidden). Your account may lack API access permissions, be deactivated, or Atlassian CAPTCHA verification may be triggered.',
        errorType: 'FORBIDDEN',
        serverMessage,
        testedAt
      };
    }

    if (status === 404) {
      return {
        success: false,
        statusCode: 404,
        error: 'Endpoint not found (404 Not Found). Verify your Jira Base URL (including any context path such as /jira) and Jira edition.',
        errorType: 'NOT_FOUND',
        serverMessage,
        testedAt
      };
    }

    if (status >= 500) {
      return {
        success: false,
        statusCode: status,
        error: `Jira server returned an internal error (${status}). The Jira instance may be down or experiencing issues.`,
        errorType: 'SERVER_ERROR',
        serverMessage,
        testedAt
      };
    }

    return {
      success: false,
      statusCode: status,
      error: `Unexpected response from Jira (${status}${serverMessage ? ': ' + serverMessage : ''}).`,
      errorType: 'HTTP_ERROR',
      serverMessage,
      testedAt
    };
  }

  /**
   * Maps fetch exceptions (network errors, aborts, CORS) to clear user guidance.
   *
   * @param {Error} err
   * @param {string} testedAt
   */
  #handleException(err, testedAt) {
    if (err.code === 'TIMEOUT') {
      return {
        success: false,
        error: `Connection timed out after ${this.#timeoutMs / 1000} seconds. Please verify the Jira server URL and network accessibility.`,
        errorType: 'TIMEOUT',
        testedAt
      };
    }

    // Network / CORS / Security fetch error
    const message = err.message || '';

    // In Chrome Extensions, missing host permission or CORS throws TypeError: Failed to fetch
    if (err instanceof TypeError || message.includes('Failed to fetch') || message.includes('NetworkError')) {
      return {
        success: false,
        error: 'Unable to reach the Jira server. Please verify the Base URL, check your network connection, and ensure extension host permissions are granted.',
        errorType: 'NETWORK_ERROR',
        testedAt
      };
    }

    return {
      success: false,
      error: `Connection failed: ${message}`,
      errorType: 'UNKNOWN_ERROR',
      testedAt
    };
  }

  /**
   * Retrieves the authenticated user's profile details.
   * Caches the user profile in memory after the first successful lookup.
   *
   * @returns {Promise<{
   *   displayName: string,
   *   emailAddress?: string,
   *   name?: string,
   *   accountId?: string,
   *   key?: string,
   *   active?: boolean
   * }>}
   */
  async getCurrentUser() {
    if (this.#currentUser) {
      return this.#currentUser;
    }

    const { response, path } = await this.#requestWithV2Fallback(this.#authProvider.getIdentityEndpoint());

    if (!response.ok) {
      const err = await this.#handleHttpError(response, new Date().toISOString());
      throw new Error(err.error || 'Failed to retrieve authenticated Jira user profile.');
    }

    this.#currentUser = this.#toUser(await this.#parseJson(response, path));
    return this.#currentUser;
  }

  /**
   * Executes a JQL search query against the Jira REST API.
   *
   * Jira Cloud uses `/rest/api/3/search/jql`, which pages with `nextPageToken`
   * (the old `/rest/api/3/search` returns 410 Gone; see Atlassian CHANGE-2046).
   * Jira Data Center / Server uses `/rest/api/2/search`, which pages with `startAt`.
   *
   * @param {string} jql - JQL query string
   * @param {object} [options]
   * @param {number} [options.startAt=0] - Data Center / Server pagination offset
   * @param {string} [options.nextPageToken] - Jira Cloud pagination token
   * @param {number} [options.maxResults=50]
   * @param {string[]} [options.fields=['summary', 'worklog']]
   * @param {AbortSignal} [options.signal] - Cancels the request
   * @param {'strict' | 'warn'} [options.validateQuery] - Data Center / Server only: `warn` reports
   *   unknown values (such as issue keys that don't exist) as warnings instead of failing the search
   * @returns {Promise<{
   *   issues: Array<object>,
   *   startAt?: number,
   *   maxResults?: number,
   *   total?: number,
   *   nextPageToken?: string,
   *   isLast?: boolean
   * }>}
   */
  async searchIssues(jql, options = {}) {
    const isCloud = this.deploymentType === 'cloud';
    const startAt = Math.max(0, Number(options.startAt) || 0);
    const maxResults = Math.min(100, Math.max(1, Number(options.maxResults) || 50));
    const fields = Array.isArray(options.fields) && options.fields.length > 0
      ? options.fields
      : ['summary', 'worklog'];

    // Use GET rather than POST: Firefox attaches an `Origin: moz-extension://...` header
    // to extension POST requests, which Jira's XSRF protection (or a fronting proxy)
    // rejects with 403/400. GET requests are sent without it in both browsers.
    const params = new URLSearchParams({
      jql,
      maxResults: String(maxResults),
      fields: fields.join(',')
    });

    if (isCloud) {
      if (options.nextPageToken) {
        params.set('nextPageToken', options.nextPageToken);
      }
    } else {
      params.set('startAt', String(startAt));
      if (options.validateQuery) {
        params.set('validateQuery', options.validateQuery);
      }
    }

    const queryParams = params.toString();

    // Cloud fallback: if /rest/api/3/search/jql returns 404, fallback to /rest/api/2/search/jql
    const { response, path: endpoint } = await this.#requestWithV2Fallback(
      isCloud ? `/rest/api/3/search/jql?${queryParams}` : `/rest/api/2/search?${queryParams}`,
      { signal: options.signal }
    );

    if (!response.ok) {
      const err = await this.#handleHttpError(response, new Date().toISOString());
      const errorMsg = err.serverMessage
        ? `${err.error} (${err.serverMessage})`
        : (err.error || `Jira search request failed with status ${response.status}`);
      const error = new Error(errorMsg);
      error.status = response.status;
      throw error;
    }

    return await this.#parseJson(response, endpoint);
  }

  /**
   * Suggests issues for a partial issue key typed by the user, such as `ABC-3`: ABC-3 itself
   * first, then ABC-30, ABC-31, and so on. Only issues whose key is the typed key, or the typed
   * key followed by more digits, are returned, so `ABC-3086` never suggests ABC-308. Input that
   * isn't a partial key with at least one digit (see parseIssueKeyQuery()) returns no issues
   * without contacting Jira.
   *
   * Both editions run one bounded JQL search through searchIssues() (`/rest/api/3/search/jql`
   * on Cloud, `/rest/api/2/search` with `validateQuery=warn` on Data Center / Server), asking
   * only for `summary` and `status`. When the typed key isn't among the results, it's looked
   * up directly (`GET /issue/{key}`): that finds an issue reached by an old key after a move,
   * and, on Cloud, an issue created moments ago that the search index doesn't list yet.
   *
   * @param {string} query - As typed
   * @param {object} [options]
   * @param {number} [options.maxResults=10] - At most ISSUE_SUGGESTION_LIMIT
   * @param {AbortSignal} [options.signal] - Cancels the requests; the promise then rejects with an AbortError
   * @returns {Promise<Array<{ issueId: string, issueKey: string, issueSummary: string, issueStatus: object | null }>>}
   *   Rejects with a user-facing Error (with `status` for HTTP errors) when Jira can't be searched
   */
  async suggestIssuesByKey(query, { maxResults = ISSUE_SUGGESTION_LIMIT, signal } = {}) {
    const parsed = parseIssueKeyQuery(query);
    if (!parsed) return [];

    const limit = Math.min(ISSUE_SUGGESTION_LIMIT, Math.max(1, Number(maxResults) || ISSUE_SUGGESTION_LIMIT));
    const fields = ['summary', 'status'];
    const toSuggestion = (issue) => ({
      issueId: String(issue.id ?? ''),
      issueKey: String(issue.key ?? ''),
      issueSummary: issue.fields?.summary || '',
      issueStatus: toIssueStatus(issue.fields?.status)
    });

    try {
      let found = [];
      try {
        const result = await this.searchIssues(buildIssueKeySuggestionJql(parsed), {
          maxResults: limit, fields, signal, validateQuery: 'warn'
        });
        found = Array.isArray(result?.issues) ? result.issues.map(toSuggestion) : [];
      } catch (err) {
        // 400: none of the keys exist, or the project doesn't exist or isn't visible.
        if (err.status !== 400) throw err;
      }

      const matches = rankIssueKeyMatches(found, parsed);
      if (matches[0]?.issueKey === parsed.key) return matches.slice(0, limit);

      // The typed key itself wasn't found: ask for it directly. Jira answers with the issue
      // that key belongs to (under its current key, if it moved), so it goes first.
      const exact = await this.#getIssueIfVisible(parsed.key, fields, signal);
      if (!exact) return matches.slice(0, limit);
      const exactMatch = toSuggestion(exact);
      return [exactMatch, ...matches.filter((issue) => issue.issueKey !== exactMatch.issueKey)].slice(0, limit);
    } catch (err) {
      if (err.name === 'AbortError' || err.status) throw err;
      // Timeouts and network failures
      const { error, errorType } = this.#handleException(err, '');
      const wrapped = new Error(error);
      wrapped.errorType = errorType;
      throw wrapped;
    }
  }

  /**
   * Fetches one issue by key with the given fields, or null when it doesn't exist or the
   * user can't see it (Jira answers 404 for both). There is no v2 retry on 404 here,
   * because 404 is the expected answer for a key that doesn't exist.
   *
   * @param {string} issueKey
   * @param {string[]} fields
   * @param {AbortSignal} [signal]
   * @returns {Promise<object | null>}
   */
  async #getIssueIfVisible(issueKey, fields, signal) {
    const path = this.#apiPath(`issue/${encodeURIComponent(issueKey)}?${new URLSearchParams({ fields: fields.join(',') })}`);
    const response = await this.#request(path, { signal });

    if (response.status === 404) return null;
    if (!response.ok) {
      const err = await this.#handleHttpError(response, new Date().toISOString());
      const error = new Error(err.error || `Jira issue request failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return await this.#parseJson(response, path);
  }

  /**
   * Fetches paginated worklogs for a specific Jira issue.
   *
   * @param {string} issueIdOrKey
   * @param {object} [options]
   * @param {number} [options.startAt=0]
   * @param {number} [options.maxResults=100]
   * @returns {Promise<{
   *   startAt: number,
   *   maxResults: number,
   *   total: number,
   *   worklogs: Array<object>
   * }>}
   */
  async getIssueWorklogs(issueIdOrKey, options = {}) {
    if (!issueIdOrKey) {
      throw new Error('An issue ID or issue key is required.');
    }

    const startAt = Math.max(0, Number(options.startAt) || 0);
    const maxResults = Math.min(100, Math.max(1, Number(options.maxResults) || 100));

    // Fallback from v3 to v2 if 404
    const { response, path: endpoint } = await this.#requestWithV2Fallback(
      this.#apiPath(`issue/${encodeURIComponent(issueIdOrKey)}/worklog?startAt=${startAt}&maxResults=${maxResults}`)
    );

    if (!response.ok) {
      const err = await this.#handleHttpError(response, new Date().toISOString());
      throw new Error(err.error || `Failed to fetch worklogs for issue ${issueIdOrKey}`);
    }

    return await this.#parseJson(response, endpoint);
  }

  /**
   * Updates an existing worklog in place (`PUT /issue/{issue}/worklog/{id}`). Only the
   * fields passed are sent; Jira leaves the others unchanged. The issue itself is not touched.
   *
   * @param {string} issueIdOrKey
   * @param {string} worklogId
   * @param {object} changes
   * @param {Date} [changes.started] - New start, sent with the local UTC offset
   * @param {number} [changes.timeSpentSeconds] - New duration; whole minutes, at least 60
   * @param {string} [changes.comment] - New comment text; sent as ADF on Jira Cloud
   * @returns {Promise<object>} The updated worklog returned by Jira
   */
  async updateWorklog(issueIdOrKey, worklogId, changes = {}) {
    if (!issueIdOrKey || !worklogId) {
      throw new Error('An issue and a worklog ID are required.');
    }

    const body = this.#worklogBody(changes);
    if (Object.keys(body).length === 0) {
      throw new Error('No worklog changes to save.');
    }

    const path = this.#worklogPath(issueIdOrKey, worklogId);
    const response = await this.#writeRequest(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw await this.#worklogWriteError(response, 'edit');
    }

    return await this.#parseJson(response, path);
  }

  /**
   * Logs new work on an issue (`POST /issue/{issue}/worklog`). The issue itself is not
   * changed apart from the time Jira records against it.
   *
   * @param {string} issueIdOrKey
   * @param {object} worklog
   * @param {Date} worklog.started - Start, sent with the local UTC offset
   * @param {number} worklog.timeSpentSeconds - Duration; whole minutes, at least 60
   * @param {string} [worklog.comment] - Work description; sent as ADF on Jira Cloud
   * @returns {Promise<object>} The created worklog returned by Jira
   */
  async createWorklog(issueIdOrKey, worklog = {}) {
    if (!issueIdOrKey) {
      throw new Error('An issue is required.');
    }
    if (worklog.started === undefined || worklog.timeSpentSeconds === undefined) {
      throw new Error('A start time and a duration are required.');
    }

    const path = this.#apiPath(`issue/${encodeURIComponent(issueIdOrKey)}/worklog`);
    const response = await this.#writeRequest(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.#worklogBody(worklog))
    });

    if (!response.ok) {
      throw await this.#worklogWriteError(response, 'create');
    }

    return await this.#parseJson(response, path);
  }

  /**
   * Builds a worklog request body from the fields given; fields left undefined are omitted.
   *
   * @param {{ started?: Date, timeSpentSeconds?: number, comment?: string }} fields
   * @returns {object}
   */
  #worklogBody({ started, timeSpentSeconds, comment }) {
    const body = {};
    if (started !== undefined) {
      body.started = formatJiraDateTime(started);
    }
    if (timeSpentSeconds !== undefined) {
      if (!Number.isInteger(timeSpentSeconds) || timeSpentSeconds < 60) {
        throw new Error('Duration must be a whole number of seconds and at least 1 minute.');
      }
      body.timeSpentSeconds = timeSpentSeconds;
    }
    if (comment !== undefined) {
      body.comment = this.deploymentType === 'cloud' ? plainTextToAdf(comment) : String(comment);
    }
    return body;
  }

  /**
   * Deletes a worklog (`DELETE /issue/{issue}/worklog/{id}`).
   *
   * @param {string} issueIdOrKey
   * @param {string} worklogId
   * @returns {Promise<void>}
   */
  async deleteWorklog(issueIdOrKey, worklogId) {
    if (!issueIdOrKey || !worklogId) {
      throw new Error('An issue and a worklog ID are required.');
    }

    const response = await this.#writeRequest(this.#worklogPath(issueIdOrKey, worklogId), { method: 'DELETE' });

    if (!response.ok) {
      throw await this.#worklogWriteError(response, 'delete');
    }
  }

  /**
   * @param {string} issueIdOrKey
   * @param {string} worklogId
   * @returns {string}
   */
  #worklogPath(issueIdOrKey, worklogId) {
    return this.#apiPath(`issue/${encodeURIComponent(issueIdOrKey)}/worklog/${encodeURIComponent(worklogId)}`);
  }

  /**
   * Sends a write request, turning timeouts and network failures into errors with
   * user-facing messages and an `errorType` code.
   *
   * Write requests carry a non-browser User-Agent. Jira's additional XSRF check rejects a
   * POST that has a browser User-Agent unless its Origin is the Jira site itself, and
   * Firefox sends extension requests without such an Origin, so logging work failed there.
   * Atlassian's documented workaround is to send the request without a browser User-Agent.
   * Firefox honors this header; Chrome ignores it, which is fine because Chrome passes the check.
   *
   * @param {string} path
   * @param {RequestInit} options
   * @returns {Promise<Response>}
   */
  async #writeRequest(path, options) {
    try {
      return await this.#request(path, {
        ...options,
        headers: { 'User-Agent': 'Timesheet-for-Jira', ...(options.headers || {}) }
      });
    } catch (err) {
      const { error, errorType } = this.#handleException(err, '');
      const wrapped = new Error(error);
      wrapped.errorType = errorType;
      throw wrapped;
    }
  }

  /**
   * Builds the error for a failed worklog create, edit, or delete. Messages name the cause
   * (expired token, missing permission, worklog or issue gone) and include Jira's own reason.
   *
   * @param {Response} response
   * @param {'create' | 'edit' | 'delete'} action
   * @returns {Promise<Error>}
   */
  async #worklogWriteError(response, action) {
    const status = response.status;
    let serverMessage = '';

    // Read the body as text when possible, so a plain-text reason (such as Jira's
    // "XSRF check failed") isn't lost when the body isn't JSON.
    let raw = '';
    let body = null;
    try {
      if (typeof response.text === 'function') {
        raw = await response.text();
        body = JSON.parse(raw);
      } else {
        body = await response.json();
      }
    } catch {
      // Body is not JSON
    }

    if (body && typeof body === 'object') {
      const messages = [
        ...(Array.isArray(body.errorMessages) ? body.errorMessages : []),
        ...(body.errors && typeof body.errors === 'object' ? Object.values(body.errors) : []),
        ...(typeof body.message === 'string' ? [body.message] : [])
      ].filter((m) => typeof m === 'string' && m.trim());
      serverMessage = messages.join(' ');
    } else {
      // Short plain text only; an HTML error page says nothing useful here.
      const text = String(raw).trim();
      if (text && !text.startsWith('<') && text.length <= 200) serverMessage = text;
    }

    const withDetail = (message) => (serverMessage ? `${message} Jira says: ${serverMessage}` : message);
    let message;
    let errorType;

    if (status === 401) {
      errorType = 'AUTH_INVALID';
      message = 'Jira rejected your credentials. Your token may have expired or been revoked; update it in Connection Settings.';
    } else if (status === 403 && /xsrf/i.test(serverMessage)) {
      errorType = 'XSRF';
      message = withDetail("Jira's cross-site request (XSRF) protection rejected the request, so nothing was changed.");
    } else if (status === 403) {
      errorType = 'FORBIDDEN';
      message = withDetail(action === 'create'
        ? "You don't have permission to log work on this issue in Jira."
        : `You don't have permission to ${action} this worklog in Jira.`);
    } else if (status === 404) {
      errorType = 'NOT_FOUND';
      message = action === 'create'
        ? 'This issue no longer exists in Jira, or you can no longer see it. Sync to refresh the week.'
        : 'This worklog no longer exists in Jira, or you can no longer see its issue. Sync to refresh the week.';
    } else if (status === 400) {
      errorType = 'INVALID';
      message = withDetail(`Jira didn't accept the ${{ create: 'worklog', edit: 'changes', delete: 'deletion' }[action]}.`);
    } else if (status >= 500) {
      errorType = 'SERVER_ERROR';
      message = `Jira returned a server error (${status}). Try again in a moment.`;
    } else {
      errorType = 'HTTP_ERROR';
      message = withDetail(`Unexpected response from Jira (${status}).`);
    }

    const err = new Error(message);
    err.errorType = errorType;
    err.status = status;
    return err;
  }

  /**
   * Paginates through all worklogs for an issue.
   * Useful when an issue has more than 20 worklogs, which exceeds the search API limit.
   *
   * @param {string} issueIdOrKey
   * @returns {Promise<Array<object>>}
   */
  async getAllIssueWorklogs(issueIdOrKey) {
    const allWorklogs = [];
    let startAt = 0;
    const maxResults = 100;
    let total = 0;

    do {
      const data = await this.getIssueWorklogs(issueIdOrKey, { startAt, maxResults });
      if (!data || !Array.isArray(data.worklogs) || data.worklogs.length === 0) {
        break;
      }
      allWorklogs.push(...data.worklogs);
      startAt += data.worklogs.length;
      total = Number(data.total) || 0;
    } while (startAt < total);

    return allWorklogs;
  }

  /**
   * Runs a JQL search and collects every matching issue across all result pages.
   * Jira Cloud pages with nextPageToken / isLast; Data Center / Server with startAt / total.
   *
   * @param {string} jql
   * @param {string[]} fields
   * @returns {Promise<Array<object>>}
   */
  async #searchAllIssues(jql, fields) {
    const isCloud = this.deploymentType === 'cloud';
    const issues = [];
    let startAt = 0;
    let nextPageToken;
    const maxResults = 50;
    let hasMore = false;

    do {
      const searchResult = await this.searchIssues(jql, {
        startAt,
        nextPageToken,
        maxResults,
        fields
      });

      if (!searchResult || !Array.isArray(searchResult.issues) || searchResult.issues.length === 0) {
        break;
      }

      issues.push(...searchResult.issues);

      if (isCloud) {
        const previousToken = nextPageToken;
        nextPageToken = searchResult.nextPageToken;
        hasMore = Boolean(nextPageToken) && searchResult.isLast !== true && nextPageToken !== previousToken;
      } else {
        startAt += searchResult.issues.length;
        hasMore = startAt < (Number(searchResult.total) || 0);
      }
    } while (hasMore);

    return issues;
  }

  /**
   * Retrieves Jira worklogs for the authenticated user across a date range.
   *
   * Guarantees:
   * - Uses supported Jira REST API endpoints (`/search/jql` on Cloud, `/search` on Data Center / Server,
   *   and `/issue/{key}/worklog`).
   * - Automatically resolves and caches current user identity.
   * - Handles pagination for large result sets.
   * - Avoids truncation on issues with >20 worklogs by fetching full issue worklogs.
   * - Groups by local timezone dates and avoids double-counting with ID deduplication.
   *
   * @param {Date | string} startDate - Inclusive start date of range (e.g. Monday)
   * @param {Date | string} endDate - Inclusive end date of range (e.g. Sunday)
   * @returns {Promise<{
   *   worklogs: Array<object>,
   *   user: object,
   *   startDateKey: string,
   *   endDateKey: string
   * }>}
   */
  async getWorklogsForDateRange(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error('Valid startDate and endDate are required.');
    }

    // 1. Resolve current user identity
    const currentUser = await this.getCurrentUser();

    // 2. Format local date keys (YYYY-MM-DD)
    const startKey = getLocalDateKey(start);
    const endKey = getLocalDateKey(end);

    // Add a 1-day buffer before and after the range in the JQL query.
    // This guarantees that any worklog near midnight in the user's local timezone
    // is not excluded by Jira server timezone differences. Strict local timezone
    // filtering is then performed client-side.
    const bufferStart = new Date(start);
    bufferStart.setDate(bufferStart.getDate() - 1);
    const bufferEnd = new Date(end);
    bufferEnd.setDate(bufferEnd.getDate() + 1);

    const jqlStartDate = getLocalDateKey(bufferStart);
    const jqlEndDate = getLocalDateKey(bufferEnd);

    const jql = `worklogAuthor = currentUser() AND worklogDate >= "${jqlStartDate}" AND worklogDate <= "${jqlEndDate}" order by updated desc`;

    // 3. Paginate through all matching issues
    const issues = await this.#searchAllIssues(jql, ['summary', 'status', 'worklog']);

    // 4. Extract and filter worklogs
    const collectedWorklogs = [];
    const seenWorklogIds = new Set();

    for (const issue of issues) {
      const issueKey = issue.key;
      const issueSummary = issue.fields?.summary || 'No summary available';
      const issueId = issue.id;
      const issueStatus = toIssueStatus(issue.fields?.status);

      let rawWorklogs = [];
      const worklogField = issue.fields?.worklog;

      // Jira search API embeds up to 20 worklogs directly.
      // If an issue has more worklogs (total > worklogs.length), fetch the full list.
      if (worklogField && Array.isArray(worklogField.worklogs)) {
        if (worklogField.total > worklogField.worklogs.length) {
          rawWorklogs = await this.getAllIssueWorklogs(issueKey);
        } else {
          rawWorklogs = worklogField.worklogs;
        }
      } else {
        rawWorklogs = await this.getAllIssueWorklogs(issueKey);
      }

      for (const wl of rawWorklogs) {
        const wlId = wl.id ? String(wl.id) : null;
        if (wlId && seenWorklogIds.has(wlId)) {
          continue; // Avoid double-counting
        }

        // Verify author matches current user
        if (!isWorklogByUser(wl, currentUser)) {
          continue;
        }

        if (!wl.started) continue;
        const wlStartDate = new Date(wl.started);
        if (isNaN(wlStartDate.getTime())) continue;

        // Verify local date falls inside the requested week range
        const localDateKey = getLocalDateKey(wlStartDate);
        if (localDateKey >= startKey && localDateKey <= endKey) {
          if (wlId) {
            seenWorklogIds.add(wlId);
          }

          collectedWorklogs.push({
            id: wlId || `wl-${Math.random()}`,
            issueId,
            issueKey,
            issueSummary,
            issueStatus,
            comment: wl.comment,
            started: wl.started,
            timeSpentSeconds: Number(wl.timeSpentSeconds) || 0,
            timeSpent: wl.timeSpent || '',
            author: wl.author
          });
        }
      }
    }

    return {
      worklogs: collectedWorklogs,
      user: currentUser,
      startDateKey: startKey,
      endDateKey: endKey
    };
  }
}
