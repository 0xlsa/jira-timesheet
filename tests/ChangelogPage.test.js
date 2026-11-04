import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../options.html');
const js = read('../options.js');
const css = read('../options.css');
const taskfile = read('../Taskfile.yml');

/** The source of a function in options.js, from its declaration to the next top-level declaration. */
function functionSource(name) {
  const start = js.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const rest = js.slice(start + 1);
  const end = rest.search(/\n(?:async )?function |\n(?:const|let) |\n\/\/ =====/);
  return js.slice(start, end < 0 ? undefined : start + 1 + end);
}

describe('What\'s New page wiring - markup', () => {
  it('has a What\'s New button in the header, before the keyboard shortcuts and Settings, with a hidden NEW badge', () => {
    const header = html.slice(html.indexOf('<div class="header-actions">'), html.indexOf('</header>'));
    const button = header.match(/<button[^>]*id="changelogBtn"[^>]*>/)?.[0];
    assert.ok(button, 'missing #changelogBtn');
    assert.match(button, /aria-controls="changelogDrawer"/);
    assert.match(button, /aria-expanded="false"/);
    assert.match(button, /aria-label="What's New"/);
    assert.match(button, /data-tooltip="What's New"/);
    // What's New, Help (?), then Settings, after the theme switch.
    const at = (id) => header.indexOf(`id="${id}"`);
    assert.ok(at('themeToggleBtn') >= 0 && at('themeToggleBtn') < at('changelogBtn'));
    assert.ok(at('changelogBtn') < at('shortcutsHelpBtn'));
    assert.ok(at('shortcutsHelpBtn') < at('settingsBtn'));
    assert.match(header, /<span id="changelogNewBadge" class="header-new-badge hidden" aria-hidden="true">NEW<\/span>/);
  });

  it('has a What\'s New drawer beside the other drawers, and no new navigation', () => {
    assert.match(html, /<aside id="changelogDrawer" class="changelog-drawer hidden" role="dialog" aria-modal="false"><\/aside>/);
    assert.doesNotMatch(html, /<nav\b|role="tablist"/);
  });

  it('places the update announcement at the top of the timesheet, hidden and polite', () => {
    const weekly = html.slice(html.indexOf('<section id="weeklySection"'));
    assert.match(weekly, /<section id="updateAnnouncement" class="update-announcement hidden" aria-live="polite"><\/section>/);
    assert.ok(weekly.indexOf('id="updateAnnouncement"') < weekly.indexOf('class="stats-grid"'));
  });
});

