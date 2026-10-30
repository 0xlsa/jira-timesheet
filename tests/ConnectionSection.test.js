import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import { createConnectionSection, shouldCollapseConnection } from '../src/ui/connectionSection.js';
import { createSettingsStore, normalizeSettings } from '../src/settings/settingsStore.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';

const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');

/** The markup between an element's opening tag and the closing tag that matches it. */
function elementHtml(id, tag) {
  const start = html.lastIndexOf(`<${tag}`, html.indexOf(`id="${id}"`));
  const pattern = new RegExp(`<${tag}[\\s>]|</${tag}>`, 'g');
  pattern.lastIndex = start;
  let depth = 0;
  for (let match; (match = pattern.exec(html));) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, pattern.lastIndex);
  }
  throw new Error(`No closing </${tag}> for #${id}`);
}

describe('Jira Connection section', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  function setup() {
    const edition = h('input', { type: 'radio', id: 'typeCloud' });
    const url = h('input', { id: 'jiraBaseUrl' });
    const token = h('input', { id: 'jiraToken', type: 'password' });
    const status = h('div', { id: 'statusArea', class: 'status-container status-success' }, 'Connected as Ada Lovelace');
    const testButton = h('button', { type: 'button', id: 'testConnectionBtn' }, 'Test Connection');
    const saveButton = h('button', { type: 'submit', id: 'saveSettingsBtn' }, 'Save Settings');
    const title = h('span', { id: 'connectionTitle' }, 'Jira Connection');
    const setupHint = h('span', { id: 'connectionSetupHint', class: 'hidden' }, 'Connect your Jira instance to get started.');
    const toggle = h('button', { type: 'button', 'aria-controls': 'connectionBody' }, title, setupHint);
    const body = h('div', { id: 'connectionBody' }, edition, url, token, status, h('div', { class: 'form-actions' }, testButton, saveButton));
    const section = h('section', {}, h('h3', {}, toggle), body);
    // Public Holidays is a sibling of the section, outside it.
    const holidays = h('input', { type: 'checkbox', id: 'publicHolidaysEnabled' });
    h('form', {}, section, holidays);
    url.value = 'https://example.atlassian.net';
    token.value = 'secret-token';
    return {
      section, toggle, body, url, token, status, testButton, saveButton, edition, holidays, title, setupHint,
      connection: createConnectionSection({ section, toggle, body, title, setupHint })
    };
  }

  /** Whether an element is shown: neither it nor anything it's in is `.hidden`. */
  const isVisible = (el) => !el.closest('.hidden');

  const isShown = ({ section, toggle, body }) => ({
    ariaExpanded: toggle.getAttribute('aria-expanded'),
    bodyHidden: body.classList.contains('hidden'),
    collapsedClass: section.classList.contains('is-collapsed')
  });

  const header = ({ section, title, setupHint }) => ({
    title: title.textContent,
    hint: isVisible(setupHint),
    needsSetup: section.classList.contains('needs-setup')
  });

  it('shows a setup prompt while not configured', () => {
    const view = setup();
    view.connection.setConfigured(false);
    assert.deepEqual(header(view), { title: 'Configure Jira Connection', hint: true, needsSetup: true });
    assert.equal(view.setupHint.textContent, 'Connect your Jira instance to get started.');
  });

  it('shows just "Jira Connection" once configured', () => {
    const view = setup();
    view.connection.setConfigured(false);
    view.connection.setConfigured(true);
    assert.deepEqual(header(view), { title: 'Jira Connection', hint: false, needsSetup: false });
  });

  it('keeps the header the same while expanding and collapsing', () => {
    for (const configured of [false, true]) {
      const view = setup();
      view.connection.setConfigured(configured);
      const before = header(view);
      view.toggle.click();
      assert.deepEqual(header(view), before);
      view.toggle.click();
      assert.deepEqual(header(view), before);
    }
  });

  it('expands and collapses from the header in either state', () => {
    for (const configured of [false, true]) {
      const view = setup();
      view.connection.setConfigured(configured);
      view.toggle.click();
      assert.equal(view.connection.isExpanded(), false);
      view.toggle.click();
      assert.equal(view.connection.isExpanded(), true);
    }
  });

  it('starts expanded', () => {
    const view = setup();
    assert.equal(view.connection.isExpanded(), true);
    assert.deepEqual(isShown(view), { ariaExpanded: 'true', bodyHidden: false, collapsedClass: false });
  });

  it('collapses and expands when the header is clicked', () => {
    const view = setup();
    view.toggle.click();
    assert.equal(view.connection.isExpanded(), false);
    assert.deepEqual(isShown(view), { ariaExpanded: 'false', bodyHidden: true, collapsedClass: true });
    view.toggle.click();
    assert.equal(view.connection.isExpanded(), true);
    assert.deepEqual(isShown(view), { ariaExpanded: 'true', bodyHidden: false, collapsedClass: false });
  });

  it('hides the connection status, Test Connection, and Save Settings while collapsed', () => {
    const view = setup();
    const contents = [view.url, view.token, view.status, view.testButton, view.saveButton];
    assert.deepEqual(contents.map(isVisible), [true, true, true, true, true]);
    view.connection.setExpanded(false);
    assert.deepEqual(contents.map(isVisible), [false, false, false, false, false]);
    view.toggle.click();
    assert.deepEqual(contents.map(isVisible), [true, true, true, true, true]);
  });

  it('hides the edition selector with the rest of the connection settings while collapsed', () => {
    const view = setup();
    assert.equal(isVisible(view.edition), true);
    view.connection.setExpanded(false);
    assert.equal(isVisible(view.edition), false);
    view.toggle.click();
    assert.equal(isVisible(view.edition), true);
  });

  it('keeps Public Holidays shown while collapsed', () => {
    const view = setup();
    view.connection.setExpanded(false);
    assert.equal(isVisible(view.holidays), true);
  });

  it('keeps the connection status and the buttons as they were across collapsing', () => {
    const view = setup();
    view.testButton.disabled = true;
    view.connection.setExpanded(false);
    view.connection.setExpanded(true);
    assert.equal(view.status.className, 'status-container status-success');
    assert.equal(view.status.textContent, 'Connected as Ada Lovelace');
    assert.equal(view.testButton.disabled, true);
  });

  it('can be set expanded or collapsed directly', () => {
    const view = setup();
    view.connection.setExpanded(false);
    assert.deepEqual(isShown(view), { ariaExpanded: 'false', bodyHidden: true, collapsedClass: true });
    view.connection.setExpanded(false);
    assert.equal(view.connection.isExpanded(), false);
    view.connection.setExpanded(true);
    assert.deepEqual(isShown(view), { ariaExpanded: 'true', bodyHidden: false, collapsedClass: false });
  });

  it('keeps the entered URL and token while collapsed and after expanding again', () => {
    const view = setup();
    view.toggle.click();
    assert.equal(view.url.value, 'https://example.atlassian.net');
    assert.equal(view.token.value, 'secret-token');
    assert.equal(view.token.type, 'password');
    view.toggle.click();
    assert.equal(view.url.value, 'https://example.atlassian.net');
    assert.equal(view.token.value, 'secret-token');
  });

  it('leaves saved credentials in storage untouched when toggled', async () => {
    const storage = createMemoryStorageArea();
    const store = createSettingsStore(storage);
    await store.save({
      deploymentType: 'server',
      email: '',
      baseUrlsByType: { cloud: '', server: 'https://jira.example.com' },
      tokensByType: { cloud: '', server: 'pat-token' }
    });
    const before = await storage.get(null);
    const view = setup();
    view.toggle.click();
    view.toggle.click();
    view.connection.setExpanded(false);
    assert.deepEqual(await storage.get(null), before);
  });
});

