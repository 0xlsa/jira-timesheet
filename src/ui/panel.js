/**
 * Right-hand side panels (the worklog panel and the keyboard shortcuts drawer): slide in
 * and fade in when shown, slide out and fade out when hidden. The transitions are in
 * options.css; this keeps the panel visible until its slide-out has ended.
 */

// Matches the closing transition of .is-closed side panels in options.css.
const PANEL_CLOSE_MS = 200;

// Panels sliding out: root → timer that hides and empties the panel once the slide ends.
const pendingPanelHides = new WeakMap();

/**
 * Shows the panel with new contents. A hidden panel slides in; one that is visible or still
 * sliding out keeps its place and only its contents change, so switching from one worklog
 * to another (close, then open, in the same task) doesn't animate.
 * @param {HTMLElement} root
 * @param {Node} [contents] - Without contents, the panel shows what it already holds
 */
export function showPanel(root, contents) {
  clearTimeout(pendingPanelHides.get(root));
  pendingPanelHides.delete(root);
  const wasHidden = root.classList.contains('hidden');

  root.removeAttribute('inert');
  if (contents) root.replaceChildren(contents);
  if (wasHidden) {
    // Start from the closed position, so removing is-closed runs the slide-in transition.
    root.classList.add('is-closed');
    root.classList.remove('hidden');
    void root.offsetWidth;
  }
  root.classList.remove('is-closed');
}

/**
 * Slides the panel out, then hides and empties it. It's inert from the start, so a closing
 * panel can't take focus or clicks.
 * @param {HTMLElement} root
 * @param {object} [options]
 * @param {boolean} [options.keepContents=false] - Keep the contents (and anything typed in
 *   them) for the next showPanel(), instead of emptying the panel
 */
export function hidePanel(root, { keepContents = false } = {}) {
  root.setAttribute('inert', '');
  root.classList.add('is-closed');
  clearTimeout(pendingPanelHides.get(root));
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  pendingPanelHides.set(root, setTimeout(() => {
    pendingPanelHides.delete(root);
    root.classList.add('hidden');
    if (!keepContents) root.replaceChildren();
    root.removeAttribute('inert');
  }, reducedMotion ? 0 : PANEL_CLOSE_MS));
}
