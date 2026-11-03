import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseChangelog,
  toChangelogJson,
  MODES,
  checkRelease,
  compareVersions,
  ChangelogError,
  CATEGORIES
} from '../scripts/changelog.mjs';
import { CATEGORIES as RUNTIME_CATEGORIES, normalizeReleases } from '../src/changelog/changelogState.js';

const SCRIPT = fileURLToPath(new URL('../scripts/changelog.mjs', import.meta.url));
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** The problems parseChangelog() reports, one per line as `line N: message`, in line order. */
function problemsOf(markdown) {
  try {
    parseChangelog(markdown);
  } catch (err) {
    assert.ok(err instanceof ChangelogError, `expected a ChangelogError, got ${err}`);
    return err.problems.map(({ line, message }) => `line ${line}: ${message}`).join('\n');
  }
  assert.fail('expected the changelog to be rejected');
}

const VALID = `# Changelog

Introduction, with a [link](https://keepachangelog.com/) and <!-- a comment -->.

## [Unreleased]

### Added

- Something not released yet.

## [1.2.0] - 2026-11-10

### Fixed

- A fix.

### Added

- A feature <!-- highlight -->
- Another feature, written over
  two lines. <!--highlight-->
- A third.

## [1.0.0] - 2026-10-27

### Added

- The first release.

[1.2.0]: https://example.com/compare/v1.0.0...v1.2.0
[1.0.0]: https://example.com/releases/tag/v1.0.0
`;

