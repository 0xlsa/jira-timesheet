/**
 * Contents of the settings page's connection status area: connecting, connected (with the
 * Jira account), failed (with Jira's reason), or an informational message.
 */

import { h, svg } from './dom.js';

/** Status area class for each kind of status, next to `status-container`. */
export const STATUS_CLASSES = {
  loading: 'status-info',
  success: 'status-success',
  error: 'status-error',
  info: 'status-info'
};

const headerIcon = (...shapes) => svg('svg', {
  class: 'status-header-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2'
}, ...shapes);

const header = (icon, text) => h('div', { class: 'status-header' }, icon, h('span', {}, text));

const timeOf = (payload) => new Date(payload.testedAt || Date.now()).toLocaleTimeString();

/**
 * Builds the status area contents.
 *
 * @param {'loading' | 'success' | 'error' | 'info'} type
 * @param {object} [payload]
 * @param {{ displayName?: string, emailAddress?: string, name?: string }} [payload.user] - success
 * @param {{ version?: string }} [payload.serverInfo] - success
 * @param {string} [payload.error] - error
 * @param {string} [payload.serverMessage] - error: Jira's own message
 * @param {string} [payload.title] - info, and error (default "Connection Failed")
 * @param {string} [payload.message] - info
 * @param {string} [payload.testedAt] - success and error
 * @returns {Node[]}
 */
export function renderConnectionStatus(type, payload = {}) {
  if (type === 'loading') {
    return [
      h('div', { class: 'status-header' },
        h('span', { class: 'btn-spinner' }),
        h('span', {}, 'Connecting to Jira...')),
      h('div', { class: 'status-body' }, 'Verifying credentials and identity endpoint.')
    ];
  }

  if (type === 'success') {
    const user = payload.user || {};
    const serverInfo = payload.serverInfo;
    const initial = (user.displayName || 'U').charAt(0).toUpperCase();

    let metaDetails = user.emailAddress || user.name || '';
    if (serverInfo && serverInfo.version) {
      metaDetails += metaDetails ? ` • Jira v${serverInfo.version}` : `Jira v${serverInfo.version}`;
    }

    return [
      header(headerIcon(
        svg('path', { d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14' }),
        svg('polyline', { points: '22 4 12 14.01 9 11.01' })
      ), 'Connection Successful'),
      h('div', { class: 'status-body' },
        h('div', { class: 'user-card' },
          h('div', { class: 'user-avatar' }, initial),
          h('div', { class: 'user-details' },
            h('span', { class: 'user-name' }, user.displayName || 'Authenticated User'),
            h('span', { class: 'user-meta' }, metaDetails))),
        h('span', { class: 'status-timestamp' }, `Verified at: ${timeOf(payload)}`))
    ];
  }

  if (type === 'error') {
    return [
      header(headerIcon(
        svg('circle', { cx: '12', cy: '12', r: '10' }),
        svg('line', { x1: '12', y1: '8', x2: '12', y2: '12' }),
        svg('line', { x1: '12', y1: '16', x2: '12.01', y2: '16' })
      ), payload.title || 'Connection Failed'),
      h('div', { class: 'status-body' },
        h('p', {}, payload.error || 'Unable to connect to Jira.'),
        payload.serverMessage && h('p', { style: 'margin-top: 4px; font-size: 12px; opacity: 0.9;' },
          h('strong', {}, 'Server detail:'), ` ${payload.serverMessage}`),
        h('span', { class: 'status-timestamp' }, `Attempted at: ${timeOf(payload)}`))
    ];
  }

  return [
    header(headerIcon(
      svg('circle', { cx: '12', cy: '12', r: '10' }),
      svg('line', { x1: '12', y1: '16', x2: '12', y2: '12' }),
      svg('line', { x1: '12', y1: '8', x2: '12.01', y2: '8' })
    ), payload.title || 'Notification'),
    h('div', { class: 'status-body' }, payload.message || '')
  ];
}