describe('Changelog page wiring - controller', () => {
  it('opens one drawer at a time: the Changelog closes the others, and they close it', () => {
    const openChangelog = functionSource('openChangelog');
    assert.match(openChangelog, /shortcutsDrawer\?\.close\(\);/);
    assert.match(openChangelog, /closeSettings\(\);/);
    assert.match(openChangelog, /coverWorklogEditor\(\)/);
    assert.match(functionSource('openSettings'), /changelogDrawer\?\.close\(\);/);
    assert.match(functionSource('openShortcuts'), /changelogDrawer\?\.close\(\);/);
    assert.match(functionSource('closeDrawers'), /changelogDrawer\?\.close\(\);/);
    assert.match(functionSource('closeOpenPanel'), /else if \(changelogDrawer\) changelogDrawer\.close\(\);/);
  });

  it('closes every drawer before a worklog panel or dialog opens', () => {
    for (const name of ['startEditPending', 'confirmDiscardPending', 'startLogWork', 'startLogWorkOnIssue', 'startLogWorkOnDay', 'confirmDeleteWorklog', 'openEditor']) {
      assert.match(functionSource(name), /closeDrawers\(\);/, name);
    }
    assert.doesNotMatch(js, /shortcutsDrawer\?\.close\(\);\n\s*closeSettings\(\);\n\s*if \(/);
  });

  it('keeps the page\'s keyboard shortcuts off while the Changelog is open, as for the other drawers', () => {
    assert.match(js, /const weekNavigationAvailable = \(\) => [^;]*!changelogDrawer/);
    assert.match(js, /id: 'worklogs\.log-work'[\s\S]*?when: \(\) => [^;]*!changelogDrawer/);
    assert.match(js, /id: 'worklogs\.sync'[\s\S]*?when: \(\) => [^;]*!changelogDrawer/);
  });

  it('names the button What\'s New, and says so when there are new release notes', () => {
    const badge = functionSource('updateChangelogBadge');
    assert.match(badge, /unread \? "What's New, new release notes" : "What's New"/);
    assert.match(badge, /unread \? "What's New · New release notes" : "What's New"/);
  });

  it('records the release notes as read only from the drawer, once it has shown them', () => {
    assert.equal(js.match(/changelogStore\.markRead\(/g)?.length, 1);
    assert.match(functionSource('openChangelog'), /onRead: \(version\) => \{\s*changelogStore\.markRead\(version\)/);
  });

  it('never records the release notes as read when the announcement is dismissed', () => {
    const announce = functionSource('announceWhenVisible');
    assert.doesNotMatch(announce, /markRead/);
    assert.doesNotMatch(announce, /onDismiss/);
    assert.match(announce, /onExplore: openChangelog/);
    assert.match(announce, /document\.visibilityState !== 'visible'/);
    assert.match(announce, /requestAnimationFrame\(\(\) => \{\s*changelogStore\.markAnnounced\(release\.version\)/);
  });

  it('loads the Changelog when the page opens, and follows other tabs', () => {
    assert.match(js, /document\.addEventListener\('DOMContentLoaded', \(\) => \{[\s\S]*?initChangelog\(\);[\s\S]*?\}\);/);
    assert.match(js, /platform\.watchStorage\(\(changes\) => \{\s*if \(LAST_ANNOUNCED_KEY in changes \|\| LAST_READ_KEY in changes\) refreshChangelogState\(\);/);
  });

  it('records a fresh install in the background before the page opens', () => {
    const background = read('../background.js');
    assert.match(background, /setUpTimesheetLaunchers\(ext, \{\s*onInstall: \(\) => createChangelogStateStore\(createPlatform\(\)\.storage\)\.recordInstall\(ext\.runtime\.getManifest\(\)\.version\)/);
  });
});

describe('Changelog page wiring - styles', () => {
  it('slides the Changelog drawer in and out like the other drawers, and lays it out like them', () => {
    for (const selector of [
      '.worklog-editor,\n.shortcuts-drawer,\n.changelog-drawer,\n.custom-view-editor,\n.settings-drawer {\n  position: fixed;',
      '.changelog-drawer.is-closed,\n.custom-view-editor.is-closed,\n.settings-drawer.is-closed {',
      '  .changelog-drawer,\n  .changelog-drawer.is-closed,\n  .custom-view-editor,',
      '.changelog-drawer-body,', '.changelog-header,', '.changelog-title,', '.changelog-list,'
    ]) {
      assert.ok(css.includes(selector), `missing ${JSON.stringify(selector)}`);
    }
    assert.match(css, /\.shortcuts-drawer,\n\.changelog-drawer,\n\.custom-view-editor,\n\.settings-drawer \{\n {2}z-index: 45;/);
    assert.match(css, /\.header-icon-btn\[aria-controls="changelogDrawer"\]\[aria-expanded="true"\]/);
    assert.match(css, /\.header-new-badge \{[^}]*position: absolute;/);
  });
});

describe('Changelog build and packaging', () => {
  const taskBody = (name) => {
    const start = taskfile.indexOf(`\n  ${name}:\n`);
    assert.ok(start >= 0, `missing task ${name}`);
    const next = taskfile.slice(start + 1).search(/\n {2}[a-z][\w:-]*:\n/);
    return taskfile.slice(start, next < 0 ? undefined : start + 1 + next);
  };

  it('generates the release notes into every build, from CHANGELOG.md, in the output the build asks for', () => {
    const build = taskBody('build:browser');
    assert.match(build, /vars: \[BROWSER, LABEL, MANIFEST_FILTER, CHANGELOG_MODE\]/);
    assert.match(build, /sh scripts\/node\.sh scripts\/changelog\.mjs --mode '\{\{\.CHANGELOG_MODE\}\}' --out '\{\{\.DIR\}\}\/src\/changelog\/changelog\.json'/);
    assert.doesNotMatch(build, /--check-release/, 'development builds work before a release is ready');
  });

  it('builds with the development output by default, and packages with the release output', () => {
    for (const browser of ['chrome', 'firefox']) {
      assert.match(taskBody(`build:${browser}`), /CHANGELOG_MODE: '\{\{\.CHANGELOG_MODE \| default "development"\}\}'/);
      assert.match(taskBody(`package:${browser}`), new RegExp(`task: build:${browser}\\n\\s+vars: \\{ CHANGELOG_MODE: release \\}`));
    }
  });

  it('fails packaging unless the packaged notes are the release output, and CHANGELOG.md is ready to release the manifest\'s version', () => {
    const verify = taskBody('verify:browser');
    assert.match(verify, /\[ -f "\$json" \] \|\| fail "missing from the build/);
    assert.match(verify, /jq -e '\.channel == "release" and \(has\("unreleased"\) \| not\)' "\$json"/);
    assert.match(verify, /\[ "\$latest" = "\$version" \] \|\| fail/);
    assert.match(verify, /sh scripts\/node\.sh scripts\/changelog\.mjs --check-release "\$\(jq -r '\.version' manifest\.json\)"/);
    for (const browser of ['chrome', 'firefox']) {
      const pkg = taskBody(`package:${browser}`);
      assert.match(pkg.slice(0, pkg.indexOf('zip:browser')), new RegExp(`task: verify:${browser}`));
    }
  });

  it('runs Node.js only through scripts/node.sh, and checks for it before removing the old package', () => {
    assert.doesNotMatch(taskfile, /NODE:-node|^\s*node /m);
    assert.match(taskBody('check:tools'), /sh scripts\/node\.sh --which >\/dev\/null/);
    for (const browser of ['chrome', 'firefox']) {
      const pkg = taskBody(`package:${browser}`);
      const check = pkg.indexOf('task: check:tools');
      assert.ok(check >= 0 && check < pkg.indexOf(`rm -f '{{.RELEASE_DIR}}/timesheet-for-jira-${browser}.zip'`), browser);
    }
  });

  it('writes the development output for an unpacked copy, kept out of Git, and keeps the generator out of the package', () => {
    assert.equal(JSON.parse(read('../package.json')).scripts.changelog, 'node scripts/changelog.mjs --mode development --out src/changelog/changelog.json');
    assert.match(read('../.gitignore'), /^\/src\/changelog\/changelog\.json$/m);
    assert.match(taskfile, /RUNTIME_DIRS: icons src\n/);
    assert.match(taskfile, /RUNTIME_FILES: manifest\.json background\.js options\.html options\.css options\.js\n/);
  });

  it('never reads CHANGELOG.md at runtime', () => {
    for (const path of ['../src/changelog/changelogState.js', '../src/ui/changelogDrawer.js', '../options.js', '../background.js']) {
      assert.doesNotMatch(read(path), /CHANGELOG\.md'|changelog\.mjs'|parseChangelog\(/, path);
    }
  });

  it('keeps the screenshots free of the announcement and NEW badge', () => {
    const harness = read('../docs/screenshots/source/harness.js');
    assert.match(harness, /store\.changelogLastAnnouncedVersion = manifest\.version;/);
    assert.match(harness, /store\.changelogLastReadVersion = manifest\.version;/);
  });
});
