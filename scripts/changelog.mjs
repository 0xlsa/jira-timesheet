/**
 * Changelog generator, run at build time. CHANGELOG.md, written by hand in the Keep a Changelog
 * format with Semantic Versioning, is the only record of release history; this checks it and
 * writes the JSON the extension shows (src/changelog/changelog.json, generated, never edited by
 * hand). It isn't part of the extension, and the extension never reads Markdown.
 *
 * Usage (from the repository root):
 *   node scripts/changelog.mjs                                       Check CHANGELOG.md
 *   node scripts/changelog.mjs --mode development --out <file>       Write the development JSON
 *   node scripts/changelog.mjs --mode release --out <file>           Write the release JSON
 *   node scripts/changelog.mjs --check-release <version>             Check it's ready to release <version>
 *   --source <file> reads another file than CHANGELOG.md.
 *
 * Two outputs, told apart by their `channel`:
 * - development (`npm run changelog`, and `task build:*`): the releases, and the [Unreleased]
 *   changes as `unreleased` when there are any, which the Changelog previews as "Unreleased (in
 *   development)". For an unpacked copy and development builds only.
 * - release (`task package:*`): the releases only; `unreleased` never appears. Packaging checks
 *   that the packaged JSON is this one.
 *
 * The format (anything else fails the check, naming the line):
 * - Free text before the first `##` heading: the title, an introduction, comments.
 * - `## [Unreleased]`, optional and first: changes not released yet. Checked like a release, but
 *   it may be empty, and only the development output has it.
 * - `## [X.Y.Z] - YYYY-MM-DD` for each release, newest first. Versions are numbers only, because
 *   browser manifests allow no pre-release or build suffix; dates are real dates that never go
 *   forward from one release to the one below it.
 * - `### Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or `Security` inside a release, each
 *   at most once and never empty. A release has at least one.
 * - `- ` items: plain text, on one line or continued on lines indented by at least two spaces. No
 *   Markdown formatting (code, bold, emphasis, links, images), or HTML: the extension shows items
 *   as plain text.
 * - An item may have sub-items, one level only: `  - ` (two spaces, then `- `) under it, plain text
 *   too, continued on lines indented by at least four spaces. What's New lists them under their item.
 * - `<!-- highlight -->` at the end of an item marks it as one of its release's highlights, which
 *   the update announcement shows (its text, without sub-items). Sub-items can't be highlights. The release being packaged needs 1 to 3 (--check-release);
 *   older releases and Unreleased don't.
 * - Link reference definitions (`[1.2.0]: https://…`) after the releases are ignored.
 *
 * The JSON: { channel, unreleased?: { sections }, releases: [{ version, date, sections: [{ type,
 * items: [{ text, highlight, subitems? }] }] }] }, newest release first, sections in the order of
 * CATEGORIES; `subitems` (texts) only for an item that has some.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Keep a Changelog's categories, in the order they're shown.
export const CATEGORIES = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

// Highlights the release being packaged must have.
export const MIN_HIGHLIGHTS = 1;
export const MAX_HIGHLIGHTS = 3;

// Chrome's limit for each number of a manifest version.
const MAX_VERSION_PART = 65535;

const UNRELEASED_HEADING = /^## \[Unreleased\]$/;
const RELEASE_HEADING = /^## \[(\d+)\.(\d+)\.(\d+)\] - (\d{4})-(\d{2})-(\d{2})$/;
const CATEGORY_HEADING = /^### (.*)$/;
const ITEM = /^- (.*)$/;
const CONTINUATION = /^ {2,}(\S.*)$/;
const SUBITEM = /^ {2}- (.*)$/;
const SUBITEM_CONTINUATION = /^ {4,}(\S.*)$/;
const NESTED_ITEM = /^\s+([-*+]|\d+[.)])\s/;
const OTHER_BULLET = /^([*+]|\d+[.)])\s/;
const LINK_DEFINITION = /^\[[^\]]+\]:\s*\S/;
const HIGHLIGHT_MARKER = /\s*<!--\s*highlight\s*-->$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Markdown and HTML that a plain-text item can't contain, with how to name each in an error.
const FORMATTING = [
  [/`/, 'a code span (`)'],
  [/\*\*|__/, 'bold text'],
  [/(^|[\s(])[*_][^\s*_]/, 'emphasis'],
  [/!?\[[^\]]*\]\(/, 'a link or image'],
  [/<[a-zA-Z!/?]/, 'HTML'],
  [/&[a-zA-Z]+;|&#\d+;/, 'an HTML entity']
];

/** A changelog that doesn't follow the format; `problems` lists each problem with its line. */
export class ChangelogError extends Error {
  /** @param {Array<{ line: number, message: string }>} problems */
  constructor(problems) {
    super(problems.map(({ line, message }) => `line ${line}: ${message}`).join('\n'));
    this.name = 'ChangelogError';
    this.problems = problems;
  }
}

