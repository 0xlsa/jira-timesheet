import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDocument, toHtml } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import {
  openChangelogDrawer,
  renderRelease,
  DRAWER_TITLE,
  CATEGORY_LABELS,
  LOADING_MESSAGE,
  UNAVAILABLE_MESSAGE,
  EMPTY_MESSAGE,
  UNRELEASED_TITLE,
  UNRELEASED_NOTE
} from '../src/ui/changelogDrawer.js';
import { CATEGORIES } from '../src/changelog/changelogState.js';
import { showUpdateAnnouncement, hideUpdateAnnouncement, isUpdateAnnouncementShown, MAX_ANNOUNCED_HIGHLIGHTS } from '../src/ui/updateAnnouncement.js';

const HOSTILE = '<img src=x onerror=alert(1)>';

const release = (version, date, text, highlight = false) => ({ version, date, sections: [{ type: 'Added', items: [{ text, highlight }] }] });

const RELEASES = [
  { version: '1.2.0', date: '2026-11-10', sections: [
    { type: 'Added', items: [{ text: 'Timers you can pause', highlight: true }, { text: 'A calendar', highlight: false }] },
    { type: 'Changed', items: [{ text: 'Faster week loading', highlight: false }] },
    { type: 'Fixed', items: [{ text: 'A dialog closing itself', highlight: true }] },
    { type: 'Security', items: [{ text: 'Tokens are masked when the tab is hidden', highlight: false }] }
  ] },
  release('1.1.0', '2026-10-31', 'Settings in a drawer', true),
  release('1.0.0', '2026-10-27', 'The first release')
];

const UNRELEASED = { sections: [{ type: 'Added', items: [{ text: 'Custom views', highlight: true }] }, { type: 'Fixed', items: [{ text: 'A typo', highlight: false }] }] };

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** True when `node` or anything below it is an element that only markup could have created. */
const hasInjectedElements = (node) => [node, ...node.descendants].some((el) => ['img', 'script'].includes(el.localName));

const latestOf = (root) => root.querySelector('.changelog-release.is-latest');
const unreleasedOf = (root) => root.querySelector('.changelog-release.is-unreleased');
const listOf = (root) => root.querySelector('#changelogList');

