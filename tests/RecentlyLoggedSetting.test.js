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

describe('Show Recently Logged Issues - Active\'s switch in My Issues', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  const ISSUES = [{ issueId: '1', issueKey: 'KAN-1', issueSummary: 'Fix it', issueStatus: { name: 'In Progress', categoryKey: 'indeterminate' }, inProgress: true }];

  function render({ checked = true, withSwitch = true, groupsExpanded, views } = {}) {
    const flips = [];
    const groups = [];
    const section = document.createElement('section');
    const options = {
      state: { status: 'ready', issues: ISSUES, includeRecentlyLogged: checked },
      expanded: true,
      pending: { entries: [], site: 'cloud|https://acme.atlassian.net', onEdit() {}, onDiscard() {} },
      groupsExpanded,
      onGroupToggle: (group, expanded) => groups.push([group, expanded]),
      ...(withSwitch && { recentlyLogged: { checked, onChange: (value) => flips.push(value) } }),
      views
    };
    renderWorkingIssues(section, options);
    const input = section.querySelector('#recentlyLoggedSwitch');
    const flip = (value) => {
      input.checked = value;
      input.dispatchEvent({ type: 'change' });
    };
    return { section, options, input, flip, flips, groups };
  }

  const headerOf = (section, id) => section.querySelector(`.working-issues-group[data-group="${id}"]`).querySelector('.working-issues-group-header');

  /** renderWorkingIssues()'s `views`: Active and one custom view, `selectedId` selected. */
  const viewsWith = (selectedId) => ({
    items: [{ id: 'reported', name: 'Reported', description: 'Reporter is Me', unavailable: false, result: { status: 'ready', issues: [], total: 0, hasMore: false, message: '' } }],
    selectedId, canCreate: true, onSelect() {}, onCreate() {}, onEdit() {}, onRefresh() {}
  });

  it('is out of the My Issues header: on its own line above the issues, outside every button', () => {
    const { section, input } = render();
    assert.deepEqual(headerOf(section, 'active').children.map((child) => child.className), ['working-issues-group-heading']);
    const body = section.querySelector('#workingIssuesGroup-active');
    assert.equal(body.children[0].className, 'working-issues-recent-row');
    assert.equal(body.children[0].children[0].className, 'switch-row working-issues-recent');
    assert.equal(body.children[1].className, 'working-issues-list');
    assert.equal(input.closest('button'), null);
    assert.equal(input.getAttribute('role'), 'switch');
  });

  it('sits directly below the view tabs while Active is selected, in Active\'s panel', () => {
    const { section, input } = render({ views: viewsWith('all') });
    const body = section.querySelector('#workingIssuesGroup-active');
    assert.equal(body.children[0].className, 'working-issues-viewbar');
    const panel = section.querySelector('#workingIssuesViewPanel');
    assert.equal(panel.getAttribute('aria-labelledby'), 'workingIssuesViewTab-all');
    assert.equal(panel.children[0], input.closest('.working-issues-recent-row'));
  });

  it('is hidden while a custom view is selected, and back with Active, as saved', () => {
    assert.equal(render({ views: viewsWith('reported') }).section.querySelector('.working-issues-recent'), null);
    assert.equal(render({ views: viewsWith('all'), checked: false }).input.checked, false);
    assert.equal(render({ views: viewsWith('all'), checked: true }).input.checked, true);
  });

  it('is in My Issues only, never Pending Worklogs', () => {
    const { section } = render();
    assert.deepEqual(headerOf(section, 'pending').children.map((child) => child.className), ['working-issues-group-heading']);
    assert.equal(section.querySelector('.working-issues-group.is-pending').querySelector('.working-issues-recent'), null);
    assert.equal(section.querySelectorAll('.working-issues-recent').length, 1);
  });

  it('is hidden with the issues while My Issues is collapsed', () => {
    const { section, input } = render({ groupsExpanded: { active: false, pending: false } });
    assert.ok(section.querySelector('.working-issues-group.is-active').classList.contains('is-collapsed'));
    assert.ok(input.closest('.working-issues-group-body').classList.contains('hidden'));
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

  it('reports a flip, without expanding or collapsing a group', () => {
    const view = render();
    view.flip(false);
    view.flip(true);
    assert.deepEqual(view.flips, [false, true]);
    assert.deepEqual(view.groups, []);
  });

  it('doesn\'t toggle the My Issues group when its label is clicked', () => {
    const view = render();
    view.section.querySelector('.working-issues-recent').querySelector('span').click();
    view.input.click();
    assert.deepEqual(view.groups, []);
    assert.equal(view.section.querySelector('#workingIssuesGroupToggle-active').getAttribute('aria-expanded'), 'true');
  });

  it('is left out without its options', () => {
    const { section, input } = render({ withSwitch: false });
    assert.equal(input, null);
    assert.deepEqual(headerOf(section, 'active').children.map((child) => child.className), ['working-issues-group-heading']);
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

  it('gives My Work the switch, with the saved value', () => {
    const start = options.indexOf('function workingIssuesOptions()');
    const fn = options.slice(start, options.indexOf('\n}\n', start));
    assert.match(fn, /recentlyLogged: \{ checked: savedSettings\?\.showRecentlyLoggedIssues === true, onChange: setShowRecentlyLoggedIssues \}/);
  });

  it('saves a flip on its own, then loads My Work again, keeping the issues shown meanwhile', () => {
    const start = options.indexOf('async function setShowRecentlyLoggedIssues(show)');
    assert.ok(start > 0);
    const fn = options.slice(start, options.indexOf('\n}\n', start));
    assert.match(fn, /await settingsStore\.saveShowRecentlyLoggedIssues\(show\);\s*savedSettings = await settingsStore\.load\(\);/);
    assert.ok(fn.indexOf('refreshActiveIssues({ keepShown: true });') > fn.indexOf('savedSettings = await settingsStore.load();'));
  });

  it('loads only for the last of quick flips', () => {
    const start = options.indexOf('async function setShowRecentlyLoggedIssues(show)');
    const fn = options.slice(start, options.indexOf('\n}\n', start));
    assert.match(fn, /const flip = \+\+recentlyLoggedFlips;/);
    assert.match(fn, /if \(flip !== recentlyLoggedFlips\) return;\s*refreshActiveIssues\(\{ keepShown: true \}\);/);
  });

  it('says in a toast when the issues couldn\'t be updated, keeping the ones shown', () => {
    assert.match(options, /if \(state\?\.refreshError\) \{\s*showToast\(`Couldn't update your issues, so the ones shown are from before\. \$\{state\.refreshError\}`, \{ durationMs: 8000 \}\);/);
    assert.match(options, /const \{ refreshError, \.\.\.shown \} = state;\s*state = shown;\s*\}\s*setWorkingIssuesState\(state\);/);
  });

  it('keeps the issues shown only for the switch: Retry, settings, and worklog changes load as before', () => {
    const calls = [...options.matchAll(/refreshActiveIssues\((\{[^}]*\})?\)/g)].map((match) => match[1] ?? '');
    assert.deepEqual(calls.filter((arg) => arg.includes('keepShown')), ['{ keepShown: true }']);
  });

  it('loads My Work with the saved value, every time', () => {
    const refreshes = [...options.matchAll(/workingIssues\.refresh\([^)]*\{([\s\S]*?)\}\);/g)].map((match) => match[1]);
    assert.equal(refreshes.length, 2);
    assert.match(refreshes[0], /includeRecentlyLogged: savedSettings\?\.showRecentlyLoggedIssues === true/);
    assert.match(refreshes[1], /includeRecentlyLogged: settings\.showRecentlyLoggedIssues/);
  });
});
