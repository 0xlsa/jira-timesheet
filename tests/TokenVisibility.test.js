import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTokenVisibilityToggle } from '../src/ui/tokenVisibility.js';

// Just enough of the DOM for the toggle: attributes, a class list, and click listeners.
function fakeElement(props = {}) {
  const attributes = {};
  const classes = new Set(props.classes || []);
  const listeners = {};
  return {
    ...props,
    classList: {
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      }
    },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return name in attributes ? attributes[name] : null; },
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    click() { (listeners.click || []).forEach((listener) => listener()); }
  };
}

function setup({ type = 'password', value = 'secret-token' } = {}) {
  const input = fakeElement({ type, value });
  const button = fakeElement();
  const showIcon = fakeElement();
  const hideIcon = fakeElement({ classes: ['hidden'] });
  const toggle = createTokenVisibilityToggle({ input, button, showIcon, hideIcon });
  return { input, button, showIcon, hideIcon, toggle };
}

describe('Token visibility - masking', () => {
  it('masks the token when created, even if the input was left as text', () => {
    const { input, button, showIcon, hideIcon, toggle } = setup({ type: 'text' });
    assert.equal(input.type, 'password');
    assert.equal(toggle.isVisible(), false);
    assert.equal(button.getAttribute('aria-label'), 'Show API token');
    assert.equal(showIcon.classList.contains('hidden'), false);
    assert.equal(hideIcon.classList.contains('hidden'), true);
  });

  it('reveals and hides the token on click, keeping the label in sync', () => {
    const { input, button, showIcon, hideIcon, toggle } = setup();

    button.click();
    assert.equal(input.type, 'text');
    assert.equal(toggle.isVisible(), true);
    assert.equal(button.getAttribute('aria-label'), 'Hide API token');
    assert.equal(button.getAttribute('title'), 'Hide API token');
    assert.equal(showIcon.classList.contains('hidden'), true);
    assert.equal(hideIcon.classList.contains('hidden'), false);

    button.click();
    assert.equal(input.type, 'password');
    assert.equal(button.getAttribute('aria-label'), 'Show API token');
  });

  it('mask() hides a revealed token without changing its value', () => {
    const { input, button, toggle } = setup({ value: 'abc123' });
    button.click();

    toggle.mask();
    assert.equal(input.type, 'password');
    assert.equal(input.value, 'abc123');
    assert.equal(button.getAttribute('aria-label'), 'Show API token');

    // Masking an already masked token is harmless.
    toggle.mask();
    assert.equal(input.type, 'password');
    assert.equal(input.value, 'abc123');
  });
});

describe('Token visibility - options page wiring', () => {
  const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../options.js', import.meta.url), 'utf8');

  it('starts the token field as a password input with a labeled toggle', () => {
    assert.match(html, /<input type="password" id="jiraToken"/);
    assert.match(html, /id="toggleTokenVisibility"[^>]*aria-controls="jiraToken"/);
    assert.match(html, /aria-label="Show API token"/);
  });

  it('masks the token when Connection Settings closes and when the page is hidden', () => {
    const closeSettings = script.slice(script.indexOf('function closeSettings('), script.indexOf('// Worklog UI Rendering'));
    assert.match(closeSettings, /tokenVisibility\.mask\(\)/);
    assert.match(script, /addEventListener\('visibilitychange'[\s\S]{0,200}tokenVisibility\.mask\(\)/);
    assert.match(script, /addEventListener\('pagehide', \(\) => tokenVisibility\.mask\(\)\)/);
  });

  it('never stores the visibility state', () => {
    const module = readFileSync(new URL('../src/ui/tokenVisibility.js', import.meta.url), 'utf8');
    assert.doesNotMatch(module, /localStorage|sessionStorage|storage\./);
  });
});
