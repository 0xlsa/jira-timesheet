/**
 * The Jira Connection section of the Connection Settings form: a header button that expands and
 * collapses the instance URL, account email, token, and security notice. The Jira edition
 * selector stays outside it.
 *
 * Collapsing only hides the fields: their values stay in the form, so testing and saving work
 * the same either way. The section is expanded when the connection details are missing, and
 * collapsed by default once they're all saved.
 */

import { isConfigured } from '../settings/settingsStore.js';

/**
 * Whether the section starts collapsed: only when every required connection detail is saved.
 * @param {Parameters<typeof isConfigured>[0] | null | undefined} settings
 */
export function shouldCollapseConnection(settings) {
  return Boolean(settings) && isConfigured(settings);
}

/**
 * Wires the header button to the section body.
 *
 * @param {object} elements
 * @param {HTMLElement} elements.section - Gets `is-collapsed` while collapsed
 * @param {HTMLButtonElement} elements.toggle - Header button, with aria-controls set to the body's id
 * @param {HTMLElement} elements.body
 * @returns {{ isExpanded: () => boolean, setExpanded: (expanded: boolean) => void }}
 */
export function createConnectionSection({ section, toggle, body }) {
  const isExpanded = () => toggle.getAttribute('aria-expanded') === 'true';

  function setExpanded(expanded) {
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    section.classList.toggle('is-collapsed', !expanded);
    body.classList.toggle('hidden', !expanded);
  }

  // A native button, so Enter and Space toggle it as well as a click.
  toggle.addEventListener('click', () => setExpanded(!isExpanded()));
  setExpanded(true);

  return { isExpanded, setExpanded };
}
