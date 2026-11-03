/**
 * What's New drawer: what the latest release brings, from the release notes
 * (src/changelog/changelogState.js): its version, date, and changes under user-friendly category
 * labels (CATEGORY_LABELS), with its highlights marked. Only the latest release is shown; the older
 * ones stay in CHANGELOG.md and the generated release notes. It opens from the header's What's New
 * button, in the same place as the other drawers.
 *
 * The development output of the release notes (an unpacked copy, or a development build) also has
 * the changes not released yet: they're shown first, as "What's New — Unreleased". That preview is
 * never a release: it isn't marked Latest and is never reported as read.
 *
 * The latest release counts as read only once its notes are on screen: after they're drawn in the
 * open drawer, at the next frame, `onRead` gets its version. Nothing is read when the notes can't be
 * loaded, when there's no release (only the preview, or nothing), or when the drawer closed before
 * they were drawn.
 */

import { h, svg, fragment } from './dom.js';
import { showPanel, hidePanel } from './panel.js';
import { dateFromKey } from './nextHolidayBanner.js';

export const DRAWER_TITLE = "What's New";
export const LOADING_MESSAGE = 'Loading the release notes…';
export const UNAVAILABLE_MESSAGE = "Couldn't load the release notes.";
export const EMPTY_MESSAGE = 'No releases yet.';
export const UNRELEASED_TITLE = "What's New — Unreleased";
export const UNRELEASED_NOTE = 'These changes are currently in development and are not yet part of a published release.';

// What each CHANGELOG.md category is called in the drawer. Categories without entries aren't shown.
export const CATEGORY_LABELS = {
  Added: 'New features',
  Changed: 'Improvements',
  Deprecated: 'Deprecated',
  Removed: 'Removed',
  Fixed: 'Bug fixes',
  Security: 'Security updates'
};

// A release's date: "31 October 2026".
const RELEASE_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

const closeIcon = () => svg('svg', {
  class: 'icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'aria-hidden': 'true'
}, svg('line', { x1: '18', y1: '6', x2: '6', y2: '18' }), svg('line', { x1: '6', y1: '6', x2: '18', y2: '18' }));