describe('Jira Connection section - default state', () => {
  it('is expanded when nothing is saved yet', () => {
    assert.equal(shouldCollapseConnection(null), false);
    assert.equal(shouldCollapseConnection(normalizeSettings({})), false);
  });

  it('is expanded when a required detail is missing', () => {
    assert.equal(shouldCollapseConnection(normalizeSettings({
      deploymentType: 'cloud', jiraBaseUrl: 'https://example.atlassian.net', token: 'token'
    })), false, 'Cloud without an email');
    assert.equal(shouldCollapseConnection(normalizeSettings({
      deploymentType: 'server', jiraBaseUrl: 'https://jira.example.com'
    })), false, 'Data Center / Server without a token');
    assert.equal(shouldCollapseConnection(normalizeSettings({
      deploymentType: 'server', token: 'pat-token'
    })), false, 'Data Center / Server without a URL');
  });

  it('is collapsed when every required detail is saved', () => {
    assert.equal(shouldCollapseConnection(normalizeSettings({
      deploymentType: 'cloud', jiraBaseUrl: 'https://example.atlassian.net', token: 'token', email: 'me@example.com'
    })), true);
    assert.equal(shouldCollapseConnection(normalizeSettings({
      deploymentType: 'server', jiraBaseUrl: 'https://jira.example.com', token: 'pat-token'
    })), true);
  });
});

