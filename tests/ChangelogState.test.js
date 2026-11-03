import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';
import {
  compareVersions,
  normalizeReleases,
  normalizeChangelog,
  loadChangelog,
  releaseHighlights,
  announcementFor,
  hasUnreadRelease,
  createChangelogStateStore,
  CHANGELOG_URL,
  LAST_ANNOUNCED_KEY,
  LAST_READ_KEY
} from '../src/changelog/changelogState.js';

const release = (version, items = [{ text: 'A change', highlight: false }]) =>
  ({ version, date: '2026-11-10', sections: [{ type: 'Added', items }] });
const RELEASES = [release('1.2.0'), release('1.1.0'), release('1.0.0')];
const state = (lastAnnouncedVersion, lastReadVersion) => ({ lastAnnouncedVersion, lastReadVersion });

describe('Changelog state - sub-items', () => {
  it('keeps an item\'s sub-items, trimmed, skipping any that aren\'t text', () => {
    const [item] = normalizeReleases({ releases: [release('1.2.0', [{ text: 'Views', highlight: false, subitems: [' Five tabs ', '', 7, null, 'Dragging'] }])] })[0].sections[0].items;
    assert.deepEqual(item, { text: 'Views', highlight: false, subitems: ['Five tabs', 'Dragging'] });
  });

  it('leaves items without sub-items as they were', () => {
    const [item] = normalizeReleases({ releases: [release('1.2.0', [{ text: 'A', highlight: true, subitems: 'not a list' }])] })[0].sections[0].items;
    assert.deepEqual(item, { text: 'A', highlight: true });
  });
});

describe('Changelog state - versions', () => {
  it('compares versions by their numbers, with anything else older than every version', () => {
    assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
    assert.ok(compareVersions('1.2.0', '1.2.1') < 0);
    assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
    assert.ok(compareVersions('1.0.0', '') > 0);
    assert.ok(compareVersions('', '0.0.1') < 0);
    assert.equal(compareVersions('', undefined), 0);
  });
});