// Marks a highlight in the latest release: a star, and "Highlight:" for screen readers.
const highlightMark = () => [
  svg('svg', { class: 'changelog-highlight-icon', viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' },
    svg('polygon', { points: '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2' })),
  h('span', { class: 'sr-only' }, 'Highlight: ')
];

/** An item's sub-items, as a list under its text; nothing without them. */
const renderSubitems = (item) => (item.subitems?.length
  ? h('ul', { class: 'changelog-subitems' }, item.subitems.map((text) => h('li', {}, text)))
  : null);

/**
 * Builds the changes under their categories' labels (only the categories with entries), each
 * item's sub-items listed under it.
 * @param {Array<{ type: string, items: Array<{ text: string, highlight?: boolean, subitems?: string[] }> }>} sections
 * @param {boolean} markHighlights - Mark the highlights (the latest release only)
 */
function renderSections(sections, markHighlights) {
  return sections.filter(({ items }) => items.length > 0).map(({ type, items }) => h('div', { class: 'changelog-section', 'data-category': type },
    h('h4', { class: 'changelog-category' }, CATEGORY_LABELS[type] ?? type),
    h('ul', { class: 'changelog-items' }, items.map((item) => (markHighlights && item.highlight
      ? h('li', { class: 'is-highlight' }, highlightMark(), item.text, renderSubitems(item))
      : h('li', {}, item.text, renderSubitems(item)))))));
}

/**
 * Builds the latest release: its version, marked Latest, its date, and its changes under their
 * categories' labels, with its highlights marked.
 *
 * @param {{ version: string, date: string, sections: Array<{ type: string, items: Array<{ text: string, highlight?: boolean }> }> }} release
 * @returns {HTMLElement}
 */
export function renderRelease(release) {
  const headingId = `changelogRelease-${release.version.replaceAll('.', '-')}`;
  return h('section', { class: 'changelog-release is-latest', 'aria-labelledby': headingId, 'data-version': release.version },
    h('div', { class: 'changelog-release-header' },
      h('h3', { id: headingId, class: 'changelog-version' }, `Version ${release.version}`),
      h('span', { class: 'changelog-latest' }, 'Latest'),
      h('time', { class: 'changelog-date', datetime: release.date }, RELEASE_DATE_FORMAT.format(dateFromKey(release.date)))),
    renderSections(release.sections, true));
}

/**
 * Builds the preview of the changes not released yet (development output only): titled "What's
 * New — Unreleased", with the explanation, and no version, date, Latest label, or highlights.
 *
 * @param {{ sections: Array<object> }} unreleased
 * @returns {HTMLElement}
 */
export function renderUnreleased(unreleased) {
  return h('section', { class: 'changelog-release is-unreleased', 'aria-labelledby': 'changelogUnreleased' },
    h('div', { class: 'changelog-release-header' },
      h('h3', { id: 'changelogUnreleased', class: 'changelog-version' }, UNRELEASED_TITLE)),
    h('p', { class: 'changelog-unreleased-note' }, UNRELEASED_NOTE),
    renderSections(unreleased.sections, false));
}

/**
 * Opens the drawer inside `root` (an initially hidden panel element), loading the release notes.
 * Focus moves to the release list. Escape or the close button closes it.
 *
 * @param {HTMLElement} root
 * @param {object} options
 * @param {() => Promise<{ releases: Array<object>, unreleased: object | null } | null>} options.loadChangelog -
 *   The releases, newest first, and the unreleased changes (development output only), or null when
 *   they can't be read
 * @param {(version: string) => void} options.onRead - Called with the latest release's version once
 *   it's on screen
 * @param {() => void} options.onClose - Called as soon as the drawer closes
 * @param {(callback: () => void) => void} [options.afterRender] - Runs `callback` once what was just
 *   drawn is on screen (the next animation frame)
 * @returns {{ close: () => void, readonly isOpen: boolean }}
 */
export function openChangelogDrawer(root, { loadChangelog, onRead, onClose, afterRender = (callback) => requestAnimationFrame(callback) }) {
  const list = h('div', { id: 'changelogList', class: 'changelog-list', tabindex: '0', role: 'region', 'aria-label': 'Release notes', 'aria-busy': 'true' },
    h('p', { class: 'changelog-message' }, LOADING_MESSAGE));

  const contents = h('div', { class: 'changelog-drawer-body' },
    h('div', { class: 'changelog-header' },
      h('h2', { class: 'changelog-title', id: 'changelogTitle' }, DRAWER_TITLE),
      h('button', { type: 'button', class: 'editor-icon-btn', 'data-action': 'close-changelog', 'aria-label': "Close What's New", title: 'Close' },
        closeIcon())),
    list);

  let isOpen = true;

  function close() {
    if (!isOpen) return;
    isOpen = false;
    hidePanel(root);
    onClose();
  }

  // Listeners are on the drawer's contents, which are replaced on every open, so they never pile up
  // and a closed drawer's listeners can't react.
  contents.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="close-changelog"]')) close();
  });
  contents.addEventListener('keydown', (event) => {
    if (!isOpen || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });

  showPanel(root, contents);
  root.setAttribute('aria-labelledby', 'changelogTitle');
  list.focus();

  Promise.resolve()
    .then(loadChangelog)
    .catch(() => null)
    .then((changelog) => {
      if (!isOpen) return;
      list.removeAttribute('aria-busy');
      if (!changelog) {
        list.replaceChildren(h('p', { class: 'changelog-message', role: 'status' }, UNAVAILABLE_MESSAGE));
        return;
      }
      // The preview of unreleased changes first (development output only), then the latest release.
      // The older releases aren't shown.
      const { unreleased, releases } = changelog;
      const latest = releases[0];
      // fragment() leaves out the parts there aren't (replaceChildren() would add them as text).
      list.replaceChildren(fragment(
        unreleased && renderUnreleased(unreleased),
        latest ? renderRelease(latest) : h('p', { class: 'changelog-message' }, EMPTY_MESSAGE)));
      // Only a release is ever read, never the preview.
      if (!latest) return;
      afterRender(() => {
        if (isOpen) onRead(latest.version);
      });
    });

  return {
    close,
    get isOpen() {
      return isOpen;
    }
  };
}
