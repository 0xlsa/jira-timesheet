import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDocument } from './support/fakeDom.js';
import { h } from '../src/ui/dom.js';
import { createShortcutRegistry, groupShortcuts, isTypingTarget, detectPlatform, SHORTCUT_CATEGORIES } from '../src/ui/shortcuts.js';
import { WORKLOG_FORM_SHORTCUTS } from '../src/ui/worklogEditor.js';
import { ISSUE_PICKER_SHORTCUTS } from '../src/ui/issuePicker.js';

/** A keydown event as the browser would send it; records preventDefault(). */
const keydown = (key, init = {}) => ({
  type: 'keydown', key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, repeat: false, isComposing: false,
  defaultPrevented: false, target: null, ...init,
  preventDefault() { this.defaultPrevented = true; }
});

describe('Shortcuts - registry', () => {
  let restoreDocument;
  before(() => {
    restoreDocument = installFakeDocument();
  });
  after(() => restoreDocument());

  it('runs a registered shortcut on its character, from either keyboard, and prevents the default', () => {
    const shortcuts = createShortcutRegistry();
    const ran = [];
    shortcuts.register({ id: 'log', key: '+', keys: [['+']], description: 'Log work', category: 'Worklogs', handler: () => ran.push('+') });
    shortcuts.register({ id: 'help', key: '?', keys: [['?']], description: 'Help', category: 'General', handler: () => ran.push('?') });

    const page = h('main', {});
    const shiftEqual = keydown('+', { shiftKey: true, code: 'Equal', target: page });
    assert.equal(shortcuts.handleKeydown(shiftEqual), true);
    assert.equal(shiftEqual.defaultPrevented, true);
    assert.equal(shortcuts.handleKeydown(keydown('+', { code: 'NumpadAdd', target: page })), true);
    // `?` by its character: Shift+/ on a US layout, a key of its own elsewhere.
    assert.equal(shortcuts.handleKeydown(keydown('?', { shiftKey: true, code: 'Slash', target: page })), true);
    assert.equal(shortcuts.handleKeydown(keydown('?', { code: 'Minus', target: page })), true);
    assert.deepEqual(ran, ['+', '+', '?', '?']);
  });

  it('leaves browser shortcuts, held-down keys, composition, other keys, and handled events alone', () => {
    const shortcuts = createShortcutRegistry();
    let runs = 0;
    shortcuts.register({ id: 'log', key: '+', keys: [['+']], description: 'Log work', category: 'Worklogs', handler: () => runs++ });
    const page = h('main', {});

    for (const event of [
      keydown('+', { ctrlKey: true, target: page }),
      keydown('+', { metaKey: true, target: page }),
      keydown('+', { altKey: true, target: page }),
      keydown('+', { repeat: true, target: page }),
      keydown('+', { isComposing: true, target: page }),
      keydown('=', { target: page }),
      keydown('+', { defaultPrevented: true, target: page })
    ]) {
      assert.equal(shortcuts.handleKeydown(event), false);
    }
    assert.equal(runs, 0);
  });

  it('never runs while typing in a field, but does from buttons, checkboxes, and radio buttons', () => {
    const shortcuts = createShortcutRegistry();
    let runs = 0;
    shortcuts.register({ id: 'help', key: '?', keys: [['?']], description: 'Help', category: 'General', handler: () => runs++ });

    for (const field of [h('input', { type: 'text' }), h('input', {}), h('input', { type: 'number' }), h('input', { type: 'date' }), h('textarea', {}), h('select', {})]) {
      assert.equal(shortcuts.handleKeydown(keydown('?', { target: field })), false, `${field.localName}[type=${field.getAttribute('type')}]`);
    }
    const editable = h('div', { contenteditable: 'true' }, h('span', {}, 'text'));
    assert.equal(shortcuts.handleKeydown(keydown('?', { target: editable.querySelector('span') })), false);
    assert.equal(runs, 0);

    for (const control of [h('button', { type: 'button' }), h('input', { type: 'checkbox' }), h('input', { type: 'radio' })]) {
      assert.equal(shortcuts.handleKeydown(keydown('?', { target: control })), true);
    }
    assert.equal(runs, 3);
  });

  it('runs and lists a shortcut only while its context applies', () => {
    const shortcuts = createShortcutRegistry();
    let available = false;
    let runs = 0;
    shortcuts.register({ id: 'log', key: '+', keys: [['+']], description: 'Log work', category: 'Worklogs', when: () => available, handler: () => runs++ });

    assert.equal(shortcuts.handleKeydown(keydown('+', { target: h('main', {}) })), false);
    assert.deepEqual(shortcuts.list().map((s) => s.id), []);
    available = true;
    assert.equal(shortcuts.handleKeydown(keydown('+', { target: h('main', {}) })), true);
    assert.deepEqual(shortcuts.list().map((s) => s.id), ['log']);
    assert.equal(runs, 1);
  });

  it('lists shortcuts handled by their own component, without running them', () => {
    const shortcuts = createShortcutRegistry();
    shortcuts.register({ id: 'form.close', keys: [['Esc']], description: 'Close the panel', category: 'Worklog form' });
    const escape = keydown('Escape', { target: h('main', {}) });
    assert.equal(shortcuts.handleKeydown(escape), false);
    assert.equal(escape.defaultPrevented, false);
    assert.deepEqual(shortcuts.list().map((s) => s.id), ['form.close']);
  });

  it('rejects incomplete shortcuts, duplicate ids, and a second handler for the same key', () => {
    const shortcuts = createShortcutRegistry();
    shortcuts.register({ id: 'log', key: '+', keys: [['+']], description: 'Log work', category: 'Worklogs', handler: () => {} });

    assert.throws(() => shortcuts.register({ id: 'log', keys: [['L']], description: 'Again', category: 'General' }), /already registered/);
    assert.throws(() => shortcuts.register({ id: 'other', key: '+', keys: [['+']], description: 'Other', category: 'General', handler: () => {} }), /already uses/);
    assert.throws(() => shortcuts.register({ id: 'nokey', keys: [['K']], description: 'No key', category: 'General', handler: () => {} }), /no key/);
    assert.throws(() => shortcuts.register({ id: 'nokeys', keys: [], description: 'No keys', category: 'General' }), /needs/);
    assert.throws(() => shortcuts.register({ id: 'nodesc', keys: [['K']], category: 'General' }), /needs/);
    // Documented keys may repeat: Enter means different things in different places.
    shortcuts.register({ id: 'a', keys: [['Enter']], description: 'A', category: 'Worklog form' });
    shortcuts.register({ id: 'b', keys: [['Enter']], description: 'B', category: 'Worklog form' });
  });

  it('leaves the key alone when the handler had nothing to do (returns false)', () => {
    const shortcuts = createShortcutRegistry();
    let open = false;
    let closes = 0;
    shortcuts.register({ id: 'close', key: 'Escape', keys: [['Esc']], description: 'Close panel', category: 'General',
      handler: () => (open ? (closes++, open = false, true) : false) });

    const idle = keydown('Escape', { target: h('main', {}) });
    assert.equal(shortcuts.handleKeydown(idle), false);
    assert.equal(idle.defaultPrevented, false, 'Escape keeps its default when nothing is open');

    open = true;
    const close = keydown('Escape', { target: h('main', {}) });
    assert.equal(shortcuts.handleKeydown(close), true);
    assert.equal(close.defaultPrevented, true);
    assert.equal(shortcuts.handleKeydown(keydown('Escape', { target: h('main', {}) })), false, 'a second Escape finds nothing open');
    assert.equal(closes, 1);
  });

  it('does not act on a key a panel already handled', () => {
    const shortcuts = createShortcutRegistry();
    let closes = 0;
    shortcuts.register({ id: 'close', key: 'Escape', keys: [['Esc']], description: 'Close panel', category: 'General', handler: () => { closes++; } });
    assert.equal(shortcuts.handleKeydown(keydown('Escape', { defaultPrevented: true, target: h('main', {}) })), false);
    assert.equal(closes, 0);
  });

  it('can remove a shortcut again', () => {
    const shortcuts = createShortcutRegistry();
    const unregister = shortcuts.register({ id: 'log', key: '+', keys: [['+']], description: 'Log work', category: 'Worklogs', handler: () => {} });
    unregister();
    assert.deepEqual(shortcuts.list(), []);
    assert.equal(shortcuts.handleKeydown(keydown('+', { target: h('main', {}) })), false);
  });

  it('listens with one listener and removes it again', () => {
    const shortcuts = createShortcutRegistry();
    let runs = 0;
    shortcuts.register({ id: 'help', key: '?', keys: [['?']], description: 'Help', category: 'General', handler: () => runs++ });
    const target = h('main', {});

    const stop = shortcuts.listen(target);
    assert.equal(target.listeners.keydown.length, 1);
    target.dispatchEvent(keydown('?'));
    stop();
    assert.equal(target.listeners.keydown.length, 0);
    target.dispatchEvent(keydown('?'));
    assert.equal(runs, 1);
  });

  it('accepts the shortcuts the worklog panel and issue field declare', () => {
    const shortcuts = createShortcutRegistry();
    for (const shortcut of [...WORKLOG_FORM_SHORTCUTS, ...ISSUE_PICKER_SHORTCUTS]) shortcuts.register(shortcut);
    assert.deepEqual(new Set(shortcuts.list().map((s) => s.category)), new Set(['Worklog form']));
    assert.ok(shortcuts.list().every((s) => !s.handler), 'their components handle these keys');
  });
});

