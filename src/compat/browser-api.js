/**
 * browser-api.js — Cross-browser extension API compatibility shim.
 *
 * Firefox exposes the WebExtensions API as `browser` (Promise-based).
 * Chrome exposes it as `chrome` (callback-based in older APIs, but Chrome MV3
 * also supports Promises for most APIs).
 *
 * Firefox also defines `chrome` as an alias for `browser`, so in practice
 * `chrome.storage`, `chrome.runtime`, etc. all work on both browsers.
 * We still prefer `globalThis.browser` when available because it is the
 * standards-track object and guarantees Promise returns without shimming.
 *
 * Usage:
 *   import { ext } from './src/compat/browser-api.js';
 *   await ext.storage.local.get([...]);
 */

/**
 * Unified browser extension API.
 * @type {typeof chrome}
 */
export const ext = (
  (typeof globalThis !== 'undefined' && globalThis.browser)
    ? globalThis.browser
    : (typeof globalThis !== 'undefined' && globalThis.chrome)
      ? globalThis.chrome
      : null
);

/**
 * Returns true when running inside a real browser extension context.
 * @returns {boolean}
 */
export function isExtensionContext() {
  return ext !== null && typeof ext.runtime !== 'undefined';
}
