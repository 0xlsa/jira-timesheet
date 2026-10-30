/**
 * A minimal DOM for tests that build UI with src/ui/dom.js. Node has no DOM and the
 * project has no dependencies, so this covers just what the UI modules use: elements,
 * SVG elements, fragments, text, attributes, dataset, classList, textContent, form field
 * values, focus, simple selectors (tag, #id, .class, [attr], [attr="value"], compounded,
 * and comma-separated lists; no combinators), and events that bubble (with preventDefault()
 * and stopPropagation()). There is no HTML parser, so text can never turn into elements.
 *
 * toHtml() serializes nodes the way a browser does, escaping text and attribute values.
 */

const VOID_ELEMENTS = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'wbr']);

class FakeNode {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.replaceChildren(String(value ?? ''));
  }

  append(...items) {
    for (const item of items) {
      if (item instanceof FakeFragment) {
        for (const child of [...item.childNodes]) this.append(child);
        continue;
      }
      const node = item instanceof FakeNode ? item : new FakeText(this.ownerDocument, String(item));
      node.parentNode?.removeChild(node);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  removeChild(node) {
    this.childNodes = this.childNodes.filter((child) => child !== node);
    node.parentNode = null;
    return node;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  replaceChildren(...items) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    this.append(...items);
  }

  /** Elements below this node, in document order. */
  get descendants() {
    return this.childNodes.filter((child) => child instanceof FakeElement)
      .flatMap((child) => [child, ...child.descendants]);
  }

  querySelectorAll(selector) {
    return this.descendants.filter((el) => el.matches(selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeText extends FakeNode {
  constructor(ownerDocument, data) {
    super(ownerDocument);
    this.data = data;
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value);
  }
}

class FakeFragment extends FakeNode {}

class FakeElement extends FakeNode {
  constructor(ownerDocument, tagName, namespaceURI) {
    super(ownerDocument);
    this.localName = tagName;
    this.namespaceURI = namespaceURI;
    this.attributes = new Map();
    this.listeners = {};
    this.disabled = false;
  }

  get tagName() {
    return this.localName.toUpperCase();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  get className() { return this.getAttribute('class') ?? ''; }
  set className(value) { this.setAttribute('class', value); }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(value) { this.setAttribute('id', value); }
  get title() { return this.getAttribute('title') ?? ''; }
  set title(value) { this.setAttribute('title', value); }
  get type() { return this.getAttribute('type') ?? ''; }
  set type(value) { this.setAttribute('type', value); }
  get name() { return this.getAttribute('name') ?? ''; }
  set name(value) { this.setAttribute('name', value); }

  get children() {
    return this.childNodes.filter((child) => child instanceof FakeElement);
  }

  /** Form field value: starts from the `value` attribute (or a textarea's text), then set by the user. */
  get value() {
    if (this._value !== undefined) return this._value;
    return this.localName === 'textarea' ? this.textContent : (this.getAttribute('value') ?? '');
  }

  set value(value) {
    this._value = String(value);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  select() {}

  get dataset() {
    const toAttribute = (key) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    return new Proxy({}, {
      get: (_target, key) => this.getAttribute(toAttribute(String(key))) ?? undefined,
      set: (_target, key, value) => {
        this.setAttribute(toAttribute(String(key)), value);
        return true;
      }
    });
  }

  get classList() {
    const read = () => this.className.split(/\s+/).filter(Boolean);
    const write = (classes) => this.setAttribute('class', classes.join(' '));
    return {
      contains: (name) => read().includes(name),
      add: (...names) => write([...new Set([...read(), ...names])]),
      remove: (...names) => write(read().filter((c) => !names.includes(c))),
      toggle: (name, force) => {
        const on = force ?? !read().includes(name);
        if (on) write([...new Set([...read(), name])]);
        else write(read().filter((c) => c !== name));
        return on;
      }
    };
  }

  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()));
    const parts = selector.match(/^([a-z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i);
    if (!parts) throw new Error(`fakeDom: unsupported selector "${selector}"`);
    const [, tag, rest] = parts;
    if (tag && tag.toLowerCase() !== this.localName) return false;
    for (const [token] of rest.matchAll(/#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]/g)) {
      if (token[0] === '#' && this.id !== token.slice(1)) return false;
      if (token[0] === '.' && !this.classList.contains(token.slice(1))) return false;
      if (token[0] === '[') {
        const [, name, value] = token.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
        if (!this.hasAttribute(name)) return false;
        if (value !== undefined && this.getAttribute(name) !== value) return false;
      }
    }
    return true;
  }

  closest(selector) {
    for (let el = this; el instanceof FakeElement; el = el.parentNode) {
      if (el.matches(selector)) return el;
    }
    return null;
  }

  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }

  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
  }

  /**
   * Dispatches `event` on this element and bubbles it up, like a real click.
   * @returns {boolean} False when a listener called preventDefault()
   */
  dispatchEvent(event) {
    let stopped = false;
    const bubbling = {
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { stopped = true; },
      ...event
    };
    for (let el = this; el instanceof FakeElement && !stopped; el = el.parentNode) {
      for (const listener of el.listeners[event.type] ?? []) listener(bubbling);
    }
    return !bubbling.defaultPrevented;
  }

  click() {
    this.dispatchEvent({ type: 'click' });
  }
}

class FakeDocument {
  constructor() {
    this.documentElement = this.createElement('html');
    this.activeElement = null;
  }

  createElement(tagName) {
    return new FakeElement(this, tagName.toLowerCase(), 'http://www.w3.org/1999/xhtml');
  }

  createElementNS(namespaceURI, tagName) {
    return new FakeElement(this, tagName, namespaceURI);
  }

  createDocumentFragment() {
    return new FakeFragment(this);
  }

  createTextNode(data) {
    return new FakeText(this, String(data));
  }
}

/**
 * Sets `globalThis.document` to a fake document.
 * @returns {() => void} Restores the previous `document`
 */
export function installFakeDocument() {
  const previous = globalThis.document;
  globalThis.document = new FakeDocument();
  return () => {
    globalThis.document = previous;
  };
}

const escapeText = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (value) => escapeText(value).replace(/"/g, '&quot;');

/**
 * Serializes a node (element, fragment, or text) to HTML.
 * @param {FakeNode | null} node
 * @returns {string}
 */
export function toHtml(node) {
  if (!node) return '';
  if (node instanceof FakeText) return escapeText(node.data);
  const inner = node.childNodes.map(toHtml).join('');
  if (node instanceof FakeFragment) return inner;

  const attributes = [...node.attributes].map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('');
  if (VOID_ELEMENTS.has(node.localName)) return `<${node.localName}${attributes}>`;
  return `<${node.localName}${attributes}>${inner}</${node.localName}>`;
}
