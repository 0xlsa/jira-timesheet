/**
 * The Changelog's release notes, and what the user has seen of them.
 *
 * The release notes are src/changelog/changelog.json, generated from CHANGELOG.md by
 * scripts/changelog.mjs and packaged with the extension, so they show offline. Its shape:
 * { channel, unreleased?: { sections }, releases: [{ version, date, sections: [{ type, items:
 * [{ text, highlight }] }] }] }, newest release first. There are two:
 * - release (packages): the releases only.
 * - development (`npm run changelog` for an unpacked copy, and `task build:*`): the releases, and
 *   the changes not released yet (`unreleased`), which the drawer previews as "Unreleased (in
 *   development)". The preview is never a release: the NEW badge, the update announcement, and
 *   what's recorded as announced or read only ever go by `releases`.
 *
 * What the user has seen is kept in storage.local, under two keys of its own, so writing one
 * never overwrites the other from another tab:
 * - changelogLastAnnouncedVersion: the last version whose update announcement was shown
 * - changelogLastReadVersion: the newest release the user has seen in the Changelog drawer
 * They're kept apart on purpose: closing an announcement isn't reading the release notes. A fresh
 * install records its version in both (the background, before it opens the page), so it shows
 * neither the announcement nor the NEW badge.
 *
 * No DOM; the storage area and fetch are injected.
 */

export const LAST_ANNOUNCED_KEY = 'changelogLastAnnouncedVersion';
export const LAST_READ_KEY = 'changelogLastReadVersion';

/** The generated release notes, packaged with the extension. */
export const CHANGELOG_URL = new URL('./changelog.json', import.meta.url);

// Keep a Changelog's categories, in the order they're shown (as in scripts/changelog.mjs).
export const CATEGORIES = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

const VERSION = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Compares two X.Y.Z versions by their numbers. Anything that isn't a version (such as '', for
 * nothing seen yet) is older than every version.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} Negative when a is older, positive when newer, 0 when equal
 */