describe('Shortcuts - typing targets', () => {
  let restoreDocument;
  before(() => {
    restoreDocument = installFakeDocument();
  });
  after(() => restoreDocument());

  it('treats text fields, selects, and editable content as typing, not buttons or the page', () => {
    assert.equal(isTypingTarget(h('input', { type: 'search' })), true);
    assert.equal(isTypingTarget(h('textarea', {})), true);
    assert.equal(isTypingTarget({ isContentEditable: true }), true);
    assert.equal(isTypingTarget(h('button', {})), false);
    assert.equal(isTypingTarget(h('main', {})), false);
    assert.equal(isTypingTarget(null), false);
  });
});

describe('Shortcuts - grouping and search', () => {
  const list = [
    { id: 'help', keys: [['?']], description: 'Show keyboard shortcuts', category: 'General' },
    { id: 'log', keys: [['+']], description: 'Log work', category: 'Worklogs' },
    { id: 'close', keys: [['Esc']], description: 'Close the panel', category: 'Worklog form' },
    { id: 'move', keys: [['↑'], ['↓']], description: 'Move through issue suggestions', category: 'Worklog form' },
    { id: 'palette', keys: [['Ctrl', 'K']], description: 'Open the command palette', category: 'Custom' }
  ];
  const ids = (groups) => groups.flatMap((g) => g.shortcuts.map((s) => s.id));

  it('groups by category in the standard order, then other categories, without empty groups', () => {
    const groups = groupShortcuts(list);
    assert.deepEqual(groups.map((g) => g.category), ['General', 'Worklogs', 'Worklog form', 'Custom']);
    assert.ok(!groups.some((g) => g.category === 'Navigation'), 'no empty category');
    assert.deepEqual(SHORTCUT_CATEGORIES.slice(0, 4), ['General', 'Day Navigation', 'Week Navigation', 'Navigation']);
  });

  it('searches descriptions, categories, and keys (by label or name), ignoring case', () => {
    assert.deepEqual(ids(groupShortcuts(list, 'WORKLOGS')), ['log'], 'the Worklogs category, not "Worklog form"');
    assert.deepEqual(ids(groupShortcuts(list, 'log work')), ['log', 'close', 'move'], 'every word, anywhere: "Worklog form" has both');
    assert.deepEqual(ids(groupShortcuts(list, 'worklog form')), ['close', 'move']);
    assert.deepEqual(ids(groupShortcuts(list, '?')), ['help']);
    assert.deepEqual(ids(groupShortcuts(list, '+')), ['log']);
    assert.deepEqual(ids(groupShortcuts(list, 'esc')), ['close']);
    assert.deepEqual(ids(groupShortcuts(list, 'escape')), ['close']);
    assert.deepEqual(ids(groupShortcuts(list, 'plus')), ['log']);
    assert.deepEqual(ids(groupShortcuts(list, 'ctrl k')), ['palette']);
    assert.deepEqual(ids(groupShortcuts(list, 'down arrow')), ['move']);
  });

  it('returns nothing when nothing matches', () => {
    assert.deepEqual(groupShortcuts(list, 'zzz'), []);
  });
});

