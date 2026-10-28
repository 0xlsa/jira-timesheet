import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openTimesheet, createSettingsMenu, setUpTimesheetLaunchers, SHOW_TIMESHEET, SETTINGS_MENU_ID, SETTINGS_HASH } from '../src/background/launch.js';

/**
 * A fake WebExtensions API recording calls. `openPage` is the open timesheet tab's answer to
 * SHOW_TIMESHEET (undefined: no page open, so sendMessage rejects as in both browsers).
 */
function fakeApi({ openPage } = {}) {
  const calls = [];
  const listeners = {};
  const event = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const menus = [];
  return {
    calls,
    listeners,
    menus,
    runtime: {
      lastError: undefined,
      getURL: (path) => `chrome-extension://abc/${path}`,
      sendMessage: async (message) => {
        calls.push(['sendMessage', message]);
        if (!openPage) throw new Error('Could not establish connection. Receiving end does not exist.');
        return openPage;
      },
      onInstalled: event('onInstalled'),
      onStartup: event('onStartup')
    },
    tabs: {
      create: async (props) => { calls.push(['tabs.create', props]); },
      update: async (id, props) => { calls.push(['tabs.update', id, props]); }
    },
    windows: { update: async (id, props) => { calls.push(['windows.update', id, props]); } },
    action: { onClicked: event('action.onClicked') },
    contextMenus: {
      removeAll: async () => { calls.push(['contextMenus.removeAll']); menus.length = 0; },
      create: (props, callback) => {
        calls.push(['contextMenus.create', props]);
        if (menus.some((m) => m.id === props.id)) throw new Error('duplicate id');
        menus.push(props);
        callback?.();
        return props.id;
      },
      onClicked: event('contextMenus.onClicked')
    }
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('Background - opening the timesheet', () => {
  it('opens a new timesheet tab when none is open', async () => {
    const api = fakeApi();
    await openTimesheet(api);
    assert.deepEqual(api.calls, [
      ['sendMessage', { action: SHOW_TIMESHEET, settings: false }],
      ['tabs.create', { url: 'chrome-extension://abc/options.html' }]
    ]);
  });

  it('opens it with Connection Settings when asked', async () => {
    const api = fakeApi();
    await openTimesheet(api, { settings: true });
    assert.deepEqual(api.calls.at(-1), ['tabs.create', { url: `chrome-extension://abc/options.html${SETTINGS_HASH}` }]);
    assert.equal(SETTINGS_HASH, '#settings');
  });

  it('brings an open timesheet tab forward instead of opening another', async () => {
    const api = fakeApi({ openPage: { tabId: 7, windowId: 3 } });
    await openTimesheet(api, { settings: true });
    assert.deepEqual(api.calls, [
      ['sendMessage', { action: SHOW_TIMESHEET, settings: true }],
      ['tabs.update', 7, { active: true }],
      ['windows.update', 3, { focused: true }]
    ]);
  });

  it('opens a new tab when an open page could not say which tab it is', async () => {
    const api = fakeApi({ openPage: {} });
    await openTimesheet(api);
    assert.equal(api.calls.at(-1)[0], 'tabs.create');
  });
});

describe('Background - the toolbar icon and its Settings menu item', () => {
  it('adds "Settings" to the icon\'s menu, once, however often it is set up', async () => {
    const api = fakeApi();
    await createSettingsMenu(api);
    await createSettingsMenu(api);
    assert.deepEqual(api.menus, [{ id: SETTINGS_MENU_ID, title: 'Settings', contexts: ['action'] }]);
  });

  it('creates the menu item on install and on browser start, and opens the timesheet on first install only', async () => {
    const install = fakeApi();
    setUpTimesheetLaunchers(install);
    install.listeners.onInstalled({ reason: 'install' });
    await flush();
    assert.equal(install.menus.length, 1);
    assert.ok(install.calls.some(([name, props]) => name === 'tabs.create' && props.url.endsWith('options.html')));

    const update = fakeApi();
    setUpTimesheetLaunchers(update);
    update.listeners.onInstalled({ reason: 'update' });
    await flush();
    assert.equal(update.menus.length, 1);
    assert.ok(!update.calls.some(([name]) => name === 'tabs.create' || name === 'sendMessage'), 'an update opens nothing');

    const startup = fakeApi();
    setUpTimesheetLaunchers(startup);
    startup.listeners.onStartup();
    await flush();
    assert.equal(startup.menus.length, 1);
  });

  it('opens the timesheet from the icon, and Settings from the menu item', async () => {
    const api = fakeApi();
    setUpTimesheetLaunchers(api);

    api.listeners['action.onClicked']();
    await flush();
    assert.deepEqual(api.calls.slice(-2), [
      ['sendMessage', { action: SHOW_TIMESHEET, settings: false }],
      ['tabs.create', { url: 'chrome-extension://abc/options.html' }]
    ]);

    api.listeners['contextMenus.onClicked']({ menuItemId: SETTINGS_MENU_ID });
    await flush();
    assert.deepEqual(api.calls.slice(-2), [
      ['sendMessage', { action: SHOW_TIMESHEET, settings: true }],
      ['tabs.create', { url: 'chrome-extension://abc/options.html#settings' }]
    ]);

    const before = api.calls.length;
    api.listeners['contextMenus.onClicked']({ menuItemId: 'someone-else' });
    await flush();
    assert.equal(api.calls.length, before, 'other menu items are ignored');
  });
});

describe('Manifest - Settings instead of the browser\'s Options entry', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

  it('has no options page (which would add the browser\'s own "Options" entry) and may add menu items', () => {
    assert.equal('options_ui' in manifest, false);
    assert.equal('options_page' in manifest, false);
    assert.ok(manifest.permissions.includes('contextMenus'));
    assert.ok(manifest.permissions.includes('storage'));
    assert.ok(manifest.action, 'the toolbar icon opens the timesheet itself (no popup)');
    assert.equal(manifest.action.default_popup, undefined);
  });
});