export function compareVersions(a, b) {
  const parts = (version) => (VERSION.test(String(version)) ? String(version).split('.').map(Number) : null);
  const pa = parts(a);
  const pb = parts(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** Keeps the sections and items that are well formed, in their order. */
function normalizeSections(sections) {
  return (Array.isArray(sections) ? sections : []).flatMap((section) => {
    if (!CATEGORIES.includes(section?.type)) return [];
    const items = (Array.isArray(section.items) ? section.items : [])
      .filter((item) => typeof item?.text === 'string' && item.text.trim())
      .map((item) => ({ text: item.text.trim(), highlight: item.highlight === true }));
    return items.length ? [{ type: section.type, items }] : [];
  });
}

/**
 * Checks the generated release notes, keeping the releases, sections, and items that are well
 * formed. The generator checks CHANGELOG.md thoroughly; this only guards the page against a
 * damaged or hand-edited file.
 *
 * @param {unknown} data
 * @returns {Array<{ version: string, date: string, sections: Array<{ type: string, items: Array<{ text: string, highlight: boolean }> }> }>}
 */
export function normalizeReleases(data) {
  const releases = Array.isArray(data?.releases) ? data.releases : [];
  return releases.flatMap((release) => {
    if (!VERSION.test(release?.version) || !DATE.test(release?.date)) return [];
    const sections = normalizeSections(release.sections);
    return sections.length ? [{ version: release.version, date: release.date, sections }] : [];
  });
}

/**
 * Checks a generated file: its releases, and its unreleased changes, which only the development
 * output can have (a release file's are ignored, whatever it says).
 *
 * @param {unknown} data
 * @returns {{ releases: Array<object>, unreleased: { sections: Array<object> } | null }}
 */
export function normalizeChangelog(data) {
  const sections = data?.channel === 'development' ? normalizeSections(data.unreleased?.sections) : [];
  return { releases: normalizeReleases(data), unreleased: sections.length ? { sections } : null };
}

/**
 * Reads the generated release notes.
 *
 * @param {(url: URL) => Promise<Response>} [fetchFn]
 * @param {URL | string} [url]
 * @returns {Promise<{ releases: Array<object>, unreleased: { sections: Array<object> } | null } | null>}
 *   The releases, newest first, and (development output only) the unreleased changes; null when the
 *   file can't be read: an unpacked copy where `npm run changelog` wasn't run, or a damaged file
 */
export async function loadChangelog(fetchFn = globalThis.fetch, url = CHANGELOG_URL) {
  try {
    const response = await fetchFn(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return normalizeChangelog(await response.json());
  } catch (err) {
    console.warn('Could not read the release notes (src/changelog/changelog.json; run npm run changelog for an unpacked copy):', err);
    return null;
  }
}

/**
 * A release's highlights: the items marked in CHANGELOG.md, in the order shown.
 * @param {{ sections: Array<{ items: Array<{ text: string, highlight: boolean }> }> }} release
 * @returns {string[]}
 */
export function releaseHighlights(release) {
  return release.sections.flatMap((section) => section.items).filter((item) => item.highlight).map((item) => item.text);
}

/**
 * The release to announce, or null: the installed version's release, when no announcement was
 * shown for it (or a newer one) yet, and its notes haven't been read in the Changelog already.
 *
 * @param {Array<{ version: string }>} releases
 * @param {{ lastAnnouncedVersion: string, lastReadVersion: string } | null} state - From resolve();
 *   null shows nothing
 * @param {string | undefined} version - The installed version (the manifest's)
 * @returns {object | null}
 */
export function announcementFor(releases, state, version) {
  if (!state || !version) return null;
  const release = releases.find((entry) => entry.version === version);
  return release && compareVersions(version, state.lastAnnouncedVersion) > 0 &&
    compareVersions(version, state.lastReadVersion) > 0 ? release : null;
}

/**
 * True while the newest release hasn't been seen in the Changelog drawer: the NEW badge.
 * @param {Array<{ version: string }>} releases - Newest first
 * @param {{ lastReadVersion: string } | null} state
 * @returns {boolean}
 */
export function hasUnreadRelease(releases, state) {
  return Boolean(state && releases[0] && compareVersions(releases[0].version, state.lastReadVersion) > 0);
}

/**
 * @param {{ get: Function, set: Function }} storageArea - storage.local, or createMemoryStorageArea()
 */
export function createChangelogStateStore(storageArea) {
  const text = (value) => (typeof value === 'string' ? value : '');

  /** The stored state, or null when nothing was ever recorded. */
  async function load() {
    const stored = await storageArea.get([LAST_ANNOUNCED_KEY, LAST_READ_KEY]);
    if (!(LAST_ANNOUNCED_KEY in stored) && !(LAST_READ_KEY in stored)) return null;
    return { lastAnnouncedVersion: text(stored[LAST_ANNOUNCED_KEY]), lastReadVersion: text(stored[LAST_READ_KEY]) };
  }

  /** Records `version` under `key`, unless a newer one is recorded already. */
  async function raise(key, version) {
    const { [key]: recorded } = await storageArea.get([key]);
    if (compareVersions(version, text(recorded)) > 0) await storageArea.set({ [key]: version });
  }

  return {
    load,

    /**
     * A fresh install: its version counts as announced and read, so neither shows.
     * @param {string} version
     */
    async recordInstall(version) {
      await storageArea.set({ [LAST_ANNOUNCED_KEY]: version, [LAST_READ_KEY]: version });
    },

    /**
     * The state the page decides from. With nothing recorded, the extension was either just
     * installed and the background couldn't record it (nothing else is stored: recorded now, as a
     * fresh install), or updated from a version before the Changelog (the user's data is there:
     * nothing has been seen, and nothing is written).
     *
     * @param {string | undefined} version - The installed version; without one (outside the
     *   extension), there's nothing to decide
     * @returns {Promise<{ lastAnnouncedVersion: string, lastReadVersion: string } | null>}
     */
    async resolve(version) {
      if (!version) return null;
      const state = await load();
      if (state) return state;
      const everything = await storageArea.get(null);
      if (Object.keys(everything ?? {}).length === 0) {
        await this.recordInstall(version);
        return { lastAnnouncedVersion: version, lastReadVersion: version };
      }
      return { lastAnnouncedVersion: '', lastReadVersion: '' };
    },

    /** The update announcement for `version` has been shown. */
    markAnnounced: (version) => raise(LAST_ANNOUNCED_KEY, version),

    /** The release notes up to `version` have been shown in the Changelog drawer. */
    markRead: (version) => raise(LAST_READ_KEY, version)
  };
}