describe('Shortcuts - primary modifier (⌘ on macOS, Ctrl elsewhere)', () => {
  let restoreDocument;
  before(() => {
    restoreDocument = installFakeDocument();
  });
  after(() => restoreDocument());

  const settings = (platform, runs) => {
    const shortcuts = createShortcutRegistry({ platform });
    shortcuts.register({ id: 'settings.open', key: ',', mod: true, description: 'Open connection settings', category: 'General', handler: () => runs.push(platform) });
    return shortcuts;
  };

  it('shows the binding for the platform', () => {
    assert.deepEqual(settings('mac', []).list()[0].keys, [['⌘', ',']]);
    assert.deepEqual(settings('other', []).list()[0].keys, [['Ctrl', ',']]);
  });

  it('runs on ⌘ , on macOS and Ctrl , elsewhere, preventing the default', () => {
    const runs = [];
    const page = h('main', {});
    const mac = keydown(',', { metaKey: true, code: 'Comma', target: page });
    assert.equal(settings('mac', runs).handleKeydown(mac), true);
    assert.equal(mac.defaultPrevented, true);
    assert.equal(settings('other', runs).handleKeydown(keydown(',', { ctrlKey: true, code: 'Comma', target: page })), true);
    assert.deepEqual(runs, ['mac', 'other']);
  });

  it('needs exactly the primary modifier: not the other one, Alt, nothing, or Shift (which types "<")', () => {
    const runs = [];
    const page = h('main', {});
    for (const [platform, init] of [
      ['mac', { ctrlKey: true }],
      ['mac', { metaKey: true, ctrlKey: true }],
      ['mac', { metaKey: true, altKey: true }],
      ['mac', {}],
      ['other', { metaKey: true }],
      ['other', { ctrlKey: true, metaKey: true }],
      ['other', { ctrlKey: true, altKey: true }],
      ['other', {}]
    ]) {
      assert.equal(settings(platform, runs).handleKeydown(keydown(',', { code: 'Comma', target: page, ...init })), false, `${platform} ${JSON.stringify(init)}`);
    }
    assert.equal(settings('other', runs).handleKeydown(keydown('<', { ctrlKey: true, shiftKey: true, code: 'Comma', target: page })), false);
    assert.equal(settings('other', runs).handleKeydown(keydown(',', { ctrlKey: true, repeat: true, target: page })), false);
    assert.deepEqual(runs, []);
  });

  it('never runs while typing in a field', () => {
    const runs = [];
    for (const field of [h('input', { type: 'text' }), h('textarea', {}), h('div', { contenteditable: 'true' })]) {
      assert.equal(settings('other', runs).handleKeydown(keydown(',', { ctrlKey: true, code: 'Comma', target: field })), false);
    }
    assert.deepEqual(runs, []);
  });

  it('works on non-Latin layouts by the physical key, but not for another character on a Latin layout', () => {
    const runs = [];
    const page = h('main', {});
    // Russian layout: the comma key types "б".
    assert.equal(settings('other', runs).handleKeydown(keydown('б', { ctrlKey: true, code: 'Comma', target: page })), true);
    // AZERTY: the key at the US comma position types ";", which isn't this shortcut.
    assert.equal(settings('other', runs).handleKeydown(keydown(';', { ctrlKey: true, code: 'Comma', target: page })), false);
    // AZERTY's own comma key (code KeyM) still works by character.
    assert.equal(settings('other', runs).handleKeydown(keydown(',', { ctrlKey: true, code: 'KeyM', target: page })), true);
    assert.equal(runs.length, 2);
  });

  it('keeps plain shortcuts separate: a plain and a modifier shortcut may share a key, two of the same kind may not', () => {
    const shortcuts = createShortcutRegistry({ platform: 'other' });
    shortcuts.register({ id: 'mod', key: ',', mod: true, description: 'Mod', category: 'General', handler: () => {} });
    shortcuts.register({ id: 'plain', key: ',', keys: [[',']], description: 'Plain', category: 'General', handler: () => {} });
    assert.throws(() => shortcuts.register({ id: 'again', key: ',', mod: true, description: 'Again', category: 'General', handler: () => {} }), /already uses/);
    assert.throws(() => shortcuts.register({ id: 'nokey', mod: true, description: 'No key', category: 'General', handler: () => {} }), /no key/);
  });

  it('is found in the drawer search by its keys', () => {
    const list = settings('mac', []).list();
    assert.equal(groupShortcuts(list, 'cmd').length, 1);
    assert.equal(groupShortcuts(list, 'comma').length, 1);
    assert.equal(groupShortcuts(settings('other', []).list(), 'ctrl ,').length, 1);
  });

  it('detects macOS from the browser, and everything else as Ctrl platforms', () => {
    assert.equal(detectPlatform({ userAgentData: { platform: 'macOS' } }), 'mac');
    assert.equal(detectPlatform({ platform: 'MacIntel' }), 'mac');
    assert.equal(detectPlatform({ userAgentData: { platform: 'Windows' } }), 'other');
    assert.equal(detectPlatform({ platform: 'Linux x86_64' }), 'other');
    assert.equal(detectPlatform(undefined), 'other');
  });
});