describe('Changelog generator - parsing CHANGELOG.md', () => {
  it('reads the releases newest first, with their sections in Keep a Changelog order', () => {
    const changelog = parseChangelog(VALID);
    assert.deepEqual(changelog.releases.map((r) => [r.version, r.date]), [['1.2.0', '2026-11-10'], ['1.0.0', '2026-10-27']]);
    assert.deepEqual(changelog.releases[0].sections.map((s) => s.type), ['Added', 'Fixed']);
    assert.deepEqual(changelog.releases[0].sections[0].items, [
      { text: 'A feature', highlight: true },
      { text: 'Another feature, written over two lines.', highlight: true },
      { text: 'A third.', highlight: false }
    ]);
  });

  it('keeps Unreleased apart from the releases', () => {
    const changelog = parseChangelog(VALID);
    assert.deepEqual(changelog.unreleased.sections, [{ type: 'Added', items: [{ text: 'Something not released yet.', highlight: false }] }]);
    assert.deepEqual(changelog.releases.map((r) => r.version), ['1.2.0', '1.0.0']);
  });

  it('writes the release output with the releases only, never Unreleased', () => {
    const json = toChangelogJson(parseChangelog(VALID), { mode: 'release' });
    assert.deepEqual(Object.keys(json), ['channel', 'releases']);
    assert.equal(json.channel, 'release');
    assert.deepEqual(json.releases.map((r) => r.version), ['1.2.0', '1.0.0']);
    assert.doesNotMatch(JSON.stringify(json), /not released yet/);
  });

  it('writes the development output with the Unreleased changes, marked as such, apart from the releases', () => {
    const json = toChangelogJson(parseChangelog(VALID), { mode: 'development' });
    assert.equal(json.channel, 'development');
    assert.deepEqual(json.unreleased, { sections: [{ type: 'Added', items: [{ text: 'Something not released yet.', highlight: false }] }] });
    assert.deepEqual(json.releases.map((r) => r.version), ['1.2.0', '1.0.0']);
  });

  it('leaves unreleased out of the development output when there\'s nothing under it, and allows no releases', () => {
    const empty = toChangelogJson(parseChangelog('## [Unreleased]\n\n## [1.0.0] - 2026-10-27\n### Added\n- One.\n'), { mode: 'development' });
    assert.equal('unreleased' in empty, false);
    const unreleasedOnly = toChangelogJson(parseChangelog('## [Unreleased]\n### Added\n- Next.\n'), { mode: 'development' });
    assert.deepEqual(unreleasedOnly.releases, []);
    assert.equal(unreleasedOnly.unreleased.sections.length, 1);
  });

  it('writes only a named output', () => {
    assert.deepEqual(MODES, ['development', 'release']);
    assert.throws(() => toChangelogJson(parseChangelog(VALID)), /Unknown output "undefined": use development or release/);
    assert.throws(() => toChangelogJson(parseChangelog(VALID), { mode: 'dev' }), /Unknown output "dev"/);
  });

  it('accepts an empty Unreleased section and no Unreleased section', () => {
    assert.equal(parseChangelog('# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-10-27\n\n### Added\n\n- One.\n').unreleased.sections.length, 0);
    assert.equal(parseChangelog('## [1.0.0] - 2026-10-27\n### Added\n- One.\n').unreleased, null);
  });

  it('ignores Windows line endings', () => {
    assert.equal(parseChangelog(VALID.replace(/\n/g, '\r\n')).releases.length, 2);
  });

  it('rejects headings that are neither Unreleased nor a release', () => {
    assert.match(problemsOf('## Version 1.0.0\n### Added\n- One.\n'), /^line 1: Expected "## \[Unreleased\]" or "## \[X\.Y\.Z\] - YYYY-MM-DD"/m);
    assert.match(problemsOf('## [1.0.0]\n### Added\n- One.\n'), /^line 1: Expected/m);
    assert.match(problemsOf('## [1.0.0] – 2026-10-27\n### Added\n- One.\n'), /^line 1: Expected/m);
  });

  it('rejects versions a browser manifest can\'t hold', () => {
    assert.match(problemsOf('## [1.0.0-beta.1] - 2026-10-27\n### Added\n- One.\n'), /Expected/);
    assert.match(problemsOf('## [1.02.0] - 2026-10-27\n### Added\n- One.\n'), /isn't a valid version/);
    assert.match(problemsOf('## [1.65536.0] - 2026-10-27\n### Added\n- One.\n'), /isn't a valid version/);
  });

  it('rejects dates that don\'t exist', () => {
    assert.match(problemsOf('## [1.0.0] - 2026-02-30\n### Added\n- One.\n'), /^line 1: 2026-02-30 isn't a real date/m);
  });

  it('requires releases newest first, never dated after the release above', () => {
    assert.match(problemsOf('## [1.0.0] - 2026-10-27\n### Added\n- One.\n## [1.1.0] - 2026-10-31\n### Added\n- Two.\n'),
      /^line 4: Releases go newest first: 1\.1\.0 must be older than 1\.0\.0/m);
    assert.match(problemsOf('## [1.1.0] - 2026-10-31\n### Added\n- Two.\n## [1.1.0] - 2026-10-30\n### Added\n- One.\n'),
      /must be older than 1\.1\.0/);
    assert.match(problemsOf('## [1.1.0] - 2026-10-27\n### Added\n- Two.\n## [1.0.0] - 2026-10-31\n### Added\n- One.\n'),
      /^line 4: 1\.0\.0 \(2026-10-31\) can't be dated after 1\.1\.0/m);
  });

  it('requires Unreleased to come first', () => {
    assert.match(problemsOf('## [1.0.0] - 2026-10-27\n### Added\n- One.\n## [Unreleased]\n'), /^line 4: \[Unreleased\] must be the first section/m);
  });

  it('accepts only Keep a Changelog categories, each once', () => {
    assert.match(problemsOf('## [1.0.0] - 2026-10-27\n### New\n- One.\n'), /^line 2: Unknown category "New"; use Added, Changed, Deprecated, Removed, Fixed, Security/m);
    assert.match(problemsOf('## [1.0.0] - 2026-10-27\n### Added\n- One.\n### Added\n- Two.\n'), /^line 4: 1\.0\.0 already has a Added section/m);
  });

  it('rejects empty releases and empty categories', () => {
    assert.match(problemsOf('## [1.0.0] - 2026-10-27\n'), /^line 1: Release 1\.0\.0 has no changes/m);
    assert.match(problemsOf('## [1.0.0] - 2026-10-27\n### Added\n### Fixed\n- One.\n'), /^line 2: The Added section of 1\.0\.0 has no items/m);
    assert.match(problemsOf('## [Unreleased]\n### Added\n## [1.0.0] - 2026-10-27\n### Added\n- One.\n'), /^line 2: The Added section of Unreleased has no items/m);
  });

  it('requires items under a category, written with "- ", without nested lists', () => {
    assert.match(problemsOf('## [1.0.0] - 2026-10-27\n- One.\n'), /^line 2: Items must be under a category heading/m);
    assert.match(problemsOf('## [1.0.0] - 2026-10-27\n### Added\n* One.\n'), /^line 3: Start items with "- "/m);
    assert.match(problemsOf('## [1.0.0] - 2026-10-27\n### Added\n- One.\n  - Nested.\n'), /^line 4: Nested lists aren't supported/m);
    assert.match(problemsOf('## [1.0.0] - 2026-10-27\n### Added\nA paragraph.\n'), /^line 3: Expected an item/m);
    assert.match(problemsOf('## [1.0.0] - 2026-10-27\nA paragraph.\n### Added\n- One.\n'), /^line 2: Expected a category heading/m);
  });

  it('keeps items plain text: no Markdown formatting or HTML besides the highlight marker', () => {
    const item = (text) => problemsOf(`## [1.0.0] - 2026-10-27\n### Added\n- ${text}\n`);
    assert.match(item('Uses `code`.'), /^line 3: Items are plain text and can't contain a code span/m);
    assert.match(item('Very **bold**.'), /can't contain bold text/);
    assert.match(item('Very *important*.'), /can't contain emphasis/);
    assert.match(item('See [the docs](https://example.com).'), /can't contain a link or image/);
    assert.match(item('Shows <b>this</b>.'), /can't contain HTML/);
    assert.match(item('A comment <!-- note -->'), /can't contain HTML/);
    assert.match(item('An &amp; entity.'), /can't contain an HTML entity/);
    assert.match(item('<!-- highlight -->'), /The item is empty/);
    // Underscores inside words, and symbols, are plain text.
    assert.equal(parseChangelog('## [1.0.0] - 2026-10-27\n### Added\n- Fields like customfield_10050, 1 < 2, and ? or +.\n').releases.length, 1);
  });

  it('allows link definitions only after the releases', () => {
    assert.match(problemsOf('## [1.0.0] - 2026-10-27\n### Added\n- One.\n[1.0.0]: https://example.com\n### Fixed\n- Two.\n'),
      /^line 5: Only link definitions may follow the link definitions/m);
  });

  it('reports every problem, in line order', () => {
    const problems = problemsOf('## [1.0.0] - 2026-02-30\n### New\n- One.\n### Added\n- `two`\n');
    assert.deepEqual(problems.split('\n').map((p) => p.split(':')[0]), ['line 1', 'line 2', 'line 3', 'line 5']);
  });

  it('compares versions by their numbers', () => {
    assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
    assert.ok(compareVersions('1.0.0', '1.0.1') < 0);
    assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  });

  it('uses the same categories as the extension, and its JSON reads back unchanged in the extension', () => {
    assert.deepEqual(RUNTIME_CATEGORIES, CATEGORIES);
    for (const mode of MODES) {
      const json = toChangelogJson(parseChangelog(VALID), { mode });
      assert.deepEqual(normalizeReleases(JSON.parse(JSON.stringify(json))), json.releases);
    }
  });
});

describe('Changelog generator - release check', () => {
  const changelog = (highlights) => parseChangelog(
    `## [1.2.0] - 2026-11-10\n### Added\n${Array.from({ length: 4 }, (_, i) => `- Item ${i}${i < highlights ? ' <!-- highlight -->' : ''}`).join('\n')}\n` +
    '## [1.1.0] - 2026-10-31\n### Added\n- Older, without highlights.\n');

  it('passes when the latest release is the version, with 1 to 3 highlights', () => {
    for (const count of [1, 2, 3]) assert.deepEqual(checkRelease(changelog(count), '1.2.0'), []);
  });

  it('fails without highlights, or with more than three', () => {
    assert.match(checkRelease(changelog(0), '1.2.0')[0], /^Release 1\.2\.0 has 0 highlights; mark 1 to 3 of its changes with <!-- highlight -->/);
    assert.match(checkRelease(changelog(4), '1.2.0')[0], /has 4 highlights/);
  });

  it('fails when the latest release isn\'t the version, saying how to release it', () => {
    const [problem] = checkRelease(changelog(1), '1.2.1');
    assert.match(problem, /The extension's version is 1\.2\.1, but the latest release in CHANGELOG\.md is 1\.2\.0\./);
    assert.match(problem, /move its changes from \[Unreleased\] into a "## \[1\.2\.1\] - YYYY-MM-DD" section/);
    assert.match(problem, /manifest\.json and package\.json/);
    assert.match(checkRelease(changelog(1), '1.1.0')[0], /latest release in CHANGELOG\.md is 1\.2\.0/);
  });

  it('fails without any release, and for a version that isn\'t X.Y.Z', () => {
    assert.match(checkRelease(parseChangelog('## [Unreleased]\n'), '1.0.0')[0], /has no releases/);
    assert.match(checkRelease(changelog(1), '1.2')[0], /isn't an X\.Y\.Z version/);
  });

  it('doesn\'t require highlights in older releases', () => {
    const released = parseChangelog('## [Unreleased]\n## [1.0.0] - 2026-10-27\n### Added\n- One. <!-- highlight -->\n## [0.9.0] - 2026-10-01\n### Added\n- Zero.\n');
    assert.deepEqual(checkRelease(released, '1.0.0'), []);
  });

  it('fails while [Unreleased] still has changes, even when the release itself is ready', () => {
    const withUnreleased = parseChangelog('## [Unreleased]\n### Added\n- Next.\n## [1.2.0] - 2026-11-10\n### Added\n- One. <!-- highlight -->\n');
    const problems = checkRelease(withUnreleased, '1.2.0');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^\[Unreleased\] still has changes\. To release 1\.2\.0, move its changes from \[Unreleased\]/);
  });

  it('reports every reason a release isn\'t ready: changes under [Unreleased], and no release for the version', () => {
    const problems = checkRelease(parseChangelog('## [Unreleased]\n### Added\n- Next.\n'), '1.2.0');
    assert.equal(problems.length, 2);
    assert.match(problems[0], /\[Unreleased\] still has changes/);
    assert.match(problems[1], /has no releases/);
  });
});

describe('Changelog generator - the repository\'s CHANGELOG.md', () => {
  const changelog = parseChangelog(read('../CHANGELOG.md'));

  it('is valid, and lists no release before 1.2.0 (the earlier versions were development milestones)', () => {
    assert.ok(changelog.releases.every((r) => compareVersions(r.version, '1.2.0') >= 0), changelog.releases.map((r) => r.version).join(', '));
  });

  it('keeps every release\'s highlights within 3', () => {
    for (const r of changelog.releases) {
      assert.ok(r.sections.flatMap((section) => section.items).filter((item) => item.highlight).length <= 3, r.version);
    }
  });

  it('has a version in manifest.json and package.json that agree', () => {
    assert.equal(JSON.parse(read('../manifest.json')).version, JSON.parse(read('../package.json')).version);
  });
});

describe('Changelog generator - command line', () => {
  const run = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });

  it('writes the chosen output to --out, creating its folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'changelog-'));
    try {
      writeFileSync(join(dir, 'CHANGELOG.md'), VALID);
      for (const mode of MODES) {
        const result = run(['--mode', mode, '--out', `build/${mode}/changelog.json`], dir);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp(`${mode} output`));
        const json = JSON.parse(readFileSync(join(dir, `build/${mode}/changelog.json`), 'utf8'));
        assert.deepEqual(json, toChangelogJson(parseChangelog(VALID), { mode }));
      }
      assert.doesNotMatch(readFileSync(join(dir, 'build/release/changelog.json'), 'utf8'), /unreleased|not released yet/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses --out without a named output, and --mode without --out, writing nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'changelog-'));
    try {
      writeFileSync(join(dir, 'CHANGELOG.md'), VALID);
      for (const args of [['--out', 'out.json'], ['--mode', 'dev', '--out', 'out.json'], ['--mode', 'release']]) {
        const result = run(args, dir);
        assert.equal(result.status, 2, args.join(' '));
        assert.match(result.stderr, /Usage: node scripts\/changelog\.mjs/);
      }
      assert.equal(existsSync(join(dir, 'out.json')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with each problem as file:line, and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'changelog-'));
    try {
      writeFileSync(join(dir, 'notes.md'), '## [1.0.0] - 2026-10-27\n### New\n- One.\n');
      const result = run(['--source', 'notes.md', '--mode', 'release', '--out', 'out.json'], dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^notes\.md:2: Unknown category "New"/m);
      assert.equal(existsSync(join(dir, 'out.json')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--check-release passes for the latest release with nothing unreleased, and fails otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'changelog-'));
    try {
      writeFileSync(join(dir, 'CHANGELOG.md'), VALID.replace('### Added\n\n- Something not released yet.\n\n', ''));
      assert.equal(run(['--check-release', '1.2.0'], dir).status, 0);
      const result = run(['--check-release', '1.2.1'], dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /The extension's version is 1\.2\.1/);
      writeFileSync(join(dir, 'CHANGELOG.md'), VALID);
      const unreleased = run(['--check-release', '1.2.0'], dir);
      assert.equal(unreleased.status, 1);
      assert.match(unreleased.stderr, /\[Unreleased\] still has changes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown options', () => {
    const result = run(['--bogus']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: node scripts\/changelog\.mjs/);
  });
});
