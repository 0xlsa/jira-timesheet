/**
 * The Worklog Queue group editor: the custom view editor's drawer (src/ui/customViewEditor.js), in
 * the same place and with the same look, to create a custom group (+) or rename or delete one (the
 * pencil). A group has only a name. Deleting asks once more, saying that the group's worklogs move
 * to On Hold (they're never deleted). Nothing is saved until Save or the confirmed Delete, and only
 * through `onSave` and `onDelete`; checking is `validate`'s (validateGroupDraft()).
 */

import { h, svg } from './dom.js';
import { showPanel, hidePanel } from './panel.js';
import { MAX_GROUP_NAME_LENGTH } from '../worklog/worklogGroups.js';

export const GROUP_HINT = 'A group files worklogs in this browser only: nothing is sent to Jira. To submit a group\'s worklogs, move them to Pending.';

const closeIcon = () => svg('svg', {
  class: 'icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'aria-hidden': 'true'
}, svg('line', { x1: '18', y1: '6', x2: '6', y2: '18' }), svg('line', { x1: '6', y1: '6', x2: '18', y2: '18' }));

const errorEl = (id) => h('div', { id, class: 'field-error', role: 'alert' });

function showError(el, message) {
  el.textContent = message || '';
  el.classList.toggle('visible', Boolean(message));
}

/**
 * What deleting a group says about its worklogs.
 * @param {string} name
 * @param {number} count - The worklogs in it
 * @returns {string}
 */
export function deleteGroupQuestion(name, count) {
  const moves = count === 0 ? 'It has no worklogs.'
    : `Its ${count === 1 ? 'worklog moves' : `${count} worklogs move`} to On Hold.`;
  return `Delete the ${name} group? ${moves}`;
}

/**
 * Opens the editor inside `root` (an initially hidden panel element). Focus moves to the name.
 * Escape, Cancel, or the close button closes it without saving.
 *
 * @param {HTMLElement} root
 * @param {object} options
 * @param {{ id: string, name: string } | null} options.group - The group to edit; null to create one
 * @param {() => number} [options.countWorklogs] - Editing only: how many worklogs the group has now
 * @param {(draft: { name: string }) => { errors: { form?: string, name?: string }, group: { name: string } | null }} options.validate
 * @param {(group: { name: string }) => Promise<void>} options.onSave - Rejects with a user-facing
 *   Error when it couldn't be saved
 * @param {() => Promise<void>} [options.onDelete] - Editing only; rejects like onSave
 * @param {() => void} options.onClose - Called as soon as the editor closes
 * @returns {{ close: () => void, readonly isOpen: boolean }}
 */
export function openWorklogGroupEditor(root, { group, countWorklogs = () => 0, validate, onSave, onDelete, onClose }) {
  const editing = Boolean(group);
  let isOpen = true;
  let busy = false;

  const nameInput = h('input', {
    type: 'text', id: 'worklogGroupName', class: 'custom-view-input', maxlength: String(MAX_GROUP_NAME_LENGTH),
    autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'worklogGroupNameError', 'aria-required': 'true'
  });
  nameInput.value = group?.name ?? '';
  const errors = { name: errorEl('worklogGroupNameError'), form: errorEl('worklogGroupFormError') };
  const deleteArea = editing ? h('div', { class: 'custom-view-delete' }) : null;

  const form = h('form', { class: 'custom-view-form', novalidate: true },
    h('p', { class: 'field-hint custom-view-hint' }, GROUP_HINT),
    h('div', { class: 'form-group' },
      h('label', { for: 'worklogGroupName', class: 'form-label' }, 'Name'),
      nameInput,
      errors.name),
    errors.form,
    h('div', { class: 'custom-view-actions' },
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save'),
      h('button', { type: 'button', class: 'btn btn-secondary', 'data-action': 'cancel-group' }, 'Cancel')),
    deleteArea);

  const contents = h('div', { class: 'custom-view-editor-body' },
    h('div', { class: 'custom-view-header' },
      h('h2', { class: 'custom-view-title', id: 'worklogGroupTitle' }, editing ? 'Edit group' : 'New group'),
      h('button', { type: 'button', class: 'editor-icon-btn', 'data-action': 'close-group-editor', 'aria-label': 'Close the group editor', title: 'Close' },
        closeIcon())),
    h('div', { class: 'custom-view-scroll' }, form));

  function showErrors(found) {
    showError(errors.name, found.name);
    showError(errors.form, found.form);
    nameInput.classList.toggle('is-invalid', Boolean(found.name));
  }

  function setBusy(isBusy) {
    busy = isBusy;
    for (const button of contents.querySelectorAll('button')) {
      if (button.dataset.action !== 'close-group-editor') button.disabled = isBusy;
    }
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    hidePanel(root);
    onClose();
  }

  /** Runs a save or a delete: closes once it's done, or says why it wasn't, staying open. */
  async function run(action, fallback) {
    setBusy(true);
    try {
      await action();
      close();
    } catch (err) {
      if (!isOpen) return;
      showErrors({ form: err?.message || fallback });
      setBusy(false);
    }
  }

  function save() {
    if (busy) return;
    const { errors: found, group: valid } = validate({ name: nameInput.value });
    showErrors(found);
    if (!valid) {
      nameInput.focus();
      return;
    }
    run(() => onSave(valid), "Couldn't save the group. Try again.");
  }

  function askToDelete() {
    deleteArea.replaceChildren(
      h('p', { class: 'custom-view-delete-question' }, deleteGroupQuestion(group.name, countWorklogs())),
      h('div', { class: 'custom-view-actions' },
        h('button', { type: 'button', class: 'btn btn-danger', 'data-action': 'confirm-delete-group' }, 'Delete group'),
        h('button', { type: 'button', class: 'btn btn-secondary', 'data-action': 'keep-group' }, 'Keep it')));
    deleteArea.querySelector('[data-action="keep-group"]').focus();
  }

  function showDeleteButton() {
    deleteArea?.replaceChildren(h('button', { type: 'button', class: 'btn btn-danger-outline', 'data-action': 'delete-group' }, 'Delete group'));
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    save();
  });
  contents.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'close-group-editor' || action === 'cancel-group') close();
    else if (action === 'delete-group') askToDelete();
    else if (action === 'keep-group') {
      showDeleteButton();
      deleteArea.querySelector('button').focus();
    } else if (action === 'confirm-delete-group' && !busy) run(onDelete, "Couldn't delete the group. Try again.");
  });
  contents.addEventListener('keydown', (event) => {
    if (!isOpen || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });

  showDeleteButton();
  showPanel(root, contents);
  root.setAttribute('aria-labelledby', 'worklogGroupTitle');
  nameInput.focus();

  return {
    close,
    get isOpen() {
      return isOpen;
    }
  };
}
