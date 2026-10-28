import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSettingsStore } from '../src/settings/settingsStore.js';
import { createSettingsDraft, switchDraftEdition } from '../src/settings/settingsDraft.js';
import { createMemoryStorageArea } from '../src/compat/browser-api.js';

const CLOUD_URL = 'https://acme.atlassian.net';
const SERVER_URL = 'https://jira.example.com';

/** A store holding a saved Data Center / Server configuration, with Cloud values kept too. */
async function savedServerStore(storage = createMemoryStorageArea()) {
  const store = createSettingsStore(storage);
  await store.save({
    deploymentType: 'server',
    email: 'me@example.com',
    baseUrlsByType: { cloud: CLOUD_URL, server: SERVER_URL },
    tokensByType: { cloud: 'api-token', server: 'pat' }
  });
  return store;
}

describe('Settings draft - unsaved Connection Settings values', () => {
  it('starts from the saved Data Center / Server configuration', async () => {
    const draft = createSettingsDraft(await (await savedServerStore()).load());
    assert.equal(draft.deploymentType, 'server');
    assert.deepEqual(draft.baseUrlsByType, { cloud: CLOUD_URL, server: SERVER_URL });
    assert.deepEqual(draft.tokensByType, { cloud: 'api-token', server: 'pat' });
    assert.equal(draft.email, 'me@example.com');
  });

  it('starts from a saved Cloud configuration, and from defaults when nothing is saved', async () => {
    const store = createSettingsStore(createMemoryStorageArea());
    assert.equal(createSettingsDraft(await store.load()).deploymentType, 'cloud');
    await store.save({ deploymentType: 'cloud', email: 'me@example.com', baseUrlsByType: { cloud: CLOUD_URL, server: '' }, tokensByType: { cloud: 'api-token', server: '' } });
    const draft = createSettingsDraft(await store.load());
    assert.equal(draft.deploymentType, 'cloud');
    assert.equal(draft.baseUrlsByType.cloud, CLOUD_URL);
  });

  it('switching to Cloud changes only the draft: the saved settings and the store keep Data Center / Server', async () => {
    const store = await savedServerStore();
    const saved = await store.load();
    const draft = createSettingsDraft(saved);

    const shown = switchDraftEdition(draft, 'cloud', { baseUrl: SERVER_URL, token: 'pat' });
    assert.deepEqual(shown, { baseUrl: CLOUD_URL, token: 'api-token' });
    assert.equal(draft.deploymentType, 'cloud');

    assert.equal(saved.deploymentType, 'server');
    assert.deepEqual(saved.baseUrlsByType, { cloud: CLOUD_URL, server: SERVER_URL });
    assert.equal((await store.load()).deploymentType, 'server');
  });

  it('closing without saving and reopening: a new draft from the saved settings discards the changes', async () => {
    const store = await savedServerStore();
    const saved = await store.load();
    const draft = createSettingsDraft(saved);
    switchDraftEdition(draft, 'cloud', { baseUrl: 'https://edited.example.com', token: 'edited' });
    draft.baseUrlsByType.cloud = 'https://typed.atlassian.net';

    const reopened = createSettingsDraft(saved);
    assert.equal(reopened.deploymentType, 'server');
    assert.deepEqual(reopened.baseUrlsByType, { cloud: CLOUD_URL, server: SERVER_URL });
    assert.deepEqual(reopened.tokensByType, { cloud: 'api-token', server: 'pat' });
  });

  it('keeps each edition\'s values when switching back and forth', () => {
    const draft = createSettingsDraft({ deploymentType: 'server', email: '', baseUrlsByType: { cloud: CLOUD_URL, server: SERVER_URL }, tokensByType: { cloud: 'api-token', server: 'pat' } });
    switchDraftEdition(draft, 'cloud', { baseUrl: 'https://jira2.example.com', token: 'pat2' });
    const back = switchDraftEdition(draft, 'server', { baseUrl: CLOUD_URL, token: 'api-token' });
    assert.deepEqual(back, { baseUrl: 'https://jira2.example.com', token: 'pat2' }, 'the values typed for Data Center / Server');
    assert.deepEqual(draft.baseUrlsByType, { cloud: CLOUD_URL, server: 'https://jira2.example.com' });
  });

  it('saving the draft makes the new edition active and keeps the other edition\'s saved values', async () => {
    const store = await savedServerStore();
    const draft = createSettingsDraft(await store.load());
    switchDraftEdition(draft, 'cloud', { baseUrl: SERVER_URL, token: 'pat' });

    await store.save(draft);
    const saved = await store.load();
    assert.equal(saved.deploymentType, 'cloud');
    assert.equal(saved.jiraBaseUrl, CLOUD_URL);
    assert.equal(saved.token, 'api-token');
    assert.deepEqual(saved.baseUrlsByType, { cloud: CLOUD_URL, server: SERVER_URL });
    assert.equal(createSettingsDraft(saved).deploymentType, 'cloud', 'the drawer reopens on the new edition');
  });

  it('a failed save leaves the saved configuration as it was', async () => {
    const storage = createMemoryStorageArea();
    const store = await savedServerStore(storage);
    const draft = createSettingsDraft(await store.load());
    switchDraftEdition(draft, 'cloud', { baseUrl: SERVER_URL, token: 'pat' });

    storage.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
    await assert.rejects(store.save(draft), /quota/);
    const saved = await store.load();
    assert.equal(saved.deploymentType, 'server');
    assert.equal(saved.jiraBaseUrl, SERVER_URL);
    assert.equal(createSettingsDraft(saved).deploymentType, 'server');
  });
});

describe('Settings draft - options page wiring', () => {
  const script = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
  const fn = (name) => script.slice(script.indexOf(`function ${name}(`), script.indexOf('\n}\n', script.indexOf(`function ${name}(`)));

  it('refills the form from the saved settings each time the drawer opens', () => {
    assert.match(fn('openSettings'), /if \(savedSettings\) fillSettingsForm\(savedSettings\);/);
    assert.match(fn('fillSettingsForm'), /settingsDraft = createSettingsDraft\(settings\)/);
  });

  it('switches edition in the draft only, and updates the saved settings only after a successful save', () => {
    assert.match(fn('switchDeploymentType'), /switchDraftEdition\(settingsDraft, type/);
    assert.doesNotMatch(fn('switchDeploymentType'), /settingsStore|savedSettings/);
    const save = fn('onSaveSettings');
    assert.ok(save.indexOf('await settingsStore.save(') < save.indexOf('savedSettings = await settingsStore.load()'));
    assert.ok(save.indexOf('savedSettings = await settingsStore.load()') < save.indexOf('} catch (err) {'));
  });
});
