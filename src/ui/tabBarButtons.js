/**
 * The edit (pencil) and + buttons that follow a row of tabs: Issues' view tabs (src/ui/weekView.js)
 * and the Worklog Queue's group tabs (src/ui/pendingWorklogs.js) share them, so both look and act
 * the same. Small round icon buttons (`working-issues-view-btn`, options.css); a click is the
 * button's alone, never the group header's.
 */

import { h, svg } from './dom.js';

const ICON_STROKE = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' };
const buttonIcon = (...shapes) => svg('svg', {
  class: 'icon', ...ICON_STROKE, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
}, ...shapes);

function tabBarButton({ action, focusKey, label, title, onClick }, icon) {
  const button = h('button', {
    type: 'button', class: 'working-issues-view-btn', 'data-action': action, 'data-focus-key': focusKey,
    'aria-label': label, title
  }, icon);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

/**
 * The pencil button that edits the selected tab.
 * @param {{ action: string, focusKey: string, label: string, title: string, onClick: () => void }} options
 * @returns {HTMLButtonElement}
 */
export function tabEditButton(options) {
  return tabBarButton(options, buttonIcon(
    svg('path', { d: 'M12 20h9' }),
    svg('path', { d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' })));
}

/**
 * The + button that adds a tab.
 * @param {{ action: string, focusKey: string, label: string, title: string, onClick: () => void }} options
 * @returns {HTMLButtonElement}
 */
export function tabAddButton(options) {
  return tabBarButton(options, buttonIcon(
    svg('line', { x1: '12', y1: '5', x2: '12', y2: '19' }),
    svg('line', { x1: '5', y1: '12', x2: '19', y2: '12' })));
}