describe('What\'s New drawer', () => {
  let restoreDocument;
  beforeEach(() => {
    restoreDocument = installFakeDocument();
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    mock.timers.reset();
    restoreDocument();
  });

  /**
   * Opens the drawer with release notes: `releases` (and `unreleased`, the development preview), or
   * `load`, a function standing in for loadChangelog(). `frames` collects the callbacks waiting for
   * the next frame, so a test decides when what was drawn reaches the screen.
   */
  function open({ releases = RELEASES, unreleased = null, load } = {}) {
    const root = h('aside', { class: 'changelog-drawer hidden' });
    const read = [];
    const closed = [];
    const frames = [];
    const drawer = openChangelogDrawer(root, {
      loadChangelog: load ?? (async () => ({ releases, unreleased })),
      onRead: (version) => read.push(version),
      onClose: () => closed.push(true),
      afterRender: (callback) => frames.push(callback)
    });
    const nextFrame = () => frames.splice(0).forEach((callback) => callback());
    return { root, drawer, read, closed, nextFrame };
  }

  it('opens titled What\'s New, with focus on the release notes while they load', () => {
    const { root } = open({ load: () => new Promise(() => {}) });
    assert.equal(DRAWER_TITLE, "What's New");
    assert.equal(root.classList.contains('hidden'), false);
    assert.equal(root.getAttribute('aria-labelledby'), 'changelogTitle');
    assert.equal(root.querySelector('#changelogTitle').textContent, "What's New");
    assert.equal(root.querySelector('[data-action="close-changelog"]').getAttribute('aria-label'), "Close What's New");
    assert.equal(listOf(root).getAttribute('aria-label'), 'Release notes');
    assert.equal(document.activeElement, listOf(root));
    assert.equal(listOf(root).getAttribute('aria-busy'), 'true');
    assert.equal(root.querySelector('.changelog-message').textContent, LOADING_MESSAGE);
    assert.doesNotMatch(root.textContent, /Changelog/, 'no developer wording on screen');
  });

  it('shows the latest release at once, in full: version, date, and its changes under user-friendly labels', async () => {
    const { root } = open();
    await flush();
    const latest = latestOf(root);
    assert.equal(latest.dataset.version, '1.2.0');
    assert.equal(listOf(root).childNodes[0], latest, 'first in the drawer');
    assert.equal(latest.querySelector('h3.changelog-version').textContent, 'Version 1.2.0');
    assert.equal(latest.querySelector('.changelog-latest').textContent, 'Latest');
    const date = latest.querySelector('.changelog-date');
    assert.deepEqual([date.getAttribute('datetime'), date.textContent], ['2026-11-10', '10 November 2026']);
    assert.deepEqual(latest.querySelectorAll('h4.changelog-category').map((el) => el.textContent),
      ['New features', 'Improvements', 'Bug fixes', 'Security updates']);
    assert.deepEqual(latest.querySelectorAll('li').map((el) => el.textContent), [
      'Highlight: Timers you can pause', 'A calendar', 'Faster week loading', 'Highlight: A dialog closing itself',
      'Tokens are masked when the tab is hidden'
    ]);
    assert.equal(listOf(root).hasAttribute('aria-busy'), false);
  });

  it('labels every CHANGELOG.md category the same way, wherever it appears', () => {
    assert.deepEqual(Object.keys(CATEGORY_LABELS), CATEGORIES);
    assert.deepEqual(CATEGORY_LABELS, {
      Added: 'New features', Changed: 'Improvements', Deprecated: 'Deprecated', Removed: 'Removed',
      Fixed: 'Bug fixes', Security: 'Security updates'
    });
  });

  it('shows only the categories with entries', () => {
    const section = renderRelease({ version: '1.2.0', date: '2026-11-10', sections: [
      { type: 'Added', items: [] }, { type: 'Fixed', items: [{ text: 'A fix', highlight: false }] }
    ] });
    assert.deepEqual(section.querySelectorAll('.changelog-category').map((el) => el.textContent), ['Bug fixes']);
  });

  it('marks the latest release\'s highlights, with a star and words for screen readers', async () => {
    const { root } = open();
    await flush();
    const items = latestOf(root).querySelectorAll('li');
    assert.deepEqual(items.map((li) => li.classList.contains('is-highlight')), [true, false, false, true, false]);
    for (const li of items.filter((el) => el.classList.contains('is-highlight'))) {
      assert.equal(li.querySelector('.changelog-highlight-icon').getAttribute('aria-hidden'), 'true');
      assert.equal(li.querySelector('.sr-only').textContent, 'Highlight: ');
    }
  });

  it('shows only the latest release: no older release, no Previous releases, and nothing to expand', async () => {
    const { root } = open();
    await flush();
    assert.deepEqual(listOf(root).childNodes.map((node) => node.localName), ['section'], 'just the latest release, no stray text');
    assert.deepEqual(root.querySelectorAll('.changelog-release').map((el) => el.dataset.version), ['1.2.0']);
    assert.equal(root.querySelector('[data-version="1.1.0"], [data-version="1.0.0"]'), null);
    assert.doesNotMatch(root.textContent, /Settings in a drawer|The first release|Previous releases|1\.1\.x/);
    assert.equal(root.querySelector('[aria-expanded]'), null, 'no history to expand or collapse');
  });

  it('counts the latest release as read only once it has been drawn and reached the screen', async () => {
    const { read, nextFrame } = open();
    assert.deepEqual(read, [], 'not while loading');
    await flush();
    assert.deepEqual(read, [], 'not before the frame that shows it');
    nextFrame();
    assert.deepEqual(read, ['1.2.0']);
    nextFrame();
    assert.deepEqual(read, ['1.2.0'], 'once');
  });

  it('reads nothing when the drawer closes before the release notes are on screen', async () => {
    const first = open();
    await flush();
    first.drawer.close();
    first.nextFrame();
    assert.deepEqual(first.read, []);

    let resolve;
    const second = open({ load: () => new Promise((r) => { resolve = r; }) });
    second.drawer.close();
    await flush();
    resolve({ releases: RELEASES, unreleased: null });
    await flush();
    second.nextFrame();
    assert.deepEqual(second.read, []);
  });

  it('says the release notes couldn\'t be loaded, and reads nothing', async () => {
    for (const load of [async () => null, async () => { throw new Error('boom'); }]) {
      const { root, read, nextFrame } = open({ load });
      await flush();
      nextFrame();
      assert.equal(root.querySelector('.changelog-message').textContent, UNAVAILABLE_MESSAGE);
      assert.equal(root.querySelector('.changelog-message').getAttribute('role'), 'status');
      assert.equal(latestOf(root), null);
      assert.deepEqual(read, []);
    }
  });

  it('says when there are no releases yet, and reads nothing', async () => {
    const { root, read, nextFrame } = open({ releases: [] });
    await flush();
    nextFrame();
    assert.equal(root.querySelector('.changelog-message').textContent, EMPTY_MESSAGE);
    assert.deepEqual(read, []);
  });

  it('closes with its close button or Escape, once, and slides out', async () => {
    const { root, drawer, closed } = open();
    root.querySelector('[data-action="close-changelog"]').click();
    assert.deepEqual(closed, [true]);
    assert.equal(drawer.isOpen, false);
    assert.equal(root.hasAttribute('inert'), true);
    root.querySelector('.changelog-drawer-body').dispatchEvent({ type: 'keydown', key: 'Escape' });
    drawer.close();
    assert.deepEqual(closed, [true]);
    mock.timers.tick(200);
    assert.equal(root.classList.contains('hidden'), true);
    assert.equal(root.childNodes.length, 0);

    const again = open();
    listOf(again.root).dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.deepEqual(again.closed, [true]);
  });

  it('closes with Escape from inside the release notes too', async () => {
    const { root, closed } = open();
    await flush();
    latestOf(root).querySelector('li').dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.deepEqual(closed, [true]);
  });

  it('shows release notes as text, never as markup', async () => {
    const hostile = { version: '1.0.0', date: '2026-10-27', sections: [{ type: 'Added', items: [{ text: HOSTILE, highlight: true }] }] };
    const { root } = open({ releases: [hostile], unreleased: { sections: hostile.sections } });
    await flush();
    assert.deepEqual(root.querySelectorAll('.changelog-items').map((ul) => ul.querySelector('li').textContent), [HOSTILE, `Highlight: ${HOSTILE}`]);
    assert.equal(hasInjectedElements(root), false);
    assert.match(toHtml(renderRelease(hostile)), /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});

describe('What\'s New drawer - sub-items', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  const VIEWS = {
    text: 'Custom views in My Work: create your own Jira issue views.', highlight: false,
    subitems: ['Create up to five custom views.', 'Reorder tabs by dragging.']
  };

  async function openWith(items, { unreleased = false } = {}) {
    const root = h('aside', { class: 'changelog-drawer hidden' });
    const notes = { version: '1.2.0', date: '2026-11-10', sections: [{ type: 'Added', items }] };
    openChangelogDrawer(root, {
      loadChangelog: async () => (unreleased ? { releases: RELEASES, unreleased: { sections: notes.sections } } : { releases: [notes], unreleased: null }),
      onRead() {}, onClose() {}, afterRender: () => {}
    });
    await flush();
    return root;
  }

  it('lists an item\'s sub-items under its text, as a nested list', async () => {
    const root = await openWith([VIEWS, { text: 'Another', highlight: false }]);
    const [first, second] = root.querySelector('.changelog-items').children;
    const nested = first.querySelector('.changelog-subitems');
    assert.equal(nested.localName, 'ul');
    assert.deepEqual(nested.children.map((li) => li.textContent), VIEWS.subitems);
    assert.equal(first.textContent.startsWith(VIEWS.text), true, 'the item\'s text first, then its list');
    assert.equal(second.querySelector('.changelog-subitems'), null);
  });

  it('keeps a highlight\'s star on its item, never on its sub-items', async () => {
    const root = await openWith([{ ...VIEWS, highlight: true }]);
    const item = root.querySelector('.changelog-items').children[0];
    assert.ok(item.classList.contains('is-highlight'));
    assert.equal(item.querySelectorAll('.changelog-highlight-icon').length, 1);
    assert.equal(item.querySelector('.changelog-subitems').querySelectorAll('.changelog-highlight-icon').length, 0);
  });

  it('lists sub-items in the development preview too', async () => {
    const root = await openWith([VIEWS], { unreleased: true });
    assert.deepEqual(unreleasedOf(root).querySelector('.changelog-subitems').children.map((li) => li.textContent), VIEWS.subitems);
  });

  it('shows sub-items as text, never as markup', async () => {
    const root = await openWith([{ ...VIEWS, subitems: [HOSTILE] }]);
    assert.equal(hasInjectedElements(root), false);
    assert.match(toHtml(root), /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});

describe('What\'s New drawer - development preview of unreleased changes', () => {
  let restoreDocument;
  beforeEach(() => {
    restoreDocument = installFakeDocument();
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    mock.timers.reset();
    restoreDocument();
  });

  function open({ releases = RELEASES, unreleased = UNRELEASED } = {}) {
    const root = h('aside', { class: 'changelog-drawer hidden' });
    const read = [];
    const frames = [];
    openChangelogDrawer(root, {
      loadChangelog: async () => ({ releases, unreleased }),
      onRead: (version) => read.push(version),
      onClose: () => {},
      afterRender: (callback) => frames.push(callback)
    });
    return { root, read, nextFrame: () => frames.splice(0).forEach((callback) => callback()) };
  }

  it('shows the unreleased changes first, as What\'s New — Unreleased with its explanation, above the latest release', async () => {
    const { root } = open();
    await flush();
    const [preview, latest] = listOf(root).childNodes;
    assert.ok(preview.classList.contains('is-unreleased'));
    assert.equal(UNRELEASED_TITLE, "What's New — Unreleased");
    assert.equal(preview.querySelector('h3').textContent, "What's New — Unreleased");
    assert.equal(preview.getAttribute('aria-labelledby'), 'changelogUnreleased');
    assert.equal(UNRELEASED_NOTE, 'These changes are currently in development and are not yet part of a published release.');
    assert.equal(preview.querySelector('.changelog-unreleased-note').textContent, UNRELEASED_NOTE);
    assert.deepEqual(preview.querySelectorAll('h4.changelog-category').map((el) => el.textContent), ['New features', 'Bug fixes']);
    assert.deepEqual(preview.querySelectorAll('li').map((el) => el.textContent), ['Custom views', 'A typo']);
    assert.ok(latest.classList.contains('is-latest'));
    assert.equal(latest.dataset.version, '1.2.0');
    assert.equal(listOf(root).childNodes.length, 2, 'still no older releases');
  });

  it('never presents the preview as a release: no version, date, Latest label, or highlight marks', async () => {
    const { root } = open();
    await flush();
    const preview = unreleasedOf(root);
    assert.equal(preview.hasAttribute('data-version'), false);
    assert.equal(preview.querySelector('.changelog-date, .changelog-latest, .is-highlight, .changelog-highlight-icon'), null);
    assert.equal(root.querySelectorAll('.changelog-latest').length, 1);
  });

  it('reads only the latest release, never the preview', async () => {
    const { read, nextFrame } = open();
    await flush();
    nextFrame();
    assert.deepEqual(read, ['1.2.0']);
  });

  it('with no release yet, shows the preview and says there are no releases, reading nothing', async () => {
    const { root, read, nextFrame } = open({ releases: [] });
    await flush();
    nextFrame();
    assert.ok(unreleasedOf(root));
    assert.equal(root.querySelector('.changelog-message').textContent, EMPTY_MESSAGE);
    assert.deepEqual(read, []);
  });

  it('shows no preview without unreleased changes (the release output)', async () => {
    const { root } = open({ unreleased: null });
    await flush();
    assert.equal(unreleasedOf(root), null);
    assert.equal(listOf(root).childNodes[0], latestOf(root));
  });
});

describe('Update announcement', () => {
  let restoreDocument;
  beforeEach(() => {
    restoreDocument = installFakeDocument();
  });
  afterEach(() => restoreDocument());

  function show({ highlights = ['Timers you can pause', 'A dialog closing itself'] } = {}) {
    const root = h('section', { id: 'updateAnnouncement', class: 'update-announcement hidden' });
    const calls = [];
    showUpdateAnnouncement(root, {
      release: RELEASES[0],
      highlights,
      onExplore: () => calls.push(['explore', isUpdateAnnouncementShown(root)]),
      onDismiss: () => calls.push(['dismiss', isUpdateAnnouncementShown(root)])
    });
    return { root, calls };
  }

  const highlightsOf = (root) => root.querySelector('.update-announcement-highlights')?.querySelectorAll('li').map((el) => el.textContent) ?? [];

  it('is titled What\'s New in vX.Y.Z, with the new version\'s highlights, Explore updates, and a close button', () => {
    const { root } = show();
    assert.equal(isUpdateAnnouncementShown(root), true);
    assert.equal(root.querySelector('h4').textContent, "What's New in v1.2.0");
    assert.equal(root.getAttribute('aria-labelledby'), 'updateAnnouncementTitle');
    assert.deepEqual(highlightsOf(root), ['Timers you can pause', 'A dialog closing itself']);
    assert.deepEqual(root.querySelectorAll('button').map((el) => el.getAttribute('aria-label') || el.textContent),
      ['Explore updates', 'Close the update announcement']);
  });

  it('lists at most three highlights, and never the release history', () => {
    assert.equal(MAX_ANNOUNCED_HIGHLIGHTS, 3);
    const { root } = show({ highlights: ['One', 'Two', 'Three', 'Four'] });
    assert.deepEqual(highlightsOf(root), ['One', 'Two', 'Three']);
    assert.doesNotMatch(root.textContent, /1\.1\.0|1\.0\.0|Settings in a drawer|The first release/);
  });

  it('leaves the list out without highlights', () => {
    const { root } = show({ highlights: [] });
    assert.equal(root.querySelector('.update-announcement-highlights'), null);
  });

  it('never takes focus', () => {
    const before = document.activeElement;
    show();
    assert.equal(document.activeElement, before);
  });

  it('Explore updates hides it, then opens What\'s New', () => {
    const { root, calls } = show();
    root.querySelector('[data-action="explore-changelog"]').click();
    assert.deepEqual(calls, [['explore', false]]);
    assert.equal(isUpdateAnnouncementShown(root), false);
    assert.equal(root.childNodes.length, 0);
  });

  it('the close button only hides it', () => {
    const { root, calls } = show();
    root.querySelector('.update-announcement-close').click();
    assert.deepEqual(calls, [['dismiss', false]]);
    assert.equal(isUpdateAnnouncementShown(root), false);
  });

  it('can be hidden from outside, without any callback', () => {
    const { root, calls } = show();
    hideUpdateAnnouncement(root);
    assert.equal(isUpdateAnnouncementShown(root), false);
    assert.equal(root.hasAttribute('aria-labelledby'), false);
    assert.deepEqual(calls, []);
  });

  it('shows highlights as text, never as markup', () => {
    const { root } = show({ highlights: [HOSTILE] });
    assert.deepEqual(highlightsOf(root), [HOSTILE]);
    assert.equal(hasInjectedElements(root), false);
  });
});