describe('Changelog state - the packaged release notes', () => {
  it('reads src/changelog/changelog.json, next to this module', () => {
    assert.equal(fileURLToPath(CHANGELOG_URL), fileURLToPath(new URL('../src/changelog/changelog.json', import.meta.url)));
  });

  it('keeps well-formed releases, sections, and items, and drops the rest', () => {
    const releases = normalizeReleases({
      releases: [
        { version: '1.2.0', date: '2026-11-10', sections: [
          { type: 'Added', items: [{ text: ' New ', highlight: true }, { text: '' }, { text: 7 }, null] },
          { type: 'Unknown', items: [{ text: 'Dropped' }] },
          { type: 'Fixed', items: [] }
        ] },
        { version: '1.1', date: '2026-10-31', sections: [{ type: 'Added', items: [{ text: 'Bad version' }] }] },
        { version: '1.0.0', date: 'yesterday', sections: [{ type: 'Added', items: [{ text: 'Bad date' }] }] },
        { version: '0.9.0', date: '2026-10-01', sections: [] },
        'not a release'
      ]
    });
    assert.deepEqual(releases, [{ version: '1.2.0', date: '2026-11-10', sections: [{ type: 'Added', items: [{ text: 'New', highlight: true }] }] }]);
    assert.deepEqual(normalizeReleases(null), []);
    assert.deepEqual(normalizeReleases({ releases: 'no' }), []);
  });

  const UNRELEASED = { sections: [{ type: 'Added', items: [{ text: 'Not released yet', highlight: false }] }] };

  it('loads the release output with fetch(): its releases, and no unreleased changes', async () => {
    const requested = [];
    const changelog = await loadChangelog(async (url) => {
      requested.push(url);
      return { ok: true, json: async () => ({ channel: 'release', releases: RELEASES }) };
    });
    assert.deepEqual(changelog, { releases: RELEASES, unreleased: null });
    assert.equal(requested[0], CHANGELOG_URL);
  });

  it('loads the development output with its unreleased changes, apart from the releases', async () => {
    const changelog = await loadChangelog(async () => ({
      ok: true, json: async () => ({ channel: 'development', unreleased: UNRELEASED, releases: RELEASES })
    }));
    assert.deepEqual(changelog.unreleased, { sections: [{ type: 'Added', items: [{ text: 'Not released yet', highlight: false }] }] });
    assert.deepEqual(changelog.releases, RELEASES, 'the preview is never a release');
  });

  it('takes unreleased changes only from the development output', () => {
    assert.equal(normalizeChangelog({ channel: 'release', unreleased: UNRELEASED, releases: RELEASES }).unreleased, null);
    assert.equal(normalizeChangelog({ unreleased: UNRELEASED, releases: RELEASES }).unreleased, null);
    assert.equal(normalizeChangelog({ channel: 'development', releases: RELEASES }).unreleased, null);
    assert.equal(normalizeChangelog({ channel: 'development', unreleased: { sections: [{ type: 'Bogus', items: [{ text: 'x' }] }] }, releases: [] }).unreleased, null);
  });

  it('reads a development output with no releases yet', async () => {
    const changelog = await loadChangelog(async () => ({ ok: true, json: async () => ({ channel: 'development', unreleased: UNRELEASED, releases: [] }) }));
    assert.deepEqual(changelog.releases, []);
    assert.ok(changelog.unreleased);
  });

  it('gives null when the file can\'t be read (an unpacked copy without npm run changelog) or is damaged', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    assert.equal(await loadChangelog(async () => ({ ok: false, status: 404 })), null);
    assert.equal(await loadChangelog(async () => { throw new TypeError('Failed to fetch'); }), null);
    assert.equal(await loadChangelog(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } })), null);
    assert.equal(warn.mock.callCount(), 3);
    assert.match(warn.mock.calls[0].arguments[0], /npm run changelog/);
  });

  it('never reads CHANGELOG.md: only the generated JSON', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const requested = [];
    await loadChangelog(async (url) => { requested.push(String(url)); return { ok: false, status: 404 }; }).catch(() => {});
    assert.deepEqual(requested, [String(CHANGELOG_URL)]);
  });

  it('lists a release\'s highlights in the order shown', () => {
    const highlighted = { version: '1.2.0', date: '2026-11-10', sections: [
      { type: 'Added', items: [{ text: 'A', highlight: true }, { text: 'B', highlight: false }] },
      { type: 'Fixed', items: [{ text: 'C', highlight: true }] }
    ] };
    assert.deepEqual(releaseHighlights(highlighted), ['A', 'C']);
    assert.deepEqual(releaseHighlights(release('1.0.0')), []);
  });
});

describe('Changelog state - announcement and NEW badge', () => {
  it('announces the installed version\'s release once, after an update', () => {
    assert.equal(announcementFor(RELEASES, state('1.1.0', '1.1.0'), '1.2.0'), RELEASES[0]);
    assert.equal(announcementFor(RELEASES, state('1.2.0', '1.1.0'), '1.2.0'), null);
  });

  it('announces an update from a version before the Changelog (nothing seen yet)', () => {
    assert.equal(announcementFor(RELEASES, state('', ''), '1.2.0'), RELEASES[0]);
  });

  it('doesn\'t announce a fresh install', () => {
    assert.equal(announcementFor(RELEASES, state('1.2.0', '1.2.0'), '1.2.0'), null);
  });

  it('doesn\'t announce a release whose notes were already read', () => {
    assert.equal(announcementFor(RELEASES, state('1.1.0', '1.2.0'), '1.2.0'), null);
  });

  it('doesn\'t announce a version without release notes, or without a version or state', () => {
    assert.equal(announcementFor(RELEASES, state('', ''), '1.2.1'), null);
    assert.equal(announcementFor(RELEASES, state('', ''), undefined), null);
    assert.equal(announcementFor(RELEASES, null, '1.2.0'), null);
  });

  it('shows the badge until the newest release has been read', () => {
    assert.equal(hasUnreadRelease(RELEASES, state('1.2.0', '1.1.0')), true);
    assert.equal(hasUnreadRelease(RELEASES, state('', '')), true);
    assert.equal(hasUnreadRelease(RELEASES, state('1.1.0', '1.2.0')), false);
  });

  it('bases the badge on the latest release alone: older releases never turn it on', () => {
    // Read up to the latest: nothing to show, though older releases were never opened under Previous releases.
    assert.equal(hasUnreadRelease(RELEASES, state('1.2.0', '1.2.0')), false);
    // Read up to an older release only: the latest is still new.
    assert.equal(hasUnreadRelease(RELEASES, state('1.2.0', '1.1.0')), true);
    assert.equal(hasUnreadRelease(RELEASES.slice(1), state('1.1.0', '1.1.0')), false);
  });

  it('keeps the badge after the announcement is dismissed: only reading removes it', () => {
    // Announced (shown, then closed or postponed), not read.
    assert.equal(hasUnreadRelease(RELEASES, state('1.2.0', '1.1.0')), true);
  });

  it('shows no badge when a newer version was recorded (a development build, or a downgrade)', () => {
    assert.equal(hasUnreadRelease(RELEASES, state('1.2.1', '1.2.1')), false);
  });

  it('shows no badge without release notes or state', () => {
    assert.equal(hasUnreadRelease([], state('', '')), false);
    assert.equal(hasUnreadRelease(RELEASES, null), false);
  });
});

