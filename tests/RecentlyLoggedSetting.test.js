import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDocument } from './support/fakeDom.js';
import { renderWorkingIssues } from '../src/ui/weekView.js';
import { createSettingsStore, normalizeSettings } from '../src/settings/settingsStore.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';

const jira = { deploymentType: 'cloud', email: 'a@b.co', baseUrlsByType: { cloud: 'https://acme.atlassian.net', server: '' }, tokensByType: { cloud: 't', server: '' } };

describe('Show Recently Logged Issues - setting', () => {
  it('is off unless turned on, including for existing installations', () => {
    assert.equal(normalizeSettings({}).showRecentlyLoggedIssues, false);
    assert.equal(normalizeSettings({ jiraBaseUrl: 'https://acme.atlassian.net', token: 't' }).showRecentlyLoggedIssues, false);
    assert.equal(normalizeSettings({ showRecentlyLoggedIssues: 'yes' }).showRecentlyLoggedIssues, false);
    assert.equal(normalizeSettings({ showRecentlyLoggedIssues: true }).showRecentlyLoggedIssues, true);
  });

  it('is saved on its own and restored, keeping everything else', async () => {
    const storage = createMemoryStorageArea();
    const store = createSettingsStore(storage);
    await store.save({ ...jira, publicHolidays: { enabled: true, countryCode: 'IT', showNext: true } });
    await store.saveAssignmentFields('cloud|https://acme.atlassian.net', [{ id: 'customfield_10050', name: 'Reviewer' }]);
    const before = await store.load();
    assert.equal(before.showRecentlyLoggedIssues, false);

    await store.saveShowRecentlyLoggedIssues(true);
    const after = await store.load();
    assert.equal(after.showRecentlyLoggedIssues, true);
    assert.deepEqual({ ...after, showRecentlyLoggedIssues: false }, before, 'nothing else changed');

    // Save Settings doesn't touch it.
    await store.save(jira);
    assert.equal((await store.load()).showRecentlyLoggedIssues, true);

    await store.saveShowRecentlyLoggedIssues(false);
    assert.equal((await store.load()).showRecentlyLoggedIssues, false);
  });

  it('is independent of Additional Assignment Fields', async () => {
    const store = createSettingsStore(createMemoryStorageArea());
    const site = 'cloud|https://acme.atlassian.net';
    await store.saveAssignmentFields(site, [{ id: 'customfield_10050', name: 'Reviewer' }]);
    await store.saveShowRecentlyLoggedIssues(true);
    assert.deepEqual((await store.load()).assignmentFieldsBySite[site], [{ id: 'customfield_10050', name: 'Reviewer' }]);
    await store.saveAssignmentFields(site, []);
    assert.equal((await store.load()).showRecentlyLoggedIssues, true);
  });
});

