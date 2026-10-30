import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installFakeDocument } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import { ABOUT_INFO_URL, loadAboutInfo, renderAboutSection } from '../src/ui/aboutSection.js';
import { createPlatform } from '../src/compat/browser-api.js';

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

/** A fetch that answers like the browser does for a packaged file. */
const fetchJson = (body, { ok = true } = {}) => async () => ({ ok, json: async () => body });

const INFO = { developer: '0xlsa', developerUrl: 'https://github.com/0xlsa', repositoryUrl: 'https://github.com/0xlsa/jira-timesheet' };

describe('loadAboutInfo', () => {
  it('reads the packaged src/about/about.json', async () => {
    const requested = [];
    const fromDisk = async (url) => {
      requested.push(url);
      return { ok: true, json: async () => JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) };
    };
    assert.deepEqual(await loadAboutInfo(fromDisk), INFO);
    assert.equal(fileURLToPath(requested[0]), fileURLToPath(new URL('../src/about/about.json', import.meta.url)));
    assert.equal(requested[0], ABOUT_INFO_URL);
  });

  it('drops links that are not HTTPS', async () => {
    const info = await loadAboutInfo(fetchJson({ developer: ' dev ', developerUrl: 'javascript:alert(1)', repositoryUrl: 'http://example.com' }));
    assert.deepEqual(info, { developer: 'dev', developerUrl: '', repositoryUrl: '' });
  });

  it('comes back empty when the file cannot be read', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const empty = { developer: '', developerUrl: '', repositoryUrl: '' };
    assert.deepEqual(await loadAboutInfo(fetchJson(null, { ok: false })), empty);
    assert.deepEqual(await loadAboutInfo(async () => { throw new Error('offline'); }), empty);
    assert.deepEqual(await loadAboutInfo(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } })), empty);
  });
});

describe('renderAboutSection', () => {
  let restoreDocument;
  beforeEach(() => { restoreDocument = installFakeDocument(); });
  afterEach(() => restoreDocument());

  const render = (options) => {
    const root = h('section', { id: 'aboutSection' });
    renderAboutSection(root, options);
    return root;
  };

  it('shows the manifest name and version and links to the developer and repository', () => {
    const root = render({ manifest: { name: 'Timesheet for Jira', version: '1.2.3' }, info: INFO });

    assert.equal(root.querySelector('#aboutTitle').textContent, 'About');
    assert.equal(root.querySelector('.settings-about-version').textContent, 'Timesheet for Jira · v1.2.3');

    const [profile, source] = root.querySelectorAll('a');
    assert.equal(profile.getAttribute('href'), 'https://github.com/0xlsa');
    assert.match(profile.textContent, /^@0xlsa/);
    assert.equal(profile.parentNode.textContent.startsWith('Developed by @0xlsa'), true);
    assert.equal(source.getAttribute('href'), 'https://github.com/0xlsa/jira-timesheet');
    assert.match(source.textContent, /^View source on GitHub ↗/);

    for (const link of [profile, source]) {
      assert.equal(link.getAttribute('target'), '_blank');
      assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(link.querySelector('.sr-only').textContent, ' (opens in a new tab)');
    }
    const [icon, arrow] = source.querySelectorAll('[aria-hidden="true"]');
    assert.equal(icon.tagName.toLowerCase(), 'svg');
    assert.equal(source.childNodes[0], icon);
    assert.equal(icon.getAttribute('class'), 'settings-about-icon');
    assert.equal(arrow.textContent, ' ↗');
    assert.equal(profile.querySelector('svg'), null);
  });

  it('leaves out what it does not know', () => {
    const root = render({ manifest: null, info: { developer: '', developerUrl: '', repositoryUrl: '' } });
    assert.equal(root.querySelector('.settings-about-version').textContent, 'Timesheet for Jira');
    assert.equal(root.querySelectorAll('a').length, 0);
    assert.equal(root.querySelectorAll('p').length, 1);
  });

  it('names the developer without a link when there is no profile URL', () => {
    const root = render({ manifest: { name: 'Timesheet for Jira', version: '1.0.0' }, info: { ...INFO, developerUrl: '' } });
    assert.equal(root.querySelectorAll('a').length, 1);
    assert.equal(root.querySelectorAll('p')[1].textContent, 'Developed by @0xlsa');
  });
});

describe('About metadata', () => {
  it('reads the version from the browser manifest', () => {
    const platform = createPlatform({ storage: { local: {} }, runtime: { getManifest: () => ({ version: '9.9.9' }) } });
    assert.equal(platform.getManifest().version, '9.9.9');
    assert.equal(createPlatform(null, {}).getManifest(), null);
  });

  it('keeps the version out of about.json and the manifest links in step with it', () => {
    const about = readJson('../src/about/about.json');
    const manifest = readJson('../manifest.json');
    assert.equal('version' in about, false);
    assert.equal(manifest.homepage_url, about.repositoryUrl);
    assert.deepEqual(manifest.developer, { name: about.developer, url: about.developerUrl });
  });

  it('puts the About section after the Connection Settings form', () => {
    const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
    const formEnd = html.indexOf('</form>');
    const about = html.indexOf('id="aboutSection"');
    assert.ok(formEnd > 0 && about > formEnd && about < html.indexOf('id="shortcutsDrawer"'));
  });
});
