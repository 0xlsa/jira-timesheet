/**
 * Opening the timesheet from the browser: the toolbar icon, the icon's "Settings" menu item,
 * and the first install. An already open timesheet tab is brought forward instead of opening
 * another. Works with the WebExtensions API of Chrome, Edge, and Firefox (`ext` in
 * src/compat/browser-api.js), and needs no "tabs" permission.
 */

// Message the background sends to open timesheet pages; one answers with its tab and window.
export const SHOW_TIMESHEET = 'SHOW_TIMESHEET';

// The icon's context menu item.
export const SETTINGS_MENU_ID = 'connection-settings';

// The page opens the Connection Settings drawer when loaded with this hash (see options.js).
export const SETTINGS_HASH = '#settings';

/**
 * Brings an open timesheet tab forward, or opens one. With `settings`, the Connection Settings
 * drawer opens too.
 *
 * @param {object} api - The WebExtensions API (`ext`)
 * @param {object} [options]
 * @param {boolean} [options.settings=false]
 * @returns {Promise<void>}
 */
export async function openTimesheet(api, { settings = false } = {}) {
  let answer;
  try {
    answer = await api.runtime.sendMessage({ action: SHOW_TIMESHEET, settings });
  } catch {
    // No timesheet page is open to answer.
  }

  if (answer && answer.tabId !== undefined) {
    await api.tabs.update(answer.tabId, { active: true });
    if (answer.windowId !== undefined) await api.windows.update(answer.windowId, { focused: true });
    return;
  }

  await api.tabs.create({ url: api.runtime.getURL(`options.html${settings ? SETTINGS_HASH : ''}`) });
}

/**
 * Adds "Settings" to the toolbar icon's context menu, replacing any earlier copy (menus can
 * outlive the background script, and creating the same id twice fails).
 * @param {object} api
 * @returns {Promise<void>}
 */
export async function createSettingsMenu(api) {
  await api.contextMenus.removeAll();
  // Called without awaiting: create() returns the item's id rather than a promise.
  api.contextMenus.create({ id: SETTINGS_MENU_ID, title: 'Settings', contexts: ['action'] }, () => {
    // Read lastError so a failure is reported here rather than as an unchecked error.
    if (api.runtime.lastError) console.warn('Could not add the Settings menu item:', api.runtime.lastError.message);
  });
}

/**
 * Wires the toolbar icon, its Settings menu item, and the first install to openTimesheet().
 * @param {object} api
 */
export function setUpTimesheetLaunchers(api) {
  const report = (err) => console.error('Failed to open Timesheet for Jira:', err);

  api.action?.onClicked?.addListener(() => {
    openTimesheet(api).catch(report);
  });

  api.contextMenus?.onClicked?.addListener((info) => {
    if (info.menuItemId === SETTINGS_MENU_ID) openTimesheet(api, { settings: true }).catch(report);
  });

  // Note: details.reason is a string ('install', 'update', 'browser_update') in both browsers.
  api.runtime?.onInstalled?.addListener((details) => {
    createSettingsMenu(api).catch((err) => console.warn('Could not add the Settings menu item:', err));
    // Open the timesheet on the first install to guide the user through setup.
    if (details.reason === 'install') openTimesheet(api).catch(() => {});
  });
  api.runtime?.onStartup?.addListener(() => {
    createSettingsMenu(api).catch((err) => console.warn('Could not add the Settings menu item:', err));
  });
}