describe('Show Recently Logged Issues - My Active Issues tab row', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  const ISSUES = [{ issueId: '1', issueKey: 'KAN-1', issueSummary: 'Fix it', issueStatus: { name: 'In Progress', categoryKey: 'indeterminate' }, inProgress: true }];

  function render({ checked = true, withSwitch = true, tab = 'active' } = {}) {
    const flips = [];
    const tabs = [];
    const section = document.createElement('section');
    const options = {
      state: { status: 'ready', issues: ISSUES, includeRecentlyLogged: checked },
      expanded: true,
      pending: { entries: [], site: 'cloud|https://acme.atlassian.net', tab, onTabChange: (t) => tabs.push(t), onEdit() {}, onDiscard() {} },
      ...(withSwitch && { recentlyLogged: { checked, onChange: (value) => flips.push(value) } })
    };
    renderWorkingIssues(section, options);
    const input = section.querySelector('#recentlyLoggedSwitch');
    const flip = (value) => {
      input.checked = value;
      input.dispatchEvent({ type: 'change' });
    };
    return { section, options, input, flip, flips, tabs };
  }

  it('sits at the right of the tabs, in their row, outside the tablist', () => {
    const { section, input } = render();
    const row = section.querySelector('.working-issues-tabbar');
    assert.deepEqual(row.children.map((child) => child.className), ['working-issues-tabs', 'switch-row working-issues-recent']);
    assert.equal(input.closest('[role="tablist"]'), null);
    assert.equal(input.getAttribute('role'), 'switch');
    assert.equal(row.querySelector('.working-issues-recent').textContent.startsWith('Show recently logged'), true);
  });

  it('puts its label on the left of the switch, and the checkbox just before the drawn switch', () => {
    const { section } = render();
    const group = section.querySelector('.working-issues-recent');
    assert.deepEqual(group.children.map((child) => child.className || child.localName),
      ['span', 'switch-input', 'switch', 'sr-only']);
    assert.equal(group.children[0].textContent, 'Show recently logged');
  });

  it('describes what it does, for the tooltip and assistive technology', () => {
    const { section, input } = render();
    const hint = "Also show issues where you've logged work in the last 14 days, even if they're not currently assigned to you.";
    assert.equal(section.querySelector('.working-issues-recent').getAttribute('title'), hint);
    assert.equal(input.getAttribute('aria-describedby'), 'recentlyLoggedHint');
    assert.equal(section.querySelector('#recentlyLoggedHint').textContent, hint);
  });

  it('shows the saved value', () => {
    assert.equal(render({ checked: true }).input.checked, true);
    assert.equal(render({ checked: false }).input.checked, false);
  });

  it('reports a flip, without changing tabs', () => {
    const view = render();
    view.flip(false);
    view.flip(true);
    assert.deepEqual(view.flips, [false, true]);
    assert.deepEqual(view.tabs, []);
    assert.equal(view.section.querySelector('[data-tab="active"]').getAttribute('aria-selected'), 'true');
  });

  it('is on the Pending tab too', () => {
    assert.ok(render({ tab: 'pending' }).input);
  });

  it('is left out without its options', () => {
    const { section, input } = render({ withSwitch: false });
    assert.equal(input, null);
    assert.deepEqual(section.querySelector('.working-issues-tabbar').children.map((child) => child.className), ['working-issues-tabs']);
  });

  it('keeps focus when the list loads again', () => {
    const view = render();
    view.input.focus();
    renderWorkingIssues(view.section, { ...view.options, state: { status: 'loading' } });
    assert.equal(document.activeElement, view.section.querySelector('#recentlyLoggedSwitch'));
    assert.notEqual(document.activeElement, view.input, 'a new switch, focused in its place');
  });
});

describe('Show Recently Logged Issues - page', () => {
  const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  const options = readFileSync(new URL('../options.js', import.meta.url), 'utf8');

  it('isn\'t in Settings, which keeps its sections in order with About last', () => {
    assert.doesNotMatch(html, /showRecentlyLoggedIssues|Issue Selection|Show Recently Logged Issues/);
    assert.match(html, /<h3 id="assignmentFieldsTitle" class="form-label">Additional Assignment Fields<\/h3>/);
    const at = (marker) => html.indexOf(marker);
    assert.ok(at('id="connectionSection"') < at('id="assignmentFieldsTitle"'));
    assert.ok(at('id="assignmentFieldsTitle"') < at('id="publicHolidaysEnabled"'));
    const about = at('id="aboutSection"');
    assert.ok(about > at('</form>'));
    assert.match(html.slice(about), /^id="aboutSection"[^>]*><\/section>\s*<\/div>\s*<\/div>\s*<\/aside>/);
  });

  it('gives My Active Issues the switch, with the saved value', () => {
    const start = options.indexOf('function workingIssuesOptions()');
    const fn = options.slice(start, options.indexOf('\n}\n', start));
    assert.match(fn, /recentlyLogged: \{ checked: savedSettings\?\.showRecentlyLoggedIssues === true, onChange: setShowRecentlyLoggedIssues \}/);
  });

  it('saves a flip on its own, then loads My Active Issues again', () => {
    const start = options.indexOf('async function setShowRecentlyLoggedIssues(show)');
    assert.ok(start > 0);
    const fn = options.slice(start, options.indexOf('\n}\n', start));
    assert.match(fn, /await settingsStore\.saveShowRecentlyLoggedIssues\(show\);\s*savedSettings = await settingsStore\.load\(\);/);
    assert.ok(fn.indexOf('refreshActiveIssues();') > fn.indexOf('savedSettings = await settingsStore.load();'));
  });

  it('loads My Active Issues with the saved value, every time', () => {
    const refreshes = [...options.matchAll(/workingIssues\.refresh\([^)]*\{([\s\S]*?)\}\);/g)].map((match) => match[1]);
    assert.equal(refreshes.length, 2);
    assert.match(refreshes[0], /includeRecentlyLogged: savedSettings\?\.showRecentlyLoggedIssues === true/);
    assert.match(refreshes[1], /includeRecentlyLogged: settings\.showRecentlyLoggedIssues/);
  });
});