describe('Changelog state - storage', () => {
  it('records a fresh install as announced and read', async () => {
    const area = createMemoryStorageArea();
    const store = createChangelogStateStore(area);
    await store.recordInstall('1.2.0');
    assert.deepEqual(await area.get(null), { [LAST_ANNOUNCED_KEY]: '1.2.0', [LAST_READ_KEY]: '1.2.0' });
    assert.deepEqual(await store.resolve('1.2.0'), state('1.2.0', '1.2.0'));
  });

  it('treats nothing recorded, with other data stored, as an update from before the Changelog, writing nothing', async () => {
    const area = createMemoryStorageArea({ jiraBaseUrl: 'https://example.atlassian.net', token: 't' });
    const store = createChangelogStateStore(area);
    assert.deepEqual(await store.resolve('1.2.0'), state('', ''));
    assert.equal(await store.load(), null);
    assert.deepEqual(Object.keys(await area.get(null)).sort(), ['jiraBaseUrl', 'token']);
  });

  it('treats nothing recorded and nothing stored as a fresh install, and records it', async () => {
    const area = createMemoryStorageArea();
    const store = createChangelogStateStore(area);
    assert.deepEqual(await store.resolve('1.2.0'), state('1.2.0', '1.2.0'));
    assert.deepEqual(await store.load(), state('1.2.0', '1.2.0'));
  });

  it('decides nothing without an installed version (outside the extension)', async () => {
    const area = createMemoryStorageArea();
    assert.equal(await createChangelogStateStore(area).resolve(undefined), null);
    assert.deepEqual(await area.get(null), {});
  });

  it('records the announcement and the reading separately', async () => {
    const area = createMemoryStorageArea({ other: 1 });
    const store = createChangelogStateStore(area);
    await store.markAnnounced('1.2.0');
    assert.deepEqual(await store.load(), state('1.2.0', ''));
    await store.markRead('1.2.0');
    assert.deepEqual(await store.load(), state('1.2.0', '1.2.0'));
  });

  it('never moves a record back to an older version', async () => {
    const area = createMemoryStorageArea({ [LAST_ANNOUNCED_KEY]: '1.3.0', [LAST_READ_KEY]: '1.3.0' });
    const store = createChangelogStateStore(area);
    await store.markAnnounced('1.2.0');
    await store.markRead('1.2.0');
    assert.deepEqual(await store.load(), state('1.3.0', '1.3.0'));
  });

  it('reads a missing or damaged key as nothing seen', async () => {
    const store = createChangelogStateStore(createMemoryStorageArea({ [LAST_READ_KEY]: 42 }));
    assert.deepEqual(await store.load(), state('', ''));
  });
});
