/**
 * JiraAuthProvider
 * Base abstract class defining the contract for Jira authentication providers.
 *
 * Keeps authentication mechanism details isolated from API client and UI layers.
 */
export class JiraAuthProvider {
  /**
   * Returns HTTP headers required for authenticating Jira REST API requests.
   * @returns {Promise<Record<string, string>> | Record<string, string>}
   */
  getAuthHeaders() {
    throw new Error('getAuthHeaders() must be implemented by subclass.');
  }

  /**
   * Returns the REST API path used for identity verification.
   * @returns {string}
   */
  getIdentityEndpoint() {
    throw new Error('getIdentityEndpoint() must be implemented by subclass.');
  }

  /**
   * Returns deployment identifier ('cloud' | 'server').
   * @returns {string}
   */
  getDeploymentType() {
    throw new Error('getDeploymentType() must be implemented by subclass.');
  }

  /**
   * Validates provider credentials format before sending requests.
   * @returns {{ isValid: boolean, error: string | null }}
   */
  validate() {
    throw new Error('validate() must be implemented by subclass.');
  }

  /**
   * Redacts sensitive information when converted to string.
   */
  toString() {
    return `[${this.constructor.name}: ${this.getDeploymentType()}]`;
  }

  /**
   * Redacts sensitive information when serialized to JSON.
   */
  toJSON() {
    return {
      provider: this.constructor.name,
      deploymentType: this.getDeploymentType()
    };
  }
}