describe('Shortcuts - Shift + letter', () => {
  let restoreDocument;
  before(() => {
    restoreDocument = installFakeDocument();
  });
  after(() => restoreDocument());

  const thisWeek = (runs, platform = 'other') => {
    const shortcuts = createShortcutRegistry({ platform });
    shortcuts.register({ id: 'week.this-week', key: 't', shift: true, description: 'Go to This Week', category: 'Navigation', handler: () => runs.push('t') });
    return shortcuts;
  };
  const page = () => h('main', {});

  it('is shown as Shift T, from the binding', () => {
    assert.deepEqual(thisWeek([]).list()[0].keys, [['Shift', 'T']]);
  });

  it('runs on Shift+T, also with Caps Lock on (which types "t"), on both platforms', () => {
    const runs = [];
    const press = keydown('T', { shiftKey: true, code: 'KeyT', target: page() });
    assert.equal(thisWeek(runs).handleKeydown(press), true);
    assert.equal(press.defaultPrevented, true);
    assert.equal(thisWeek(runs).handleKeydown(keydown('t', { shiftKey: true, code: 'KeyT', target: page() })), true, 'Caps Lock + Shift');
    assert.equal(thisWeek(runs, 'mac').handleKeydown(keydown('T', { shiftKey: true, code: 'KeyT', target: page() })), true);
    assert.equal(runs.length, 3);
  });

  it('needs Shift: not a plain t, and not a T typed with Caps Lock alone', () => {
    const runs = [];
    assert.equal(thisWeek(runs).handleKeydown(keydown('t', { code: 'KeyT', target: page() })), false);
    assert.equal(thisWeek(runs).handleKeydown(keydown('T', { code: 'KeyT', target: page() })), false, 'Caps Lock without Shift');
    assert.deepEqual(runs, []);
  });

  it('leaves Alt, Ctrl, Cmd, and Option combinations, held keys, and other letters alone', () => {
    const runs = [];
    for (const [platform, init] of [
      ['other', { altKey: true }],
      ['other', { ctrlKey: true }],
      ['other', { metaKey: true }],
      ['mac', { metaKey: true }],
      ['mac', { altKey: true, key: 'ˇ' }],
      ['other', { repeat: true }],
      ['other', { key: 'R', code: 'KeyR' }]
    ]) {
      const { key = 'T', ...rest } = init;
      assert.equal(thisWeek(runs, platform).handleKeydown(keydown(key, { shiftKey: true, code: 'KeyT', target: page(), ...rest })), false, `${platform} ${JSON.stringify(init)}`);
    }
    assert.deepEqual(runs, []);
  });

  it('never runs while typing a capital T in a field', () => {
    const runs = [];
    for (const field of [h('input', { type: 'text' }), h('textarea', {}), h('div', { contenteditable: 'true' })]) {
      assert.equal(thisWeek(runs).handleKeydown(keydown('T', { shiftKey: true, code: 'KeyT', target: field })), false);
    }
    assert.deepEqual(runs, []);
  });

  it('works on non-Latin layouts by the physical key', () => {
    const runs = [];
    // Russian layout: Shift + the T key types "Е".
    assert.equal(thisWeek(runs).handleKeydown(keydown('Е', { shiftKey: true, code: 'KeyT', target: page() })), true);
    // A Latin layout where that key is another letter (Dvorak: Y) isn't this shortcut.
    assert.equal(thisWeek(runs).handleKeydown(keydown('Y', { shiftKey: true, code: 'KeyT', target: page() })), false);
    assert.equal(runs.length, 1);
  });

  it('runs once, alongside the existing shortcuts, which keep working', () => {
    const shortcuts = createShortcutRegistry({ platform: 'other' });
    const runs = [];
    shortcuts.register({ id: 'help', key: '?', keys: [['?']], description: 'Help', category: 'General', handler: () => runs.push('?') });
    shortcuts.register({ id: 'log', key: '+', keys: [['+']], description: 'Log work', category: 'Worklogs', handler: () => runs.push('+') });
    shortcuts.register({ id: 'settings', key: ',', mod: true, description: 'Settings', category: 'General', handler: () => runs.push(',') });
    shortcuts.register({ id: 'week.this-week', key: 't', shift: true, description: 'Go to This Week', category: 'Navigation', handler: () => runs.push('T') });
    for (const event of [
      keydown('T', { shiftKey: true, code: 'KeyT' }), keydown('?', { shiftKey: true, code: 'Slash' }),
      keydown('+', { shiftKey: true, code: 'Equal' }), keydown(',', { ctrlKey: true, code: 'Comma' })
    ]) {
      shortcuts.handleKeydown({ ...event, target: page(), preventDefault: event.preventDefault });
    }
    assert.deepEqual(runs, ['T', '?', '+', ',']);
  });

  it('rejects a Shift shortcut without a lowercase letter, and a second one on the same letter', () => {
    const shortcuts = createShortcutRegistry();
    shortcuts.register({ id: 'week.this-week', key: 't', shift: true, description: 'Go to This Week', category: 'Navigation', handler: () => {} });
    assert.throws(() => shortcuts.register({ id: 'again', key: 't', shift: true, description: 'Again', category: 'Navigation', handler: () => {} }), /already uses/);
    assert.throws(() => shortcuts.register({ id: 'upper', key: 'T', shift: true, description: 'Upper', category: 'Navigation', handler: () => {} }), /lowercase letter/);
    // A plain t is a different binding.
    shortcuts.register({ id: 'plain', key: 't', keys: [['t']], description: 'Plain', category: 'General', handler: () => {} });
  });

  it('is found in the drawer search by "shift", the letter, and its category', () => {
    const list = thisWeek([]).list();
    assert.equal(groupShortcuts(list, 'shift t').length, 1);
    assert.equal(groupShortcuts(list, 'navigation').length, 1);
    assert.equal(groupShortcuts(list, 'this week')[0].category, 'Navigation');
  });
});

