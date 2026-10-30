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
 * Like `storage.local`, it has an `onChanged` event whose listeners get the changed keys as
 * `{ [key]: { oldValue, newValue } }` after each `set()` and `remove()`.
 *
 * @param {object} [initial]
 * @returns {{ get: Function, set: Function, remove: Function, onChanged: { addListener: Function, removeListener: Function } }}
 */
export function createMemoryStorageArea(initial = {}) {
  const data = { ...initial };
  const listeners = new Set();
  const toKeys = (keys) => (Array.isArray(keys) ? keys : [keys]);

  // Listeners run after the change, as the browser's do.
  function notify(changes) {
    if (Object.keys(changes).length === 0) return;
    for (const listener of [...listeners]) queueMicrotask(() => listener(changes));
  }

  return {
    async get(keys) {
      const result = {};
      for (const key of toKeys(keys)) {
        if (key in data) result[key] = data[key];
      }
      return result;
    },
    async set(items) {
      const changes = {};
      for (const [key, newValue] of Object.entries(items)) {
        changes[key] = key in data ? { oldValue: data[key], newValue } : { newValue };
      }
      Object.assign(data, items);
      notify(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const key of toKeys(keys)) {
        if (key in data) changes[key] = { oldValue: data[key] };
        delete data[key];
      }
      notify(changes);
    },
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener)
    }
  };
}

/**
 * Matches a host permission for one HTTPS host, the only kind `hostAccess.request`
 * asks for. Broader grants the user made in the browser (e.g. `https://*\/*`) never match.
 */
const SINGLE_HOST_PATTERN = /^https:\/\/[^*/]+\/\*$/;

/**
 * Access to Jira sites through optional host permissions (`optional_host_permissions`
 * in manifest.json). Outside an extension there is no permissions API, and every
 * check passes.
 *
 * @param {object | undefined} permissions - `browser.permissions` / `chrome.permissions`
 */
function createHostAccess(permissions) {
  if (!permissions) {
    return {
      async has() { return true; },
      async request() { return true; },
      async removeExcept() {}
    };
  }

  return {
    /**
     * @param {string} originPattern - e.g. `https://jira.example.com/*`
     * @returns {Promise<boolean>}
     */
    async has(originPattern) {
      return permissions.contains({ origins: [originPattern] });
    },

    /**
     * Asks the user for access to one site. Call it synchronously from a click or submit
     * handler: browsers only prompt during a user action, and Firefox no longer counts it
     * as one after an `await`. Resolves to true without prompting when already granted.
     * (The body runs synchronously up to its first `await`, so being `async` keeps the
     * user action and turns a thrown error into a rejection.)
     *
     * @param {string} originPattern
     * @returns {Promise<boolean>}
     */
    async request(originPattern) {
      return permissions.request({ origins: [originPattern] });
    },

    /**
     * Revokes single-site access this extension requested earlier for sites that are no
     * longer configured.
     *
     * @param {string[]} keepPatterns - Origin patterns still in use
     */
    async removeExcept(keepPatterns) {
      const { origins = [] } = await permissions.getAll();
      const unused = origins.filter((origin) => SINGLE_HOST_PATTERN.test(origin) && !keepPatterns.includes(origin));
      if (unused.length) await permissions.remove({ origins: unused });
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
 * @returns {{ storage: object, watchStorage: Function, hostAccess: object, openTab: (url: string) => void }}
 */
export function createPlatform(api = isExtensionContext() ? ext : null, win = globalThis) {
  const storage = api?.storage?.local ?? createMemoryStorageArea();

  return {
    storage,

    /**
     * Calls `listener` with the changed keys (`{ [key]: { oldValue, newValue } }`) whenever
     * `storage` changes, in this page or any other page of the extension. Uses `storage.onChanged`,
     * which Chrome and Firefox both fire for every area, keeping only `local` changes.
     *
     * @param {(changes: object) => void} listener
     * @returns {() => void} Stops listening
     */
    watchStorage(listener) {
      const events = api?.storage ? api.storage.onChanged : storage.onChanged;
      if (!events) return () => {};
      // The in-memory area's event has no area name.
      const handler = (changes, areaName = 'local') => {
        if (areaName === 'local') listener(changes);
      };
      events.addListener(handler);
      return () => events.removeListener(handler);
    },

    hostAccess: createHostAccess(api?.permissions),
    openTab(url) {
      if (api?.tabs?.create) {
        api.tabs.create({ url });
      } else {
        win.open(url, '_blank', 'noopener,noreferrer');
      }
    }
  };
}
