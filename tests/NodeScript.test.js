import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/node.sh', import.meta.url));

/** The full path of a command on this machine's PATH. */
function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  throw new Error(`${name} isn't on PATH`);
}

describe('scripts/node.sh - which Node.js the Taskfile runs', () => {
  let root;
  /** A folder to use as PATH, holding fake commands (each echoes its name and arguments) and real tools. */
  function pathWith({ fakes = [], tools = [] }) {
    const dir = mkdtempSync(join(root, 'path-'));
    for (const name of fakes) writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*"\n`, { mode: 0o755 });
    for (const name of tools) symlinkSync(onPath(name), join(dir, name));
    return dir;
  }
  const run = (args, env) => spawnSync('/bin/sh', [SCRIPT, ...args], { env, encoding: 'utf8' });

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'node-script-'));
    mkdirSync(join(root, 'empty'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('runs NODE when it\'s set, with the arguments', () => {
    const env = { PATH: pathWith({ fakes: ['node', 'docker', 'other-node'] }) };
    env.NODE = join(env.PATH, 'other-node');
    assert.equal(run(['--which'], env).stdout, `${env.NODE}\n`);
    assert.equal(run(['scripts/changelog.mjs', '--mode', 'release'], env).stdout, 'other-node scripts/changelog.mjs --mode release\n');
  });

  it('fails when NODE names a command that doesn\'t exist', () => {
    const result = run(['--which'], { PATH: pathWith({ fakes: ['node'] }), NODE: '/nonexistent/node' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing required tool: \/nonexistent\/node \(set as NODE\)/);
  });

  it('runs node when it\'s installed, before Docker', () => {
    const env = { PATH: pathWith({ fakes: ['node', 'docker'] }) };
    assert.equal(run(['--which'], env).stdout, 'node\n');
    assert.equal(run(['scripts/changelog.mjs'], env).stdout, 'node scripts/changelog.mjs\n');
  });

  it('otherwise runs node:22-alpine in Docker: no network, as the current user, only the current folder', () => {
    const env = { PATH: pathWith({ fakes: ['docker'], tools: ['awk', 'id'] }) };
    assert.equal(run(['--which'], env).stdout, 'docker (node:22-alpine)\n');
    const result = run(['scripts/changelog.mjs', '--check-release', '1.2.0'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Node\.js not found; using Docker \(node:22-alpine\)/);
    const cwd = process.cwd();
    assert.ok(result.stdout.startsWith(`docker run --rm --network none --user ${process.getuid()}:${process.getgid()} -v ${cwd}:${cwd} -w ${cwd} -e HOME=/tmp `), result.stdout);
    assert.ok(result.stdout.endsWith(' node:22-alpine node scripts/changelog.mjs --check-release 1.2.0\n'), result.stdout);
    if (existsSync('/proc/meminfo')) assert.match(result.stdout, / --memory \d+m --memory-swap \d+m -e NODE_OPTIONS=--max-old-space-size=\d+ /);
  });

  it('fails, saying what to install, with neither Node.js nor Docker', () => {
    const result = run(['--which'], { PATH: join(root, 'empty') });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Missing required tool: Node\.js\. Install Node\.js or Docker, or set NODE/);
  });
});