describe('Shortcuts - Shift + arrow keys (week navigation)', () => {
  let restoreDocument;
  before(() => {
    restoreDocument = installFakeDocument();
  });
  after(() => restoreDocument());

  const weeks = (runs, platform = 'other') => {
    const shortcuts = createShortcutRegistry({ platform });
    shortcuts.register({ id: 'week.previous', key: 'ArrowLeft', shift: true, description: 'Previous Week', category: 'Navigation', handler: () => runs.push('prev') });
    shortcuts.register({ id: 'week.next', key: 'ArrowRight', shift: true, description: 'Next Week', category: 'Navigation', handler: () => runs.push('next') });
    shortcuts.register({ id: 'week.this-week', key: 't', shift: true, description: 'Go to This Week', category: 'Navigation', handler: () => runs.push('this') });
    shortcuts.register({ id: 'worklogs.sync', key: 's', shift: true, description: 'Sync Worklogs', category: 'Worklogs', handler: () => runs.push('sync') });
    return shortcuts;
  };
  const page = () => h('main', {});

  it('shows each binding with its key, in its category', () => {
    const groups = groupShortcuts(weeks([]).list());
    assert.deepEqual(groups.map((g) => [g.category, g.shortcuts.map((s) => `${s.description} [${s.keys.flat().join(' ')}]`)]), [
      ['Navigation', ['Previous Week [Shift ←]', 'Next Week [Shift →]', 'Go to This Week [Shift T]']],
      ['Worklogs', ['Sync Worklogs [Shift S]']]
    ]);
  });

  it('runs on Shift+← and Shift+→ on both platforms, once per press', () => {
    for (const platform of ['other', 'mac']) {
      const runs = [];
      const shortcuts = weeks(runs, platform);
      assert.equal(shortcuts.handleKeydown(keydown('ArrowLeft', { shiftKey: true, code: 'ArrowLeft', target: page() })), true);
      assert.equal(shortcuts.handleKeydown(keydown('ArrowRight', { shiftKey: true, code: 'ArrowRight', target: page() })), true);
      assert.equal(shortcuts.handleKeydown(keydown('S', { shiftKey: true, code: 'KeyS', target: page() })), true);
      assert.deepEqual(runs, ['prev', 'next', 'sync'], platform);
    }
  });

  it('leaves plain arrows, Alt+arrows (browser Back/Forward), Ctrl/Cmd+arrows, and held keys alone', () => {
    const runs = [];
    for (const [platform, init] of [
      ['other', {}], ['other', { shiftKey: true, altKey: true }], ['other', { shiftKey: true, ctrlKey: true }],
      ['mac', { shiftKey: true, metaKey: true }], ['other', { shiftKey: true, repeat: true }]
    ]) {
      assert.equal(weeks(runs, platform).handleKeydown(keydown('ArrowLeft', { code: 'ArrowLeft', target: page(), ...init })), false, `${platform} ${JSON.stringify(init)}`);
    }
    assert.deepEqual(runs, []);
  });

  it('never runs while typing: Shift+arrows select text and Shift+S types a capital S', () => {
    const runs = [];
    for (const field of [h('input', { type: 'text' }), h('textarea', {}), h('div', { contenteditable: 'true' })]) {
      for (const [key, code] of [['ArrowLeft', 'ArrowLeft'], ['ArrowRight', 'ArrowRight'], ['S', 'KeyS'], ['T', 'KeyT']]) {
        assert.equal(weeks(runs).handleKeydown(keydown(key, { shiftKey: true, code, target: field })), false);
      }
    }
    assert.deepEqual(runs, []);
  });

  it('is found in the drawer search by arrow names', () => {
    const list = weeks([]).list();
    assert.deepEqual(groupShortcuts(list, 'left arrow').flatMap((g) => g.shortcuts.map((s) => s.id)), ['week.previous']);
    assert.deepEqual(groupShortcuts(list, 'shift →').flatMap((g) => g.shortcuts.map((s) => s.id)), ['week.next']);
    assert.deepEqual(groupShortcuts(list, 'sync').flatMap((g) => g.shortcuts.map((s) => s.id)), ['worklogs.sync']);
  });

  it('accepts only letters and arrow keys with Shift', () => {
    const shortcuts = createShortcutRegistry();
    assert.throws(() => shortcuts.register({ id: 'enter', key: 'Enter', shift: true, description: 'Enter', category: 'Navigation', handler: () => {} }), /arrow key/);
    shortcuts.register({ id: 'up', key: 'ArrowUp', shift: true, description: 'Up', category: 'Navigation', handler: () => {} });
  });
});

