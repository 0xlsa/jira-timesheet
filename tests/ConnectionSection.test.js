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
    const url = h('input', { id: 'jiraBaseUrl' });
    const token = h('input', { id: 'jiraToken', type: 'password' });
    const status = h('div', { id: 'statusArea', class: 'status-container status-success' }, 'Connected as Ada Lovelace');
    const testButton = h('button', { type: 'button', id: 'testConnectionBtn' }, 'Test Connection');
    const saveButton = h('button', { type: 'submit', id: 'saveSettingsBtn' }, 'Save Settings');
    const toggle = h('button', { type: 'button', 'aria-controls': 'connectionBody' }, 'Jira Connection');
    const body = h('div', { id: 'connectionBody' }, url, token, status, h('div', { class: 'form-actions' }, testButton, saveButton));
    const section = h('section', {}, h('h3', {}, toggle), body);
    // The edition selector and Public Holidays are siblings of the section, outside it.
    const edition = h('input', { type: 'radio', id: 'typeCloud' });
    const holidays = h('input', { type: 'checkbox', id: 'publicHolidaysEnabled' });
    h('form', {}, edition, section, holidays);
    url.value = 'https://example.atlassian.net';
    token.value = 'secret-token';
    return {
      section, toggle, body, url, token, status, testButton, saveButton, edition, holidays,
      connection: createConnectionSection({ section, toggle, body })
    };
  }

  /** Whether an element is shown: neither it nor anything it's in is `.hidden`. */
  const isVisible = (el) => !el.closest('.hidden');

  const isShown = ({ section, toggle, body }) => ({
    ariaExpanded: toggle.getAttribute('aria-expanded'),
    bodyHidden: body.classList.contains('hidden'),
    collapsedClass: section.classList.contains('is-collapsed')
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

  it('keeps the edition selector and Public Holidays shown while collapsed', () => {
    const view = setup();
    view.connection.setExpanded(false);
    assert.equal(isVisible(view.edition), true);
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

  it('leaves the edition selector before it, and Public Holidays and About after it', () => {
    assert.ok(!section.includes('name="deploymentType"'));
    const sectionStart = html.indexOf('id="connectionSection"');
    assert.ok(html.indexOf('id="typeCloud"') < sectionStart);
    assert.ok(html.indexOf('id="typeServer"') < sectionStart);
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

  it('still shows a new test result during the visit that ran it', () => {
    const onTest = fn('onTestConnection');
    assert.match(onTest, /renderStatus\('success', result\);/);
    assert.match(onTest, /settingsStore\.saveTestResult\(result\);/);
    assert.match(onTest, /renderStatus\('error', result\);/);
  });
});