/**
 * Compares two X.Y.Z versions by their numbers.
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative when a is older, positive when newer, 0 when equal
 */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** True for a real calendar date. */
function isCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Parses and checks CHANGELOG.md.
 *
 * @param {string} markdown
 * @returns {{ unreleased: { sections: Array<object> } | null,
 *   releases: Array<{ version: string, date: string, sections: Array<{ type: string, items: Array<{ text: string, highlight: boolean }> }> }> }}
 * @throws {ChangelogError} Listing every problem found
 */
export function parseChangelog(markdown) {
  const problems = [];
  const problem = (line, message) => problems.push({ line, message });

  let unreleased = null;
  const releases = [];
  // The release (or Unreleased) being read, its category, and its last item (for continuations).
  let current = null;
  let category = null;
  let item = null;
  // Once link definitions start, only more of them (or blank lines) may follow.
  let inLinkDefinitions = false;

  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((raw, index) => {
    const line = index + 1;
    const text = raw.trimEnd();

    if (text.startsWith('## ')) {
      item = null;
      category = null;
      if (inLinkDefinitions) {
        problem(line, 'Releases must come before the link definitions.');
        return;
      }
      if (UNRELEASED_HEADING.test(text)) {
        if (current) problem(line, '[Unreleased] must be the first section, above every release.');
        else unreleased = current = { line, label: 'Unreleased', sections: new Map() };
        return;
      }
      const match = RELEASE_HEADING.exec(text);
      if (!match) {
        problem(line, `Expected "## [Unreleased]" or "## [X.Y.Z] - YYYY-MM-DD", found "${text}".`);
        current = null;
        return;
      }
      const [, major, minor, patch, year, month, day] = match;
      const version = `${major}.${minor}.${patch}`;
      if (!VERSION.test(version) || [major, minor, patch].some((part) => Number(part) > MAX_VERSION_PART)) {
        problem(line, `${version} isn't a valid version: use numbers without leading zeros, each at most ${MAX_VERSION_PART}.`);
      }
      if (!isCalendarDate(Number(year), Number(month), Number(day))) {
        problem(line, `${year}-${month}-${day} isn't a real date.`);
      }
      current = { line, label: version, version, date: `${year}-${month}-${day}`, sections: new Map() };
      releases.push(current);
      return;
    }

    if (text.startsWith('# ') || text === '#') {
      if (current) problem(line, 'The title (#) must come before the releases.');
      return;
    }

    // Before the first section: the title and introduction, free text.
    if (!current) return;

    if (text === '') return;

    if (LINK_DEFINITION.test(text)) {
      inLinkDefinitions = true;
      item = null;
      return;
    }
    if (inLinkDefinitions) {
      problem(line, 'Only link definitions may follow the link definitions.');
      return;
    }

    const heading = CATEGORY_HEADING.exec(text);
    if (heading) {
      item = null;
      const type = heading[1].trim();
      if (!CATEGORIES.includes(type)) {
        problem(line, `Unknown category "${type}"; use ${CATEGORIES.join(', ')}.`);
        category = null;
      } else if (current.sections.has(type)) {
        problem(line, `${current.label} already has a ${type} section.`);
        category = null;
      } else {
        category = { line, items: [] };
        current.sections.set(type, category);
      }
      return;
    }

    const itemMatch = ITEM.exec(text);
    if (itemMatch) {
      if (!category) {
        problem(line, 'Items must be under a category heading (### Added, ### Fixed, …).');
        item = null;
        return;
      }
      item = { line, text: itemMatch[1].trim(), subitems: [] };
      category.items.push(item);
      return;
    }

    const subitemMatch = SUBITEM.exec(raw.trimEnd());
    if (subitemMatch) {
      if (!item) problem(line, 'A sub-item ("  - …") must follow an item.');
      else item.subitems.push({ line, text: subitemMatch[1].trim() });
      return;
    }
    if (NESTED_ITEM.test(raw)) {
      problem(line, item?.subitems.length && /^ {4,}- /.test(raw)
        ? 'Only one level of sub-items is supported.'
        : 'Write sub-items as "  - " (two spaces, then "- "), one level only.');
      return;
    }
    if (OTHER_BULLET.test(text)) {
      problem(line, 'Start items with "- ".');
      return;
    }

    // Once an item has sub-items, a continuation belongs to the last one, indented by four spaces.
    const lastSubitem = item?.subitems.at(-1);
    if (lastSubitem) {
      const subContinuation = SUBITEM_CONTINUATION.exec(raw);
      if (subContinuation) {
        lastSubitem.text = `${lastSubitem.text} ${subContinuation[1].trim()}`;
        return;
      }
      if (CONTINUATION.test(raw)) {
        problem(line, 'Continue a sub-item on lines indented by at least four spaces.');
        return;
      }
    }

    const continuation = CONTINUATION.exec(raw);
    if (continuation && item) {
      item.text = `${item.text} ${continuation[1].trim()}`;
      return;
    }

    problem(line, category
      ? 'Expected an item ("- …") or an indented continuation of the item above.'
      : 'Expected a category heading (### Added, ### Fixed, …).');
  });

  /** Checks each item's text and highlight marker, and orders the sections. */
  const toSections = (entry) => {
    const sections = [];
    for (const type of CATEGORIES) {
      const section = entry.sections.get(type);
      if (!section) continue;
      if (section.items.length === 0) {
        problem(section.line, `The ${type} section of ${entry.label} has no items.`);
        continue;
      }
      sections.push({
        type,
        items: section.items.map(({ line, text, subitems }) => {
          const highlight = HIGHLIGHT_MARKER.test(text);
          const plain = text.replace(HIGHLIGHT_MARKER, '').trim();
          if (!plain) problem(line, 'The item is empty.');
          for (const [pattern, name] of FORMATTING) {
            if (pattern.test(plain)) problem(line, `Items are plain text and can't contain ${name}.`);
          }
          const subtexts = subitems.map((subitem) => {
            if (HIGHLIGHT_MARKER.test(subitem.text)) problem(subitem.line, 'Only items can be highlights, not sub-items.');
            if (!subitem.text) problem(subitem.line, 'The sub-item is empty.');
            for (const [pattern, name] of FORMATTING) {
              if (pattern.test(subitem.text)) problem(subitem.line, `Sub-items are plain text and can't contain ${name}.`);
            }
            return subitem.text;
          });
          return { text: plain, highlight, ...(subtexts.length && { subitems: subtexts }) };
        })
      });
    }
    return sections;
  };

  const result = {
    unreleased: unreleased && { sections: toSections(unreleased) },
    releases: releases.map((release) => {
      if (release.sections.size === 0) problem(release.line, `Release ${release.version} has no changes.`);
      return { version: release.version, date: release.date, sections: toSections(release) };
    })
  };

  // Newest first: each release older than the one above it, and released no later.
  releases.forEach((release, index) => {
    const above = releases[index - 1];
    if (!above || !VERSION.test(above.version) || !VERSION.test(release.version)) return;
    if (compareVersions(release.version, above.version) >= 0) {
      problem(release.line, `Releases go newest first: ${release.version} must be older than ${above.version}, above it.`);
    } else if (release.date > above.date) {
      problem(release.line, `${release.version} (${release.date}) can't be dated after ${above.version} (${above.date}), above it.`);
    }
  });

  if (problems.length) throw new ChangelogError(problems.sort((a, b) => a.line - b.line));
  return result;
}