describe('Shortcuts - Ctrl/⌘ + arrows (days) and Ctrl/⌘ + Shift + arrows (weeks and sync)', () => {
  let restoreDocument;
  before(() => {
    restoreDocument = installFakeDocument();
  });
  after(() => restoreDocument());

  // The page's six registrations (options.js), with handlers that record what ran.
  const PAGE = [
    ['day.previous', 'ArrowLeft', false, 'Previous Day', 'Day Navigation'],
    ['day.next', 'ArrowRight', false, 'Next Day', 'Day Navigation'],
    ['week.previous', 'ArrowLeft', true, 'Previous Week', 'Week Navigation'],
    ['week.next', 'ArrowRight', true, 'Next Week', 'Week Navigation'],
    ['week.this-week', 'ArrowUp', true, 'Go to Today', 'Week Navigation'],
    ['worklogs.sync', 'ArrowDown', true, 'Sync Worklogs', 'Worklogs']
  ];
  const page = (runs, platform) => {
    const shortcuts = createShortcutRegistry({ platform });
    for (const [id, key, shift, description, category] of PAGE) {
      shortcuts.register({ id, key, mod: true, shift, description, category, handler: () => runs.push(id) });
    }
    return shortcuts;
  };
  const target = () => h('main', {});
  const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

  it('shows each binding with the platform\'s modifier, in its category', () => {
    const shown = (platform) => groupShortcuts(page([], platform).list())
      .map((g) => [g.category, g.shortcuts.map((s) => `${s.description} [${s.keys.flat().join(' ')}]`)]);
    assert.deepEqual(shown('other'), [
      ['Day Navigation', ['Previous Day [Ctrl ←]', 'Next Day [Ctrl →]']],
      ['Week Navigation', ['Previous Week [Ctrl Shift ←]', 'Next Week [Ctrl Shift →]', 'Go to Today [Ctrl Shift ↑]']],
      ['Worklogs', ['Sync Worklogs [Ctrl Shift ↓]']]
    ]);
    assert.deepEqual(shown('mac'), [
      ['Day Navigation', ['Previous Day [⌘ ←]', 'Next Day [⌘ →]']],
      ['Week Navigation', ['Previous Week [⌘ Shift ←]', 'Next Week [⌘ Shift →]', 'Go to Today [⌘ Shift ↑]']],
      ['Worklogs', ['Sync Worklogs [⌘ Shift ↓]']]
    ]);
  });

  it('runs each action once on the platform\'s modifier, with Shift picking weeks over days, preventing the default', () => {
    for (const [platform, mod] of [['other', { ctrlKey: true }], ['mac', { metaKey: true }]]) {
      const runs = [];
      const shortcuts = page(runs, platform);
      for (const [key, shiftKey] of [['ArrowLeft', false], ['ArrowRight', false], ['ArrowLeft', true], ['ArrowRight', true], ['ArrowUp', true], ['ArrowDown', true]]) {
        const event = keydown(key, { code: key, shiftKey, target: target(), ...mod });
        assert.equal(shortcuts.handleKeydown(event), true, `${platform} ${key} shift=${shiftKey}`);
        assert.equal(event.defaultPrevented, true);
      }
      assert.deepEqual(runs, PAGE.map(([id]) => id), platform);
    }
  });

  it('leaves Ctrl/⌘ + ↑ / ↓ without Shift to the browser (nothing is bound to them)', () => {
    const runs = [];
    for (const [platform, mod] of [['other', { ctrlKey: true }], ['mac', { metaKey: true }]]) {
      for (const key of ['ArrowUp', 'ArrowDown']) {
        const event = keydown(key, { code: key, target: target(), ...mod });
        assert.equal(page(runs, platform).handleKeydown(event), false);
        assert.equal(event.defaultPrevented, false);
      }
    }
    assert.deepEqual(runs, []);
  });

  it('uses only the platform\'s modifier: not ⌘ on Windows/Linux, not Ctrl on macOS (Spaces, Mission Control)', () => {
    const runs = [];
    for (const key of ARROWS) {
      for (const shiftKey of [false, true]) {
        assert.equal(page(runs, 'other').handleKeydown(keydown(key, { code: key, metaKey: true, shiftKey, target: target() })), false);
        assert.equal(page(runs, 'mac').handleKeydown(keydown(key, { code: key, ctrlKey: true, shiftKey, target: target() })), false);
      }
    }
    assert.deepEqual(runs, []);
  });

  it('leaves plain and Shift arrows (scrolling), Alt + arrows (browser Back/Forward), and held keys alone', () => {
    const runs = [];
    for (const key of ARROWS) {
      for (const init of [{}, { shiftKey: true }, { altKey: true }, { ctrlKey: true, altKey: true }, { ctrlKey: true, shiftKey: true, altKey: true },
        { ctrlKey: true, repeat: true }, { ctrlKey: true, shiftKey: true, repeat: true }]) {
        assert.equal(page(runs, 'other').handleKeydown(keydown(key, { code: key, target: target(), ...init })), false, `${key} ${JSON.stringify(init)}`);
      }
    }
    assert.deepEqual(runs, []);
  });

  it('never runs while typing or editing (the keys move the caret or select text there)', () => {
    const runs = [];
    for (const field of [h('input', { type: 'text' }), h('input', { type: 'number' }), h('input', { type: 'date' }), h('textarea', {}), h('div', { contenteditable: 'true' })]) {
      for (const key of ARROWS) {
        for (const shiftKey of [false, true]) {
          assert.equal(page(runs, 'other').handleKeydown(keydown(key, { code: key, ctrlKey: true, shiftKey, target: field })), false);
          assert.equal(page(runs, 'mac').handleKeydown(keydown(key, { code: key, metaKey: true, shiftKey, target: field })), false);
        }
      }
    }
    assert.deepEqual(runs, []);
  });

  it('runs from any non-editable element that has focus (buttons, day cards, the page)', () => {
    const runs = [];
    for (const focus of [h('button', { type: 'button', class: 'day-card' }), h('div', { class: 'worklog-item' }), target()]) {
      page(runs, 'other').handleKeydown(keydown('ArrowLeft', { code: 'ArrowLeft', ctrlKey: true, target: focus }));
    }
    assert.deepEqual(runs, ['day.previous', 'day.previous', 'day.previous']);
  });

  it('keeps ?, Esc, and the Settings shortcut working alongside them', () => {
    const runs = [];
    const shortcuts = page(runs, 'other');
    shortcuts.register({ id: 'help', key: '?', keys: [['?']], description: 'Help', category: 'General', handler: () => runs.push('help') });
    shortcuts.register({ id: 'close', key: 'Escape', keys: [['Esc']], description: 'Close panel', category: 'General', handler: () => runs.push('close') });
    shortcuts.register({ id: 'settings', key: ',', mod: true, description: 'Settings', category: 'General', handler: () => runs.push('settings') });
    shortcuts.handleKeydown(keydown('?', { shiftKey: true, code: 'Slash', target: target() }));
    shortcuts.handleKeydown(keydown('Escape', { code: 'Escape', target: target() }));
    shortcuts.handleKeydown(keydown(',', { ctrlKey: true, code: 'Comma', target: target() }));
    shortcuts.handleKeydown(keydown('ArrowDown', { ctrlKey: true, shiftKey: true, code: 'ArrowDown', target: target() }));
    assert.deepEqual(runs, ['help', 'close', 'settings', 'worklogs.sync']);
  });

  it('rejects a second binding of the same keys', () => {
    const shortcuts = page([], 'other');
    assert.throws(() => shortcuts.register({ id: 'again', key: 'ArrowLeft', mod: true, description: 'Again', category: 'Navigation', handler: () => {} }), /already uses/);
    assert.throws(() => shortcuts.register({ id: 'again', key: 'ArrowDown', mod: true, shift: true, description: 'Again', category: 'Navigation', handler: () => {} }), /already uses/);
  });

  it('is found in the drawer search by category and key names', () => {
    const ids = (q) => groupShortcuts(page([], 'other').list(), q).flatMap((g) => g.shortcuts.map((s) => s.id));
    // "Day" also finds Go to Today.
    assert.deepEqual(ids('day'), ['day.previous', 'day.next', 'week.this-week']);
    assert.deepEqual(ids('today'), ['week.this-week']);
    assert.deepEqual(ids('week navigation'), ['week.previous', 'week.next', 'week.this-week']);
    assert.deepEqual(ids('ctrl shift left arrow'), ['week.previous']);
    assert.deepEqual(ids('shift up arrow'), ['week.this-week']);
    assert.deepEqual(ids('down arrow'), ['worklogs.sync']);
  });
});
