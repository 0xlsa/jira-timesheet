import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Microsoft Edge Add-ons takes the Chrome package unchanged: no Edge build, no Edge zip. These check
// that the release process says so, and that the package keeps meeting what Edge requires on top of
// the Chrome Web Store (Microsoft's "Port a Chrome extension to Microsoft Edge"): no update_url, and
// no "Chrome" in the extension's name or description.
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const taskfile = read('../Taskfile.yml');
const manifest = JSON.parse(read('../manifest.json'));

const taskBody = (name) => {
  const start = taskfile.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `missing task ${name}`);
  const next = taskfile.slice(start + 1).search(/\n {2}[a-z][\w:-]*:\n/);
  return taskfile.slice(start, next < 0 ? undefined : start + 1 + next);
};

describe('Microsoft Edge Add-ons distribution', () => {
  it('reuses the Chrome package: there is no Edge build or Edge zip', () => {
    assert.doesNotMatch(taskfile, /\n {2}(build|verify|package):edge:\n/);
    assert.doesNotMatch(taskfile, /timesheet-for-jira-edge|dist\/edge|BROWSER: edge/);
  });

  it('reports the Chrome zip as the Edge package, after the Chrome Web Store one, with the Partner Center URL', () => {
    const pkg = taskBody('package:chrome');
    assert.match(pkg, /desc: Build, verify, and zip the Chrome extension for the Chrome Web Store and Microsoft Edge Add-ons/);
    const edge = pkg.indexOf('Microsoft Edge Add-ons package ready: version $version');
    assert.ok(edge > pkg.indexOf('task: zip:browser'), 'only once the Chrome zip is written and checked');
    assert.match(pkg, /echo " {2}Reusing Chrome package: \$\(pwd\)\/\{\{\.RELEASE_DIR\}\}\/timesheet-for-jira-chrome\.zip"/);
    assert.match(pkg, /echo "Upload it at https:\/\/partner\.microsoft\.com\/dashboard\/microsoftedge\/overview"/);
    // The Chrome Web Store's own lines are as before.
    assert.match(pkg, /STORE: Chrome Web Store\n\s+UPLOAD_URL: https:\/\/chrome\.google\.com\/webstore\/devconsole/);
  });

  it('refuses to package a Chrome build that Edge wouldn\'t accept', () => {
    const verify = taskBody('verify:chrome');
    assert.match(verify, /\[ "\$\(jq 'has\("update_url"\)' "\$manifest"\)" = false \] \|\| fail "update_url must not be set/);
    assert.match(verify, /\[\.name, \.short_name, \.description\] \| map\(select\(type == "string"\)\) \| any\(test\("chrome"; "i"\)\) \| not/);
    assert.ok(verify.indexOf('update_url') < verify.indexOf('passed all checks'), 'before the build is reported as passing');
  });

  it('has a manifest Edge accepts as it is', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.equal('update_url' in manifest, false);
    for (const key of ['name', 'short_name', 'description']) {
      if (typeof manifest[key] === 'string') assert.doesNotMatch(manifest[key], /chrome/i, key);
    }
  });
});
