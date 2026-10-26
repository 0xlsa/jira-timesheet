/**
 * Builds DOM nodes without parsing HTML. Values from Jira (issue summaries, statuses,
 * comments, error messages) and from settings are only ever set as text or as attribute
 * values, so they can't become markup.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Creates an HTML element.
 *
 * @param {string} tag
 * @param {Record<string, string | number | boolean | null | undefined>} [attributes] - Set with
 *   setAttribute(), in order. `true` sets an empty attribute; `false`, null, and undefined are skipped.
 * @param {...(Node | string | number | null | undefined | false)} children - Strings and numbers are
 *   added as text; null, undefined, false, and '' are skipped. Arrays are flattened.
 * @returns {HTMLElement}
 */
export function h(tag, attributes = {}, ...children) {
  return build(document.createElement(tag), attributes, children);
}

/**
 * Creates an SVG element (for inline icons). Same arguments as h().
 *
 * @param {string} tag
 * @param {Record<string, string | number | boolean | null | undefined>} [attributes]
 * @param {...(Node | string | number | null | undefined | false)} children
 * @returns {SVGElement}
 */
export function svg(tag, attributes = {}, ...children) {
  return build(document.createElementNS(SVG_NS, tag), attributes, children);
}

/**
 * Creates a fragment holding the given children, with the same rules as h().
 *
 * @param {...(Node | string | number | null | undefined | false)} children
 * @returns {DocumentFragment}
 */
export function fragment(...children) {
  const result = document.createDocumentFragment();
  appendChildren(result, children);
  return result;
}

function build(element, attributes, children) {
  for (const [name, value] of Object.entries(attributes)) {
    // Event handler attributes are code; listeners are added with addEventListener instead.
    if (/^on/i.test(name)) throw new Error(`Event handler attribute "${name}" is not allowed.`);
    if (value === false || value === null || value === undefined) continue;
    element.setAttribute(name, value === true ? '' : String(value));
  }
  appendChildren(element, children);
  return element;
}

function appendChildren(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    // append() adds a string as a text node; it never parses it.
    parent.append(typeof child === 'object' ? child : String(child));
  }
}
