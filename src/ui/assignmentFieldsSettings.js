/**
 * The Additional Assignment Fields section of the Settings form: the Jira user fields chosen for
 * the connected site, each with a remove (✕) button, and an Add field button that opens a menu of
 * the site's other supported fields (src/jira/assignmentFields.js).
 *
 * Changes are saved as they're made, through `onChange`, not with Save Settings: they apply to the
 * saved Jira connection, whose site the fields belong to. Without a saved connection there are no
 * fields to offer, and Add field is disabled. The field list is loaded from Jira the first time
 * the menu opens on a visit; a failed load says so, with Try again, and is never shown as an empty
 * list.
 */

import { h } from './dom.js';
import { MAX_ASSIGNMENT_FIELDS, withDuplicateHints } from '../jira/assignmentFields.js';

export const NOT_CONNECTED_MESSAGE = 'Save your Jira connection to choose fields.';
export const LOADING_MESSAGE = 'Loading fields…';
export const NO_FIELDS_MESSAGE = 'No other Jira user fields to add.';
export const FIELDS_UNAVAILABLE_MESSAGE = "Couldn't load the fields from Jira.";
export const SAVE_FAILED_MESSAGE = "Couldn't save the fields. Try again.";

/**
 * @param {object} elements
 * @param {HTMLElement} elements.list - The chosen fields (`ul`)
 * @param {HTMLButtonElement} elements.addButton - Add field (aria-controls the menu)
 * @param {HTMLElement} elements.menu - The fields to add (`ul`, role="menu")
 * @param {HTMLElement} elements.status - Loading, empty, and error messages (role="status")
 * @param {object} handlers
 * @param {(site: string, fields: Array<{ id: string, name: string }>) => Promise<void>} handlers.onChange -
 *   Saves a site's new list of fields; rejects when it couldn't
 */
