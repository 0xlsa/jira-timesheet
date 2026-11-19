import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// `task screenshots` is the one entry point that recreates the README and store screenshots and
// the promo tiles made from one of them (docs/screenshots/source/README.md). These check the order
// it runs the scripts in, and that it never renders the tiles from an older capture.
const taskfile = readFileSync(new URL('../Taskfile.yml', import.meta.url), 'utf8');

const taskBody = (name) => {
  const start = taskfile.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `missing task ${name}`);
  const next = taskfile.slice(start + 1).search(/\n {2}[a-z][\w:-]*:\n/);
  return taskfile.slice(start, next < 0 ? undefined : start + 1 + next);
};

const CAPTURE = 'python3 docs/screenshots/source/capture.py {{.CLI_ARGS}}';
const RENDER = 'bash docs/store-assets/chrome/source/render.sh';
const VALIDATE = 'bash docs/store-assets/chrome/scripts/validate-assets.sh';

describe('Screenshots - one entry point', () => {
  it('captures the scenarios named (every one by default), passing capture.py\'s options through', () => {
    const task = taskBody('screenshots');
    assert.match(task, /desc: Capture the README and store screenshots, then render and check the promo tiles/);
    assert.ok(task.includes(CAPTURE));
  });

  it('renders and checks the tiles after the capture, only when app-overview was captured', () => {
    const task = taskBody('screenshots');
    const capture = task.indexOf(CAPTURE);
    const render = task.indexOf(RENDER);
    assert.ok(capture >= 0 && render > capture, 'render after the capture');
    assert.ok(task.indexOf(VALIDATE) > render, 'check after rendering');
    // No names (flags such as --refresh-holidays aren't names), or app-overview among them.
    assert.match(task, /names="\$\(printf '%s\\n' \{\{\.CLI_ARGS\}\} \| grep -v '\^-' \|\| true\)"/);
    assert.match(task, /if \[ -z "\$names" \] \|\| printf '%s\\n' "\$names" \| grep -qx app-overview; then/);
  });

  it('ends by listing the changed images, to be checked before committing', () => {
    assert.match(taskBody('screenshots'), /git status --short docs\/screenshots docs\/store-assets/);
  });

  it('renders and checks only the tiles with screenshots:tiles', () => {
    const task = taskBody('screenshots:tiles');
    assert.ok(task.indexOf(VALIDATE) > task.indexOf(RENDER) && task.indexOf(RENDER) >= 0);
    assert.ok(!task.includes('capture.py'));
  });

  it('checks the tools first, the browser being the scripts\' own (CHROME, or Google Chrome)', () => {
    for (const name of ['screenshots', 'screenshots:tiles']) {
      const task = taskBody(name);
      assert.ok(task.indexOf('task: screenshots:tools') >= 0 && task.indexOf('task: screenshots:tools') < task.indexOf('bash ') && (name === 'screenshots:tiles' || task.indexOf('task: screenshots:tools') < task.indexOf(CAPTURE)), name);
    }
    assert.match(taskBody('screenshots:tools'), /for tool in python3 "\$\{CHROME:-google-chrome\}" magick identify; do/);
  });

  it('names only scripts that exist', () => {
    for (const path of ['docs/screenshots/source/capture.py', 'docs/store-assets/chrome/source/render.sh', 'docs/store-assets/chrome/scripts/validate-assets.sh']) {
      assert.ok(taskfile.includes(path), path);
      assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), path);
    }
  });
});
