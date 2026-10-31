/**
 * The Jira Connection section of the Connection Settings form: a header button that expands and
 * collapses the Jira edition selector, instance URL, account email, token, and security notice.
 *
 * Collapsing only hides the fields: their values stay in the form, so testing and saving work
 * the same either way. The section is expanded when the connection details are missing, and
 * collapsed by default once they're all saved.
 *
 * Until they're saved, the header is a setup prompt ("Configure Jira Connection", with a line
 * of help); once they are, it's just "Jira Connection". Saved details aren't a tested connection:
 * the header says nothing about whether the connection works.
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
 * @param {HTMLElement} elements.title - The header's title
 * @param {HTMLElement} elements.setupHint - The header's help line, shown only while not configured
 * @returns {{
 *   isExpanded: () => boolean,
 *   setExpanded: (expanded: boolean) => void,
 *   setConfigured: (configured: boolean) => void
 * }}
 */
export function createConnectionSection({ section, toggle, body, title, setupHint }) {
  const isExpanded = () => toggle.getAttribute('aria-expanded') === 'true';

  function setExpanded(expanded) {
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    section.classList.toggle('is-collapsed', !expanded);
    body.classList.toggle('hidden', !expanded);
  }

  /** Shows the header as a setup prompt until the connection details are saved. */
  function setConfigured(configured) {
    section.classList.toggle('needs-setup', !configured);
    title.textContent = configured ? 'Jira Connection' : 'Configure Jira Connection';
    setupHint.classList.toggle('hidden', configured);
  }

  // A native button, so Enter and Space toggle it as well as a click.
  toggle.addEventListener('click', () => setExpanded(!isExpanded()));
  setExpanded(true);

  return { isExpanded, setExpanded, setConfigured };
}
