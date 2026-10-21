import { JiraAuthProvider } from './JiraAuthProvider.js';

/**
 * Safely converts string to Base64 in both browser and Node.js environments,
 * handling UTF-8 characters without throwing DOMException.
 *
 * @param {string} input
 * @returns {string}
 */
function safeBase64Encode(input) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(input, 'utf-8').toString('base64');
  }
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Basic email format regex.
 */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * JiraCloudTokenProvider
 * Handles authentication for Jira Cloud instances using an Atlassian account email
 * and API token via HTTP Basic authentication.
 */
export class JiraCloudTokenProvider extends JiraAuthProvider {
  #email;
  #apiToken;

  /**
   * @param {string} email - Atlassian account email address
   * @param {string} apiToken - Atlassian API token
   */
  constructor(email, apiToken) {
    super();
    this.#email = (email || '').trim();
    this.#apiToken = (apiToken || '').trim();
  }

  get email() {
    return this.#email;
  }

  getDeploymentType() {
    return 'cloud';
  }

  /**
   * Jira Cloud standard identity endpoint (REST API v3).
   */
  getIdentityEndpoint() {
    return '/rest/api/3/myself';
  }

  /**
   * Validates account email and API token format.
   *
   * @returns {{ isValid: boolean, error: string | null }}
   */
  validate() {
    if (!this.#email) {
      return {
        isValid: false,
        error: 'Jira Cloud requires an account email address.'
      };
    }

    if (!EMAIL_REGEX.test(this.#email)) {
      return {
        isValid: false,
        error: 'Invalid Jira Cloud account email address format.'
      };
    }

    if (!this.#apiToken) {
      return {
        isValid: false,
        error: 'Jira Cloud requires an API token.'
      };
    }

    return { isValid: true, error: null };
  }

  /**
   * Constructs HTTP Basic Authentication headers.
   *
   * @returns {Record<string, string>}
   */
  getAuthHeaders() {
    const validation = this.validate();
    if (!validation.isValid) {
      throw new Error(validation.error || 'Invalid credentials');
    }

    const credentials = `${this.#email}:${this.#apiToken}`;
    const encoded = safeBase64Encode(credentials);

    return {
      'Authorization': `Basic ${encoded}`
    };
  }

  /**
   * Ensure credentials are not leaked when serialized.
   */
  toJSON() {
    return {
      provider: 'JiraCloudTokenProvider',
      deploymentType: this.getDeploymentType(),
      email: this.#email ? `${this.#email.slice(0, 3)}***@***` : ''
    };
  }
}

