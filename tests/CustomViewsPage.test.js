import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../options.html');
const js = read('../options.js');

/** The source of a function in options.js, from its declaration to the next top-level declaration. */
function functionSource(name) {
  const start = js.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const rest = js.slice(start + 1);
  const end = rest.search(/\n(?:async )?function |\n(?:const|let) |\n\/\/ =====|\nplatform\./);
  return js.slice(start, end < 0 ? undefined : start + 1 + end);
}

describe('Custom views page wiring', () => {
  it('has the editor drawer beside the other drawers', () => {
    assert.match(html, /<aside id="customViewEditor" class="custom-view-editor hidden" role="dialog" aria-modal="false"><\/aside>/);
  });

  it('remembers the selected view in localStorage, and shows Active by default', () => {
    assert.match(js, /let selectedViewId = localStorage\.getItem\('jts-working-issues-view'\) \|\| ALL_VIEW_ID;/);
    assert.match(functionSource('selectView'), /localStorage\.setItem\('jts-working-issues-view', id\);/);
    assert.match(functionSource('customViewsOptions'), /const selectedId = views\.some\(\(view\) => view\.id === selectedViewId\) \? selectedViewId : ALL_VIEW_ID;/);
  });

  it('has no Views group: My Issues and Pending Worklogs only', () => {
    assert.doesNotMatch(js, /jts-working-issues-views-expanded|workingIssuesGroupsExpanded\.views/);
    assert.match(js, /const workingIssuesGroupsExpanded = \{\s*active: [^\n]*\n\s*pending: [^\n]*\n\};/);
  });

  it('gives My Work the views of its Jira site only', () => {
    assert.match(functionSource('workingIssuesOptions'), /views: customViewsOptions\(\)/);
    assert.match(functionSource('customViewsFor'), /customViewsForSite\(settings, siteId\(client\.deploymentType, client\.baseUrl\)\)/);
  });

  it('runs each view\'s own search with its JQL, keyed by the Jira site and the JQL', () => {
    const search = functionSource('viewSearchFor');
    assert.match(search, /jql = buildCustomViewJql\(view, \{ assignmentFieldIds: context\.assignmentFieldIds \}\);/);
    assert.match(search, /key: `\$\{siteId\(client\.deploymentType, client\.baseUrl\)\}\\n\$\{jql\}`/);
    assert.match(search, /run: \(signal\) => client\.searchCustomViewIssues\(jql, \{ signal \}\)/);
    assert.match(search, /if \(!isViewAvailable\(view, context\)\) return null;/);
  });

  it('searches a custom view only once it shows: My Work and My Issues expanded, the view selected', () => {
    const options = functionSource('customViewsOptions');
    assert.match(options, /if \(selectedSearch && isWorkingIssuesExpanded && workingIssuesGroupsExpanded\.active\) \{\s*viewSearch\.load\(selectedSearch\.key, selectedSearch\.run, \{ from: viewSearchKeys\.get\(selectedId\) \}\);\s*\}/);
    // Active has no search of its own here: searches holds custom views only.
    assert.match(options, /const searches = new Map\(views\.map\(\(view\) => \[view\.id, viewSearchFor\(client, view, context\)\]\)\);/);
    // Expanding either draws it again, which searches the selected view.
    const toggles = functionSource('workingIssuesOptions');
    assert.match(toggles, /if \(expanded && workingIssuesGroupsExpanded\.active\) setWorkingIssuesState\(workingIssuesState\);/);
    assert.match(toggles, /if \(group === 'active' && expanded\) setWorkingIssuesState\(workingIssuesState\);/);
    assert.match(functionSource('selectView'), /setWorkingIssuesState\(workingIssuesState\);/);
  });

  it('starts an edited view\'s new search (a new order or condition) from the results it showed', () => {
    const options = functionSource('customViewsOptions');
    // Before retain() drops the old key's results, and only then are the keys remembered.
    assert.ok(options.indexOf('viewSearch.load(') < options.indexOf('viewSearch.retain('));
    assert.match(options, /viewSearchKeys\.clear\(\);\s*for \(const \[id, search\] of searches\) if \(search\) viewSearchKeys\.set\(id, search\.key\);/);
    assert.match(functionSource('openViewEditor'), /orderBy: valid\.orderBy\n/);
  });

  it('drops the results of views that are gone or changed, and searches again on Retry and Sync', () => {
    assert.match(functionSource('customViewsOptions'), /viewSearch\.retain\(\[\.\.\.searches\.values\(\)\]\.filter\(Boolean\)\.map\(\(search\) => search\.key\)\);/);
    assert.match(functionSource('customViewsOptions'), /onRefresh: \(id\) => \{[\s\S]*?viewSearch\.refresh\(search\.key, search\.run\);/);
    const load = js.slice(js.indexOf('async function loadAndRenderWorklogs('));
    assert.match(load, /if \(options\.force\) viewSearch\.clear\(\);/);
    assert.match(js, /const viewSearch = createCustomViewSearch\(\(\) => \{\s*if \(workingIssuesState\) setWorkingIssuesState\(workingIssuesState\);\s*\}\);/);
  });

  it('leaves Active Issues\' search as it was: no views in it', () => {
    const calls = [...js.matchAll(/workingIssues\.refresh\([^)]*\{([\s\S]*?)\}\);/g)].map((match) => match[1]);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /includeRecentlyLogged: savedSettings\?\.showRecentlyLoggedIssues === true,\n\s*keepShown\n/);
    assert.match(calls[1], /includeRecentlyLogged: settings\.showRecentlyLoggedIssues\n/);
    for (const call of calls) assert.doesNotMatch(call, /view/i);
    assert.match(functionSource('workingIssuesOptions'), /recentlyLogged: \{ checked: savedSettings\?\.showRecentlyLoggedIssues === true, onChange: setShowRecentlyLoggedIssues \}/);
  });

  it('offers every status and priority Jira lists, a custom field\'s suggested values, and Me', () => {
    const values = functionSource('fieldValues');
    assert.match(values, /if \(field\.kind === 'user'\) return \[\{ \.\.\.ME_VALUE \}\];/);
    assert.match(values, /await jiraFieldValues\(currentClient, field\)/);
    assert.match(values, /return currentClient\.getFieldValueSuggestions\(field\.id, query\);/);
    assert.match(functionSource('jiraFieldValues'), /client\.getStatuses\(\) : client\.getPriorities\(\)/);
    assert.doesNotMatch(values, /searchIssues|getActiveIssues|workingIssues/);
  });

  it('asks for the same issues as the list shown: the saved settings follow what each load reads', () => {
    const load = js.slice(js.indexOf('async function loadAndRenderWorklogs('));
    assert.match(load, /settings = await settingsStore\.load\(\);\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*savedSettings = settings;/);
  });

  it('follows views changed in another tab', () => {
    assert.match(js, /platform\.watchStorage\(\(changes\) => \{\s*if \(!\('customViewsBySite' in changes\)\) return;[\s\S]*?updateCustomViews\(\);/);
  });

  it('opens one drawer at a time: the editor closes the others, and they close it', () => {
    assert.match(functionSource('openViewEditor'), /closeDrawers\(\);/);
    assert.match(functionSource('openViewEditor'), /coverWorklogEditor\(\)/);
    assert.match(functionSource('closeDrawers'), /customViewEditor\?\.close\(\);/);
    assert.match(functionSource('closeOpenPanel'), /else if \(customViewEditor\) customViewEditor\.close\(\);/);
    for (const name of ['openSettings', 'openShortcuts', 'openChangelog']) {
      assert.match(functionSource(name), /customViewEditor\?\.close\(\);/, name);
    }
  });

  it('keeps the page\'s keyboard shortcuts off while the editor is open, as for the other drawers', () => {
    assert.match(js, /const weekNavigationAvailable = \(\) => [^;]*!customViewEditor/);
    assert.match(js, /id: 'worklogs\.log-work'[\s\S]*?when: \(\) => [^;]*!customViewEditor/);
    assert.match(js, /id: 'worklogs\.sync'[\s\S]*?when: \(\) => [^;]*!customViewEditor/);
  });

  it('checks a saved view against what\'s stored at that moment, and gives a new one a random ID', () => {
    const editor = functionSource('openViewEditor');
    assert.match(editor, /const views = await storedViews\(\);/);
    assert.match(editor, /validateViewDraft\(\{[\s\S]*?\}, \{ views, editingId: view\?\.id \}\)/);
    assert.match(editor, /id: view\?\.id \?\? crypto\.randomUUID\(\)/);
    assert.match(editor, /await settingsStore\.saveCustomViews\(site, views\);/);
  });

  it('shows the saved view, and Active after the selected view is deleted', () => {
    const editor = functionSource('openViewEditor');
    assert.match(editor, /await store\(view \? views\.map\([\s\S]*?, saved\.id\);/);
    assert.match(editor, /await store\(views\.filter\(\(item\) => item\.id !== view\.id\), ALL_VIEW_ID\);/);
  });

  it('describes the locally stored views and their own searches in the privacy policy', () => {
    const policy = read('../docs/store-listing/common/privacy-policy.md');
    assert.match(policy, /\| Your custom views of My Work, for each Jira site:/);
    assert.match(policy, /for a person, only "Me"/);
    assert.match(policy, /The issues they find aren't stored\./);
    assert.match(policy, /\*\*With custom views of My Work:\*\* each view you open runs its own search/);
    assert.match(policy, /returns the first 20 matching issues you can see in Jira/);
    assert.match(policy, /Your views themselves are never sent to Jira, only the searches built from them\./);
  });
});
