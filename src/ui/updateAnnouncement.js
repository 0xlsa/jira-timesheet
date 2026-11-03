/**
 * The update announcement: a small card at the top of the timesheet, shown once after an update,
 * with the new version and only its highlights (at most MAX_ANNOUNCED_HIGHLIGHTS, from CHANGELOG.md
 * through src/changelog/changelogState.js), never the release history. It never blocks the page or
 * takes focus.
 *
 * Explore updates opens What's New. The close button only hides the card: the release notes aren't
 * read until What's New has shown them, so the NEW badge stays.
 */

import { h, svg } from './dom.js';

// The most highlights listed (release validation allows 1 to 3 per release).
export const MAX_ANNOUNCED_HIGHLIGHTS = 3;

const ICON_STROKE = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };

/**
 * Fills `root` with the announcement for a release and shows it.
 *
 * @param {HTMLElement} root - The card's container, hidden until now
 * @param {object} options
 * @param {{ version: string }} options.release
 * @param {string[]} options.highlights - The release's highlights (the first three are listed); none
 *   leaves the list out
 * @param {() => void} options.onExplore - Explore updates, which opens What's New (the card is hidden first)
 * @param {() => void} [options.onDismiss] - The close button (the card is hidden first)
 */
export function showUpdateAnnouncement(root, { release, highlights, onExplore, onDismiss }) {
  const explore = h('button', { type: 'button', class: 'btn btn-primary btn-sm', 'data-action': 'explore-changelog' }, 'Explore updates');
  const closeButton = h('button', {
    type: 'button', class: 'editor-icon-btn update-announcement-close', 'data-action': 'dismiss-announcement',
    'aria-label': 'Close the update announcement', title: 'Close'
  }, svg('svg', { class: 'icon', ...ICON_STROKE }, svg('line', { x1: '18', y1: '6', x2: '6', y2: '18' }), svg('line', { x1: '6', y1: '6', x2: '18', y2: '18' })));

  const contents = h('div', { class: 'panel-alert alert-info update-announcement-card' },
    // A gift: something new
    svg('svg', { class: 'alert-icon', ...ICON_STROKE },
      svg('polyline', { points: '20 12 20 22 4 22 4 12' }),
      svg('rect', { x: '2', y: '7', width: '20', height: '5' }),
      svg('line', { x1: '12', y1: '22', x2: '12', y2: '7' }),
      svg('path', { d: 'M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z' }),
      svg('path', { d: 'M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z' })),
    h('div', { class: 'alert-content' },
      h('h4', { id: 'updateAnnouncementTitle' }, `What's New in v${release.version}`),
      highlights.length > 0 && h('ul', { class: 'update-announcement-highlights' },
        highlights.slice(0, MAX_ANNOUNCED_HIGHLIGHTS).map((text) => h('li', {}, text))),
      h('div', { class: 'update-announcement-actions' }, explore)),
    closeButton);

  // Listeners are on the card's contents, which are replaced each time it's shown.
  contents.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    hideUpdateAnnouncement(root);
    if (action === 'explore-changelog') onExplore();
    else onDismiss?.();
  });

  root.replaceChildren(contents);
  root.setAttribute('aria-labelledby', 'updateAnnouncementTitle');
  root.classList.remove('hidden');
}

/**
 * Hides and empties the announcement. Nothing is recorded: whether it was shown is recorded when
 * it's shown, and the release notes count as read only once the Changelog shows them.
 * @param {HTMLElement} root
 */
export function hideUpdateAnnouncement(root) {
  root.classList.add('hidden');
  root.replaceChildren();
  root.removeAttribute('aria-labelledby');
}

/** True while the announcement is on the page. */
export function isUpdateAnnouncementShown(root) {
  return !root.classList.contains('hidden');
}