// The two outputs: development (with [Unreleased]) and release (releases only).
export const MODES = ['development', 'release'];

/**
 * The JSON the extension shows. The development output has the [Unreleased] changes too, as
 * `unreleased` (left out when there are none); the release output never has them.
 *
 * @param {ReturnType<typeof parseChangelog>} changelog
 * @param {{ mode: 'development' | 'release' }} options
 * @returns {{ channel: string, unreleased?: { sections: Array<object> }, releases: Array<object> }}
 */
export function toChangelogJson(changelog, { mode } = {}) {
  if (mode === 'release') return { channel: 'release', releases: changelog.releases };
  if (mode === 'development') {
    const sections = changelog.unreleased?.sections ?? [];
    return { channel: 'development', ...(sections.length > 0 && { unreleased: { sections } }), releases: changelog.releases };
  }
  throw new Error(`Unknown output "${mode}": use ${MODES.join(' or ')}.`);
}

/**
 * Checks that the changelog is ready to release `version` (the manifest's): nothing left under
 * [Unreleased], and its latest release is that version, with 1 to 3 highlights.
 *
 * @param {ReturnType<typeof parseChangelog>} changelog
 * @param {string} version
 * @returns {string[]} Problems; none when it's ready
 */
export function checkRelease(changelog, version) {
  if (!VERSION.test(String(version))) return [`"${version}" isn't an X.Y.Z version.`];
  const problems = [];
  const howTo = `To release ${version}, move its changes from [Unreleased] into a "## [${version}] - YYYY-MM-DD" section, ` +
    'and set the same version in manifest.json and package.json.';
  if (changelog.unreleased?.sections.length) {
    problems.push(`[Unreleased] still has changes. ${howTo} Leave [Unreleased] empty.`);
  }
  const latest = changelog.releases[0];
  if (!latest) {
    problems.push(`CHANGELOG.md has no releases, so it has none for version ${version}. ${howTo}`);
  } else if (latest.version !== version) {
    problems.push(`The extension's version is ${version}, but the latest release in CHANGELOG.md is ${latest.version}. ${howTo}`);
  } else {
    const highlights = latest.sections.flatMap((section) => section.items).filter((entry) => entry.highlight).length;
    if (highlights < MIN_HIGHLIGHTS || highlights > MAX_HIGHLIGHTS) {
      problems.push(`Release ${version} has ${highlights} highlight${highlights === 1 ? '' : 's'}; mark ${MIN_HIGHLIGHTS} to ` +
        `${MAX_HIGHLIGHTS} of its changes with <!-- highlight --> at the end of the item.`);
    }
  }
  return problems;
}

