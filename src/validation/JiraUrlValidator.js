/**
 * JiraUrlValidator
 * Validates, normalizes, and extracts origin patterns from Jira Base URLs.
 *
 * Rules:
 * - Must be a valid URL.
 * - Must use HTTPS (HTTP is rejected for security).
 * - Rejects URLs with embedded credentials (e.g. https://user:pass@host).
 * - Rejects URLs with query strings (e.g. ?query=value).
 * - Rejects URLs with hash fragments (e.g. #anchor).
 * - Preserves deployment context paths (e.g. /jira in https://company.com/jira).
 * - Normalizes trailing slashes.
 * - Extracts origin pattern for Chrome Extension host permissions.
 */
export class JiraUrlValidator {
  /**
   * Known Jira endpoints that users might accidentally paste instead of the base URL.
   * If detected at the end of the path, they are stripped to recover the true base URL.
   */
  static ACCIDENTAL_SUFFIX_PATTERN = /\/(rest(\/api\/[0-9]+)?(\/myself)?|browse\/[A-Z0-9_-]+|jira\/software\/projects\/.*|secure\/.*)$/i;

  /**
   * Example instance URLs per Jira edition, shown in the URL field and error messages.
   */
  static EXAMPLE_URLS = {
    cloud: 'https://your-domain.atlassian.net',
    server: 'https://jira.your-company.com'
  };

  /**
   * Validates and sanitizes a raw Jira Base URL.
   *
   * @param {string} rawUrl - The user-entered URL.
   * @param {object} [options]
   * @param {'cloud' | 'server'} [options.deploymentType='cloud'] - Edition used for the example URL in errors
   * @returns {{
   *   isValid: boolean,
   *   sanitizedUrl: string,
   *   originPattern: string,
   *   error: string | null
   * }}
   */
  static validate(rawUrl, { deploymentType = 'cloud' } = {}) {
    if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
      return {
        isValid: false,
        sanitizedUrl: '',
        originPattern: '',
        error: 'Jira Base URL is required.'
      };
    }

    const trimmed = rawUrl.trim();

    let parsedUrl;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      return {
        isValid: false,
        sanitizedUrl: '',
        originPattern: '',
        error: `Invalid URL format. Please enter a valid URL (e.g., ${this.EXAMPLE_URLS[deploymentType] || this.EXAMPLE_URLS.cloud}).`
      };
    }

    // Protocol validation: Enforce HTTPS
    if (parsedUrl.protocol !== 'https:') {
      return {
        isValid: false,
        sanitizedUrl: '',
        originPattern: '',
        error: 'Insecure protocol. Timesheet for Jira requires HTTPS to protect your credentials and data.'
      };
    }

    // Reject embedded credentials (e.g., https://user:pass@jira.com)
    if (parsedUrl.username || parsedUrl.password) {
      return {
        isValid: false,
        sanitizedUrl: '',
        originPattern: '',
        error: 'Embedded credentials in the URL are forbidden for security reasons.'
      };
    }

    // Reject query strings
    if (parsedUrl.search) {
      return {
        isValid: false,
        sanitizedUrl: '',
        originPattern: '',
        error: 'Query strings are not allowed in the Jira Base URL.'
      };
    }

    // Reject hash fragments
    if (parsedUrl.hash) {
      return {
        isValid: false,
        sanitizedUrl: '',
        originPattern: '',
        error: 'URL hash fragments are not allowed in the Jira Base URL.'
      };
    }

    // Validate hostname
    if (!parsedUrl.hostname || parsedUrl.hostname.includes(' ') || parsedUrl.hostname.startsWith('.')) {
      return {
        isValid: false,
        sanitizedUrl: '',
        originPattern: '',
        error: 'Invalid hostname in Jira Base URL.'
      };
    }

    // Extract path and preserve context paths (e.g., /jira)
    let pathname = parsedUrl.pathname;

    // Check for accidental REST / browse path suffixes and strip them
    if (this.ACCIDENTAL_SUFFIX_PATTERN.test(pathname)) {
      pathname = pathname.replace(this.ACCIDENTAL_SUFFIX_PATTERN, '');
    }

    // Normalize multiple slashes and strip trailing slashes
    pathname = pathname.replace(/\/+/g, '/').replace(/\/+$/, '');

    // Reconstruct sanitized URL
    const portPart = parsedUrl.port ? `:${parsedUrl.port}` : '';
    const sanitizedUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}${portPart}${pathname}`;

    // Construct origin match pattern for Chrome permissions
    // Form: https://hostname:port/* or https://hostname/*
    const originPattern = `${parsedUrl.protocol}//${parsedUrl.hostname}${portPart}/*`;

    return {
      isValid: true,
      sanitizedUrl,
      originPattern,
      error: null
    };
  }

  /**
   * Returns the origin pattern needed for Chrome runtime host permissions.
   *
   * @param {string} url
   * @returns {string}
   */
  static getOriginPattern(url) {
    const result = this.validate(url);
    if (!result.isValid) {
      throw new Error(result.error || 'Invalid URL');
    }
    return result.originPattern;
  }

  /**
   * Ensures that a candidate target URL belongs to the same origin as the configured base URL.
   * Prevents credential leakage to third-party or mismatched origins.
   *
   * @param {string} targetUrl
   * @param {string} expectedBaseUrl
   * @returns {boolean}
   */
  static isSameOrigin(targetUrl, expectedBaseUrl) {
    try {
      const target = new URL(targetUrl);
      const expected = new URL(expectedBaseUrl);
      return target.origin === expected.origin;
    } catch {
      return false;
    }
  }
}

