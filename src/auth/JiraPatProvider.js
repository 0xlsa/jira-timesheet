import { JiraAuthProvider } from './JiraAuthProvider.js';

/**
 * JiraPatProvider
 * Handles Bearer token authentication for Jira Data Center and compatible Jira Server
 * instances using a Personal Access Token (PAT).
 */
export class JiraPatProvider extends JiraAuthProvider {
  #pat;

  /**
   * @param {string} pat - Personal Access Token
   */
  constructor(pat) {
    super();
    this.#pat = (pat || '').trim();
  }

  getDeploymentType() {
    return 'server';
  }

  /**
   * Jira Data Center / Server identity endpoint (REST API v2).
   */
  getIdentityEndpoint() {
    return '/rest/api/2/myself';
  }

  /**
   * Server info endpoint for version and build metadata verification.
   */
  getServerInfoEndpoint() {
    return '/rest/api/2/serverInfo';
  }

  /**
   * Validates PAT presence.
   *
   * @returns {{ isValid: boolean, error: string | null }}
   */
  validate() {
    if (!this.#pat) {
      return {
        isValid: false,
        error: 'Personal Access Token (PAT) is required for Jira Data Center / Server.'
      };
    }

    return { isValid: true, error: null };
  }

  /**
   * Constructs HTTP Bearer Authentication headers.
   *
   * @returns {Record<string, string>}
   */
  getAuthHeaders() {
    const validation = this.validate();
    if (!validation.isValid) {
      throw new Error(validation.error || 'Invalid credentials');
    }

    return {
      'Authorization': `Bearer ${this.#pat}`
    };
  }

  /**
   * Ensure credentials are not leaked when serialized.
   */
  toJSON() {
    return {
      provider: 'JiraPatProvider',
      deploymentType: this.getDeploymentType()
    };
  }
}

