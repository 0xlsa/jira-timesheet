/**
 * The About section at the bottom of the Connection Settings drawer: the extension's name and
 * version (from the browser's copy of manifest.json) and who made it (from src/about/about.json).
 */

import { h, svg } from './dom.js';

/** Developer and repository details, packaged with the extension. */
export const ABOUT_INFO_URL = new URL('../about/about.json', import.meta.url);

/** Used when the page runs outside an extension, where there is no manifest to read. */
const FALLBACK_NAME = 'Timesheet for Jira';

const httpsUrl = (value) => {
  try {
    return new URL(value).protocol === 'https:' ? String(value) : '';
  } catch {
    return '';
  }
};

/**
 * Reads src/about/about.json. Fields that are missing or aren't HTTPS links come back empty,
 * and so does everything when the file can't be read, so the section still shows the version.
 *
 * @param {(url: URL) => Promise<Response>} [fetchFn]
 * @param {URL | string} [url]
 * @returns {Promise<{ developer: string, developerUrl: string, repositoryUrl: string }>}
 */
export async function loadAboutInfo(fetchFn = globalThis.fetch, url = ABOUT_INFO_URL) {
  let data = {};
  try {
    const response = await fetchFn(url);
    if (response.ok) data = await response.json();
  } catch (err) {
    console.warn('Could not read the About details:', err);
  }
  return {
    developer: typeof data?.developer === 'string' ? data.developer.trim() : '',
    developerUrl: httpsUrl(data?.developerUrl),
    repositoryUrl: httpsUrl(data?.repositoryUrl)
  };
}

// Opens in a new tab, like the other links out of the page, and says so to screen readers.
const externalLink = (href, title, ...children) =>
  h('a', { href, target: '_blank', rel: 'noopener noreferrer', title }, ...children,
    h('span', { class: 'sr-only' }, ' (opens in a new tab)'));

/** The Git logo (by Jason Long, CC BY 3.0), in the link's color. */
const gitIcon = () =>
  svg('svg', { class: 'settings-about-icon', viewBox: '0 0 92 92', fill: 'currentColor', 'aria-hidden': 'true' },
    svg('path', { d: 'M90.156 41.965L50.036 1.845c-2.31-2.311-6.06-2.311-8.372 0l-8.33 8.33 10.566 10.566c2.457-.829 5.272-.273 7.229 1.685 1.969 1.97 2.521 4.81 1.67 7.275l10.186 10.185c2.465-.85 5.307-.3 7.275 1.671 2.75 2.75 2.75 7.206 0 9.958-2.752 2.751-7.208 2.751-9.961 0-2.068-2.07-2.58-5.11-1.531-7.658l-9.5-9.499v24.997c.67.332 1.303.774 1.861 1.332 2.75 2.75 2.75 7.206 0 9.959-2.75 2.749-7.209 2.749-9.957 0-2.75-2.754-2.75-7.21 0-9.959.68-.679 1.467-1.193 2.307-1.537v-25.23c-.84-.344-1.625-.853-2.307-1.537-2.083-2.082-2.584-5.14-1.516-7.698L31.798 16.715 4.288 44.222c-2.311 2.313-2.311 6.063 0 8.375l40.121 40.118c2.31 2.311 6.059 2.311 8.372 0l39.938-39.937c2.311-2.312 2.311-6.062-.002-8.373z' }));

/**
 * Fills the About section.
 *
 * @param {HTMLElement} root
 * @param {{ manifest?: { name?: string, version?: string } | null, info: { developer: string, developerUrl: string, repositoryUrl: string } }} options
 */
export function renderAboutSection(root, { manifest, info }) {
  const name = manifest?.name || FALLBACK_NAME;
  const { developer, developerUrl, repositoryUrl } = info;

  root.replaceChildren(
    h('h3', { id: 'aboutTitle', class: 'settings-about-title' }, 'About'),
    h('p', { class: 'settings-about-version' }, name, manifest?.version && ` · v${manifest.version}`),
    developer && h('p', {}, 'Developed by ',
      developerUrl ? externalLink(developerUrl, `${developer} on GitHub`, `@${developer}`) : `@${developer}`),
    repositoryUrl && h('p', {},
      externalLink(repositoryUrl, repositoryUrl, gitIcon(), 'View source on GitHub', h('span', { 'aria-hidden': 'true' }, ' ↗')))
  );
}