const USAGE = 'Usage: node scripts/changelog.mjs [--source <file>] [--mode development|release --out <file>] [--check-release <version>]';

/**
 * Runs the command line.
 * @param {string[]} args
 * @returns {number} The exit code
 */
export function main(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        source: { type: 'string' },
        out: { type: 'string' },
        mode: { type: 'string' },
        'check-release': { type: 'string' }
      }
    }));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  // Which output is written is always said, never assumed: unreleased changes must not end up in a
  // release by default.
  if (values.out !== undefined && !MODES.includes(values.mode)) {
    console.error(`--out needs --mode development or --mode release.\n${USAGE}`);
    return 2;
  }
  if (values.mode !== undefined && values.out === undefined) {
    console.error(`--mode needs --out.\n${USAGE}`);
    return 2;
  }

  const source = values.source ?? 'CHANGELOG.md';
  let changelog;
  try {
    changelog = parseChangelog(readFileSync(source, 'utf8'));
  } catch (err) {
    if (!(err instanceof ChangelogError)) throw err;
    for (const { line, message } of err.problems) console.error(`${source}:${line}: ${message}`);
    return 1;
  }

  if (values['check-release'] !== undefined) {
    const problems = checkRelease(changelog, values['check-release']);
    for (const message of problems) console.error(`${source}: ${message}`);
    if (problems.length) return 1;
    console.log(`${source} is ready to release ${values['check-release']}.`);
  }

  const unreleasedCount = changelog.unreleased?.sections.reduce((count, section) => count + section.items.length, 0) ?? 0;
  const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  if (values.out) {
    const json = toChangelogJson(changelog, { mode: values.mode });
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, `${JSON.stringify(json, null, 2)}\n`);
    console.log(`Wrote ${values.out} from ${source}: ${values.mode} output, ${count(changelog.releases.length, 'release')}` +
      `${json.unreleased ? `, ${count(unreleasedCount, 'unreleased change')}` : ''}.`);
  } else if (values['check-release'] === undefined) {
    console.log(`${source} is valid (${count(changelog.releases.length, 'release')}, ${count(unreleasedCount, 'unreleased change')}).`);
  }
  return 0;
}

if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  exit(main(argv.slice(2)));
}
