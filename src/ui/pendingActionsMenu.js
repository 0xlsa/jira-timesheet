/**
 * The menu a pending worklog's ⋯ button opens: Mark as Ready, Put On Hold, or Archive, whichever
 * the row isn't filed under already. One menu serves every row, added to the page once; My Work
 * draws its rows again whenever the timer's state changes (in this tab or another), and the menu
 * stays open across that, following the row's new button.
 *
 * It's a WAI-ARIA menu button: the menu opens with focus on its first item; the arrow keys, Home,
 * and End move between the items; Enter or a click chooses one; Escape closes it and focus goes
 * back to the ⋯ button; Tab, a click or focus outside, or the row going away close it. It's placed
 * with fixed positioning under the button, its right edge on the button's (above it when there's
 * no room below), always inside the window.
 */

import { h, svg } from './dom.js';

const ICON_STROKE = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' };

// Each action's icon (decorative): a check for Ready, a pause for On Hold, a box for Archive.
const ACTION_ICONS = {
  ready: () => [svg('path', { d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14' }), svg('polyline', { points: '22 4 12 14.01 9 11.01' })],
  'on-hold': () => [svg('circle', { cx: '12', cy: '12', r: '10' }), svg('line', { x1: '10', y1: '15', x2: '10', y2: '9' }), svg('line', { x1: '14', y1: '15', x2: '14', y2: '9' })],
  archived: () => [svg('polyline', { points: '21 8 21 21 3 21 3 8' }), svg('rect', { x: '1', y: '3', width: '22', height: '5' }), svg('line', { x1: '10', y1: '12', x2: '14', y2: '12' })]
};

/**
 * Where to put the menu: under the anchor with their right edges lined up, or above it when it
 * doesn't fit below; always inside the viewport, `margin` from its edges where it can be.
 *
 * @param {{ left: number, right: number, top: number, bottom: number }} anchor - The anchor's client rect
 * @param {{ width: number, height: number }} size - The menu's size
 * @param {{ width: number, height: number }} viewport
 * @param {number} [gap=4] - Between the anchor and the menu
 * @param {number} [margin=8]
 * @returns {{ left: number, top: number }}
 */
export function placeMenu(anchor, size, viewport, gap = 4, margin = 8) {
  const left = Math.max(margin, Math.min(anchor.right - size.width, viewport.width - margin - size.width));
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const top = below + size.height <= viewport.height - margin || above < margin ? below : above;
  return { left, top: Math.max(margin, Math.min(top, viewport.height - margin - size.height)) };
}

/** Whether `node` is `root` or inside it. */
function isWithin(node, root) {
  for (let el = node; el; el = el.parentNode) {
    if (el === root) return true;
  }
  return false;
}

/**
 * Adds the menu to the page, closed.
 *
 * @param {object} options
 * @param {HTMLElement} options.container - Where the menu is added (the page's body)
 * @param {(id: string) => HTMLElement | null} options.findButton - A row's ⋯ button as it's on the
 *   page now (rows are drawn again), or null once the row is gone
 * @returns {{ open: Function, close: Function, isOpen: () => boolean, openFor: () => string | null, sync: () => void }}
 */
export function createPendingActionsMenu({ container, findButton }) {
  const menu = h('ul', { id: 'pendingActionsMenu', class: 'pending-actions-menu hidden', role: 'menu' });
  container.append(menu);

  // While open: the row's ID, and what choosing an action does.
  let current = null;

  const items = () => [...menu.querySelectorAll('[role="menuitem"]')];
  const button = () => (current ? findButton(current.id) : null);

  function position() {
    const anchor = button();
    if (!anchor?.getBoundingClientRect || !menu.getBoundingClientRect || typeof window === 'undefined') return;
    const { left, top } = placeMenu(anchor.getBoundingClientRect(), menu.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight });
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  // A click or focus outside the menu and its button closes it.
  function onOutside(event) {
    const anchor = button();
    if (!isWithin(event.target, menu) && !(anchor && isWithin(event.target, anchor))) close();
  }

  function setExpanded(expanded) {
    const anchor = button();
    anchor?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  /**
   * Opens the menu for a row (closing it first for another row).
   * @param {object} options
   * @param {string} options.id - The pending worklog's ID
   * @param {string} options.label - The menu's accessible name ("Actions for KAN-20, started 09:15")
   * @param {Array<{ id: string, action: string }>} options.actions - In order (rowActions())
   * @param {(classification: string) => void} options.onChoose - Called after the menu closes, focus
   *   back on the ⋯ button
   */
  function open({ id, label, actions, onChoose }) {
    if (current) close();
    current = { id, onChoose };
    menu.setAttribute('aria-label', label);
    menu.replaceChildren(...actions.map((action) => h('li', { role: 'none' },
      h('button', { type: 'button', role: 'menuitem', class: 'pending-actions-item', 'data-classification': action.id, tabindex: '-1' },
        svg('svg', { class: 'icon', ...ICON_STROKE, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
          ...(ACTION_ICONS[action.id]?.() ?? [])),
        h('span', {}, action.action)))));
    menu.classList.remove('hidden');
    setExpanded(true);
    position();
    items()[0]?.focus();
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('focusin', onOutside);
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', position);
      window.addEventListener('scroll', position, true);
    }
  }

  /**
   * Closes the menu, if it's open.
   * @param {{ restoreFocus?: boolean }} [options] - Put focus back on the row's ⋯ button
   */
  function close({ restoreFocus = false } = {}) {
    if (!current) return;
    setExpanded(false);
    const anchor = button();
    current = null;
    menu.classList.add('hidden');
    menu.replaceChildren();
    document.removeEventListener('pointerdown', onOutside);
    document.removeEventListener('focusin', onOutside);
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    }
    if (restoreFocus) anchor?.focus();
  }

  menu.addEventListener('click', (event) => {
    const item = event.target.closest?.('[role="menuitem"]');
    if (!item || !current) return;
    const { onChoose } = current;
    close({ restoreFocus: true });
    onChoose(item.dataset.classification);
  });

  menu.addEventListener('keydown', (event) => {
    const list = items();
    const index = list.indexOf(event.target);
    const move = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: list.length - 1 }[event.key];
    if (move !== undefined) {
      event.preventDefault();
      list[(move + list.length) % list.length]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // Only the menu closes, nothing behind it.
      event.stopPropagation();
      close({ restoreFocus: true });
    } else if (event.key === 'Tab') {
      // Focus moves on from the ⋯ button, as if the menu hadn't been opened.
      const anchor = button();
      close();
      anchor?.focus();
    }
  });

  return {
    open,
    close,
    isOpen: () => current !== null,
    /** The ID of the pending worklog whose menu is open, or null. */
    openFor: () => current?.id ?? null,
    /**
     * After My Work is drawn again: closes the menu if its row is gone (or no longer offers it),
     * otherwise marks the row's new ⋯ button as expanded and moves the menu to it.
     */
    sync() {
      if (!current) return;
      if (!button()) {
        close();
        return;
      }
      setExpanded(true);
      position();
    }
  };
}
