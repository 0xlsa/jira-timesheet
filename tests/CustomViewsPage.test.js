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

  it('remembers the selected view in localStorage, and shows All by default', () => {
    assert.match(js, /let selectedViewId = localStorage\.getItem\('jts-working-issues-view'\) \|\| ALL_VIEW_ID;/);
    assert.match(functionSource('selectView'), /localStorage\.setItem\('jts-working-issues-view', id\);/);
    assert.match(functionSource('customViewsOptions'), /selectedId: views\.some\(\(view\) => view\.id === selectedViewId\) \? selectedViewId : ALL_VIEW_ID/);
  });

  it('gives My Active Issues the views of its Jira site only', () => {
    assert.match(functionSource('workingIssuesOptions'), /views: customViewsOptions\(\)/);
    assert.match(functionSource('customViewsFor'), /customViewsForSite\(settings, siteId\(client\.deploymentType, client\.baseUrl\)\)/);
  });

  it('asks the one existing search for the views\' fields, in both of its calls', () => {
    const calls = [...js.matchAll(/workingIssues\.refresh\([^)]*\{([\s\S]*?)\}\);/g)].map((match) => match[1]);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /viewFields: viewFieldsFor\(currentClient\)/);
    assert.match(calls[1], /viewFields: viewFieldsFor\(client, settings\)/);
    // Views and the editor reload through it, unforced (only when the fields changed).
    assert.match(functionSource('updateCustomViews'), /refreshActiveIssues\(\{ force: false \}\);/);
    assert.match(functionSource('listedFieldValues'), /editorViewField = field\.id;\s*updateCustomViews\(\);/);
  });

  it('gives the open editor the values of each new load of the issues', () => {
    assert.match(functionSource('setWorkingIssuesState'), /if \(state\?\.status === 'ready'\) customViewEditor\?\.refreshValues\(\);/);
  });

  it('asks for the same issues as the list shown: the saved settings follow what each load reads', () => {
    const load = js.slice(js.indexOf('async function loadAndRenderWorklogs('));
    assert.match(load, /settings = await settingsStore\.load\(\);\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*savedSettings = settings;/);
  });

  it('offers every status and priority Jira lists, the listed issues\' first, without another issue search', () => {
    const lists = functionSource('jiraFieldValues');
    assert.match(lists, /field\.id !== 'status' && field\.id !== 'priority'\)\) return Promise\.resolve\(null\);/);
    assert.match(lists, /client\.getStatuses\(\) : client\.getPriorities\(\)/);
    assert.doesNotMatch(lists, /searchIssues|getActiveIssues|workingIssues\.refresh/);
    const values = functionSource('fieldValues');
    assert.match(values, /Promise\.allSettled\(\[listedFieldValues\(field\), jiraFieldValues\(currentClient, field\)\]\)/);
    assert.match(values, /return mergeValueOptions\(listed\.value \?\? \[\], fromJira\.value \?\? \[\]\);/);
  });

  it('loads the recently logged issues for views whatever the switch says, and only when there are views', () => {
    const calls = [...js.matchAll(/workingIssues\.refresh\([^)]*\{([\s\S]*?)\}\);/g)].map((match) => match[1]);
    assert.match(calls[0], /includeRecentlyLogged: savedSettings\?\.showRecentlyLoggedIssues === true \|\| hasCustomViews\(currentClient\),/);
    assert.match(calls[1], /includeRecentlyLogged: settings\.showRecentlyLoggedIssues \|\| hasCustomViews\(client, settings\),/);
    assert.match(functionSource('hasCustomViews'), /return customViewsFor\(client, settings\)\.views\.length > 0;/);
    // All follows the switch, which the page passes as is.
    assert.match(functionSource('workingIssuesOptions'), /recentlyLogged: \{ checked: savedSettings\?\.showRecentlyLoggedIssues === true, onChange: setShowRecentlyLoggedIssues \}/);
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

  it('shows All after the selected view is deleted', () => {
    assert.match(functionSource('openViewEditor'), /await store\(views\.filter\(\(item\) => item\.id !== view\.id\), ALL_VIEW_ID\);/);
  });

  it('describes the locally stored views and the extra fields in the privacy policy', () => {
    const policy = read('../docs/store-listing/common/privacy-policy.md');
    assert.match(policy, /\| Your custom views of My Active Issues, for each Jira site:/);
    assert.match(policy, /for a person, only "Me"/);
    assert.match(policy, /\*\*With custom views of My Active Issues:\*\* the search for your active issues also asks for the fields your views filter on/);
    assert.match(policy, /your views are never sent to Jira/);
  });
});