export function createAssignmentFieldsSettings({ list, addButton, menu, status }, { onChange }) {
  // The connected site and its fields: { site, loadFields }, or null without a saved connection.
  let connection = null;
  let selected = [];
  // The site's supported fields, once loaded on this visit.
  let available = null;
  // Bumped by show(), so an answer arriving for an earlier visit changes nothing.
  let visit = 0;

  function showStatus(message, { retry = false, error = false } = {}) {
    status.replaceChildren(...[
      message,
      retry && ' ',
      retry && h('button', { type: 'button', class: 'holidays-retry-btn', 'data-action': 'retry-fields' }, 'Try again')
    ].filter(Boolean));
    status.classList.toggle('hidden', !message);
    status.classList.toggle('is-error', error);
  }

  function renderList() {
    // Names are compared across the chosen fields and the site's fields, so a chosen "Reviewer"
    // is told apart from another "Reviewer" the site has.
    const hints = new Map(withDuplicateHints(mergeById(selected, available ?? [])).map((field) => [field.id, field.hint]));
    list.replaceChildren(...selected.map((field) => {
      const hint = hints.get(field.id);
      return h('li', { class: 'assignment-field', 'data-field-id': field.id },
        h('span', { class: 'assignment-field-name' }, field.name),
        hint && h('span', { class: 'assignment-field-id' }, hint),
        h('button', {
          type: 'button', class: 'assignment-field-remove', 'data-action': 'remove-field', 'data-field-id': field.id,
          'aria-label': `Remove ${field.name}${hint ? ` (${hint})` : ''}`, title: 'Remove'
        }, '✕'));
    }));
    list.classList.toggle('hidden', selected.length === 0);
    addButton.disabled = !connection || selected.length >= MAX_ASSIGNMENT_FIELDS;
  }

  function isMenuOpen() {
    return addButton.getAttribute('aria-expanded') === 'true';
  }

  function closeMenu({ focusButton = false } = {}) {
    addButton.setAttribute('aria-expanded', 'false');
    menu.classList.add('hidden');
    menu.replaceChildren();
    if (focusButton) addButton.focus();
  }

  function openMenu() {
    const choices = withDuplicateHints(available).filter((field) => !selected.some((s) => s.id === field.id));
    if (choices.length === 0) {
      showStatus(NO_FIELDS_MESSAGE);
      return;
    }
    showStatus('');
    menu.replaceChildren(...choices.map((field) =>
      h('li', { role: 'none' },
        h('button', { type: 'button', role: 'menuitem', class: 'assignment-fields-option', 'data-field-id': field.id, tabindex: '-1' },
          h('span', { class: 'assignment-field-name' }, field.name),
          field.hint && h('span', { class: 'assignment-field-id' }, field.hint)))));
    menu.classList.remove('hidden');
    addButton.setAttribute('aria-expanded', 'true');
    menu.querySelector('[role="menuitem"]')?.focus();
  }

  async function loadAndOpen() {
    if (!connection) return;
    const thisVisit = visit;
    if (!available) {
      showStatus(LOADING_MESSAGE);
      try {
        const fields = await connection.loadFields();
        if (thisVisit !== visit) return;
        available = fields;
      } catch (err) {
        if (thisVisit !== visit) return;
        console.warn('Could not load the Jira user fields:', err);
        showStatus(`${FIELDS_UNAVAILABLE_MESSAGE}${err?.message ? ` ${err.message}` : ''}`, { retry: true, error: true });
        return;
      }
      renderList();
    }
    openMenu();
  }

  async function save(fields, focusAfter) {
    const thisVisit = visit;
    const previous = selected;
    selected = fields;
    renderList();
    try {
      await onChange(connection.site, fields);
      if (thisVisit === visit) showStatus('');
    } catch (err) {
      if (thisVisit !== visit) return;
      console.warn('Could not save the additional assignment fields:', err);
      selected = previous;
      renderList();
      showStatus(SAVE_FAILED_MESSAGE, { error: true });
    }
    focusAfter?.()?.focus();
  }

  addButton.addEventListener('click', () => {
    if (isMenuOpen()) closeMenu();
    else loadAndOpen();
  });

  menu.addEventListener('click', (event) => {
    const option = event.target?.closest?.('[data-field-id]');
    const field = option && available?.find((f) => f.id === option.dataset.fieldId);
    if (!field) return;
    closeMenu();
    save([...selected, { id: field.id, name: field.name }], () => (addButton.disabled ? null : addButton));
  });

  // Arrow keys move between the fields; Escape closes the menu; Tab leaves it closed.
  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const index = items.indexOf(event.target);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // Only the menu closes, not the Settings drawer.
      event.stopPropagation();
      closeMenu({ focusButton: true });
    } else if (event.key === 'Tab') {
      closeMenu();
    }
  });

  list.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-action="remove-field"]');
    if (!button) return;
    const index = selected.findIndex((field) => field.id === button.dataset.fieldId);
    if (index < 0) return;
    const fields = selected.filter((_, i) => i !== index);
    // Focus moves to the next field's remove button, or the previous one, or Add field.
    const nextId = (fields[index] ?? fields[index - 1])?.id;
    save(fields, () => (nextId ? list.querySelector(`[data-action="remove-field"][data-field-id="${nextId}"]`) : addButton));
  });

  status.addEventListener('click', (event) => {
    if (event.target?.closest?.('[data-action="retry-fields"]')) loadAndOpen();
  });

  // A click anywhere else closes the menu.
  menu.ownerDocument.addEventListener('click', (event) => {
    if (isMenuOpen() && !isInside(event.target, menu) && !isInside(event.target, addButton)) closeMenu();
  });

  return {
    /**
     * Shows a site's saved fields, as Settings opens. The site's field list is loaded again on
     * this visit, when the menu first opens.
     *
     * @param {{ site: string, fields: Array<{ id: string, name: string }>,
     *   loadFields: () => Promise<Array<{ id: string, name: string }>> } | null} saved - Null without
     *   a saved Jira connection
     */
    show(saved) {
      visit++;
      connection = saved ? { site: saved.site, loadFields: saved.loadFields } : null;
      selected = saved ? [...saved.fields] : [];
      available = null;
      closeMenu();
      showStatus(connection ? '' : NOT_CONNECTED_MESSAGE);
      renderList();
    },

    /** Closes the menu (when Settings closes). */
    close() {
      closeMenu();
    }
  };
}

/** Whether `node` is `container` or inside it. */
function isInside(node, container) {
  for (let el = node; el; el = el.parentNode) {
    if (el === container) return true;
  }
  return false;
}

/** `first`, then the fields of `second` not in it, by ID. */
function mergeById(first, second) {
  return [...first, ...second.filter((field) => !first.some((f) => f.id === field.id))];
}
