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

/**
 * In-memory stand-in for `storage.local`, used when the page runs outside an
 * extension (e.g. opened directly in a browser tab) and in tests.
 *
 * @param {object} [initial]
 * @returns {{ get: Function, set: Function, remove: Function }}
 */
export function createMemoryStorageArea(initial = {}) {
  const data = { ...initial };
  const toKeys = (keys) => (Array.isArray(keys) ? keys : [keys]);

  return {
    async get(keys) {
      const result = {};
      for (const key of toKeys(keys)) {
        if (key in data) result[key] = data[key];
      }
      return result;
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const key of toKeys(keys)) delete data[key];
    }
  };
}

/**
 * Platform services used by the UI. Chrome and Firefox expose the same
 * WebExtensions APIs for these, so there is one implementation; the only
 * branch is extension vs. plain web page.
 *
 * @param {object | null} [api] - Extension API object (`browser` / `chrome`)
 * @param {Window} [win] - Window used for the non-extension fallback
 * @returns {{ storage: object, openTab: (url: string) => void }}
 */
export function createPlatform(api = isExtensionContext() ? ext : null, win = globalThis) {
  const storage = api?.storage?.local ?? createMemoryStorageArea();

  return {
    storage,
    openTab(url) {
      if (api?.tabs?.create) {
        api.tabs.create({ url });
      } else {
        win.open(url, '_blank', 'noopener,noreferrer');
      }
    }
  };
}