describe('Jira Connection section - markup', () => {
  const section = elementHtml('connectionSection', 'section');
  const body = elementHtml('connectionBody', 'div');

  it('has a native header button that controls the body', () => {
    const button = section.match(/<button[^>]*id="connectionToggle"[^>]*>/)[0];
    assert.match(button, /type="button"/);
    assert.match(button, /aria-expanded="true"/);
    assert.match(button, /aria-controls="connectionBody"/);
    assert.match(section, /<h3 class="connection-heading">\s*<button/);
    assert.match(section, /class="connection-chevron"[^>]*aria-hidden="true"/);
  });

  it('heads it with a link icon, the title and its setup help, and the chevron on the right', () => {
    const button = section.slice(section.indexOf('id="connectionToggle"'), section.indexOf('</button>'));
    const order = ['class="connection-icon"', 'id="connectionTitle"', 'id="connectionSetupHint"', 'class="connection-chevron"']
      .map((marker) => button.indexOf(marker));
    assert.ok(order.every((index) => index > 0), String(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(button, /class="connection-icon"[^>]*aria-hidden="true"/);
    // The same link icon as the Jira Instance URL label.
    const link = 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71';
    assert.ok(button.includes(link));
    assert.ok(html.indexOf(link, html.indexOf('</button>', html.indexOf('id="connectionToggle"'))) > 0);
    assert.match(button, /id="connectionSetupHint" class="connection-setup-hint hidden">Connect your Jira instance to get started\.</);
  });

  it('holds the URL, email, token, their help, the security notice, the status, and the buttons', () => {
    for (const id of ['jiraBaseUrl', 'urlHint', 'cloudEmailGroup', 'jiraToken', 'tokenHelpText', 'tokenError',
      'statusArea', 'testConnectionBtn', 'saveSettingsBtn']) {
      assert.ok(body.includes(`id="${id}"`), id);
    }
    // Moved, not copied: each appears once on the page.
    for (const id of ['statusArea', 'testConnectionBtn', 'saveSettingsBtn']) {
      assert.equal(html.split(`id="${id}"`).length, 2, id);
    }
    // Still the form's buttons: Test Connection runs the test, Save Settings submits the form.
    assert.match(body, /<button type="button" id="testConnectionBtn"/);
    assert.match(body, /<button type="submit" id="saveSettingsBtn"/);
    const form = elementHtml('settingsForm', 'form');
    assert.ok(form.includes(body));
    assert.match(body, /class="security-banner"/);
    assert.match(body, /Your Jira credentials are stored locally in your browser\./);
  });

  it('titles the drawer Settings', () => {
    assert.match(html, /<h2 id="settingsTitle" class="settings-drawer-title">Settings<\/h2>/);
    assert.match(html, /<aside id="settingsDrawer"[^>]*aria-labelledby="settingsTitle"/);
    assert.match(html, /id="settingsBtn"[^>]*aria-label="Settings"[^>]*data-tooltip="Settings"/s);
  });

  it('holds the edition selector first in the body, above the instance URL, with no selector outside it', () => {
    const fieldset = elementHtml('typeCloud', 'fieldset');
    assert.match(fieldset, /<legend class="form-label">Jira Edition<\/legend>/);
    assert.ok(fieldset.includes('id="typeServer"'));
    assert.match(body, /^<div id="connectionBody" class="connection-body">\s*<!-- Jira Edition Selector -->\s*<fieldset class="form-group deployment-group">/);
    assert.ok(body.indexOf(fieldset) < body.indexOf('id="jiraBaseUrl"'));
    // Moved, not copied: one edition selector on the page, and no nested collapsible.
    assert.equal(html.split('name="deploymentType"').length, 3);
    assert.equal(section.split('aria-expanded=').length, 2);
  });

  it('has Public Holidays and About after it', () => {
    const sectionEnd = html.indexOf(section) + section.length;
    assert.ok(html.indexOf('id="publicHolidaysEnabled"') > sectionEnd);
    // About is still the last section of Settings.
    const about = html.indexOf('id="aboutSection"');
    assert.ok(about > html.indexOf('</form>'));
    assert.equal(html.slice(about).match(/<\/section>\s*<\/div>\s*<\/div>\s*<\/aside>/)?.index > 0, true);
  });
});

describe('Connection status - options page wiring', () => {
  const options = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
  /** A top-level function's source, up to the next top-level declaration. */
  const fn = (name) => {
    const start = options.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    const next = options.slice(start + 1).search(/\n(?:async )?function |\n\/\*\*|\n\/\/ =+/);
    return options.slice(start, start + 1 + next);
  };

  it('hides the connection status card when the drawer closes', () => {
    assert.match(fn('closeSettings'), /hideConnectionStatus\(\);/);
    assert.match(fn('hideConnectionStatus'), /statusArea\.className = 'status-container hidden';/);
    assert.match(fn('hideConnectionStatus'), /statusArea\.replaceChildren\(\);/);
  });

  it("doesn't show the saved test result again when the drawer opens", () => {
    const fill = fn('fillSettingsForm');
    assert.match(fill, /invalidateConnectionStatus\(\);/);
    assert.doesNotMatch(fill, /renderStatus|lastTestResult/);
  });

  it('keeps the saved test result: hiding the card neither clears nor saves it', () => {
    for (const name of ['closeSettings', 'hideConnectionStatus', 'fillSettingsForm']) {
      assert.doesNotMatch(fn(name), /clearTestResult|saveTestResult|settingsStore/, name);
    }
  });

  it('collapses Jira Connection after a successful save, keeping the drawer open and the form as entered', () => {
    const save = fn('onSaveSettings');
    const [success, failure] = save.split('} catch (err) {');
    const collapse = success.indexOf('connectionSection.setExpanded(false);');
    assert.ok(collapse > success.indexOf('await settingsStore.save('), 'only once saved');
    assert.ok(collapse > success.lastIndexOf('await '), 'after the last step that can fail');
    assert.ok(success.indexOf('connectionToggle.focus();') > collapse, 'focus moves to the header');
    assert.doesNotMatch(success, /closeSettings\(|fillSettingsForm\(|\.value = ''|\.reset\(/);
    assert.match(failure, /connectionSection\.setExpanded\(true\);/);
    assert.doesNotMatch(failure, /setExpanded\(false\)/);
  });

  it('shows the setup prompt from the saved settings, when Settings opens and after a successful save', () => {
    const open = fn('openSettings');
    assert.match(open, /const isConnectionCollapsed = shouldCollapseConnection\(savedSettings\);\s*connectionSection\.setConfigured\(isConnectionCollapsed\);\s*connectionSection\.setExpanded\(!isConnectionCollapsed\);/);
    const [success, failure] = fn('onSaveSettings').split('} catch (err) {');
    const configured = success.indexOf('connectionSection.setConfigured(shouldCollapseConnection(savedSettings));');
    assert.ok(configured > success.indexOf('savedSettings = await settingsStore.load()'), 'from the newly saved settings');
    assert.ok(configured < success.indexOf('connectionSection.setExpanded(false);'));
    assert.doesNotMatch(failure, /setConfigured/);
    // Saved isn't tested: neither the test nor its result changes the header.
    assert.doesNotMatch(fn('onTestConnection'), /setConfigured/);
  });

  it("doesn't collapse Jira Connection when the connection is tested", () => {
    assert.doesNotMatch(fn('onTestConnection'), /setExpanded\(false\)/);
  });

  it('still shows a new test result during the visit that ran it', () => {
    const onTest = fn('onTestConnection');
    assert.match(onTest, /renderStatus\('success', result\);/);
    assert.match(onTest, /settingsStore\.saveTestResult\(result\);/);
    assert.match(onTest, /renderStatus\('error', result\);/);
  });
});
