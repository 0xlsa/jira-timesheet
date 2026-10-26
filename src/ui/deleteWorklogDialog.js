/**
 * Delete worklog confirmation dialog, opened from a worklog card's trash button.
 *
 * - describeWorklogForDeletion(): the issue, date, start time, and duration shown in the dialog.
 * - createDeleteWorklogSession(): the delete request state (busy guard, error). No DOM.
 * - renderDeleteWorklogDialog(): the dialog contents, built as DOM nodes.
 * - openDeleteWorklogDialog(): shows the dialog in a <dialog> element and wires it to a session.
 */

import { h } from './dom.js';
import { formatDuration } from '../worklog/worklogUtils.js';

// Same "Wednesday, 21 October 2026" shape as the day panel heading in weekView.js.
const WEEKDAY_FORMAT = new Intl.DateTimeFormat('en-GB', { weekday: 'long' });
const LONG_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Describes a worklog for the confirmation, in the browser's local time zone.
 *
 * @param {{ issueKey: string, issueSummary?: string, started: string | Date, timeSpentSeconds: number }} worklog
 * @returns {{ issueKey: string, issueSummary: string, date: string, startTime: string, duration: string }}
 */
export function describeWorklogForDeletion(worklog) {
  const started = new Date(worklog.started);
  const valid = !isNaN(started.getTime());

  return {
    issueKey: worklog.issueKey || '',
    issueSummary: worklog.issueSummary || '',
    date: valid ? `${WEEKDAY_FORMAT.format(started)}, ${LONG_DATE_FORMAT.format(started)}` : '',
    startTime: valid ? started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
    duration: formatDuration(worklog.timeSpentSeconds, { padZeroMinutes: true, alwaysShowHours: true })
  };
}

/**
 * Creates the state for one delete confirmation.
 *
 * @param {() => Promise<void>} onDelete - Deletes the worklog; rejects with a user-facing Error
 */
export function createDeleteWorklogSession(onDelete) {
  const state = { busy: false, error: '' };

  return {
    state,

    /**
     * Deletes the worklog. Ignored while a request is already in progress.
     * @returns {Promise<{ status: 'deleted' | 'error' | 'busy' }>}
     */
    async confirm() {
      if (state.busy) return { status: 'busy' };

      state.busy = true;
      state.error = '';
      try {
        await onDelete();
        return { status: 'deleted' };
      } catch (err) {
        state.error = err?.message || 'The worklog could not be deleted.';
        return { status: 'error' };
      } finally {
        state.busy = false;
      }
    },

    /** @returns {boolean} False while the delete request is in progress */
    canClose() {
      return !state.busy;
    }
  };
}

/**
 * Builds the dialog contents.
 *
 * @param {ReturnType<typeof describeWorklogForDeletion>} details
 * @returns {HTMLElement} The dialog body
 */
export function renderDeleteWorklogDialog(details) {
  const issue = details.issueSummary ? `${details.issueKey} · ${details.issueSummary}` : details.issueKey;
  const date = details.startTime ? `${details.date}, started ${details.startTime}` : details.date;

  return h('div', { class: 'confirm-dialog-body' },
    h('h2', { class: 'confirm-dialog-title', id: 'deleteWorklogTitle' }, 'Delete worklog?'),
    h('p', { class: 'confirm-dialog-text', id: 'deleteWorklogText' }, "This permanently deletes the worklog from Jira. It can't be undone."),
    h('dl', { class: 'confirm-dialog-details' },
      h('dt', {}, 'Issue'),
      h('dd', {}, issue),
      h('dt', {}, 'Date'),
      h('dd', {}, date),
      h('dt', {}, 'Duration'),
      h('dd', {}, details.duration)),
    h('div', { class: 'panel-alert alert-danger confirm-dialog-error hidden', role: 'alert' },
      h('div', { class: 'alert-content' }, h('p', { 'data-delete-error': true }))),
    h('div', { class: 'confirm-dialog-actions' },
      h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'cancel' }, 'Cancel'),
      h('button', { type: 'button', class: 'btn btn-danger btn-sm', 'data-action': 'delete' },
        h('span', { class: 'btn-spinner hidden', 'data-delete-spinner': true }),
        h('span', { 'data-delete-label': true }, 'Delete worklog')))
  );
}

/**
 * Shows the confirmation for a worklog in `dialog` (a <dialog> element). Nothing is
 * deleted until the user clicks Delete; on failure the dialog stays open with the error.
 *
 * @param {HTMLDialogElement} dialog
 * @param {object} options
 * @param {object} options.worklog - Source worklog
 * @param {() => Promise<void>} options.onDelete - Deletes the worklog; rejects with a user-facing Error
 * @param {(reason: 'deleted' | 'cancelled') => void} options.onClose - Called once the dialog has closed
 */
export function openDeleteWorklogDialog(dialog, { worklog, onDelete, onClose }) {
  const session = createDeleteWorklogSession(onDelete);
  let isFinished = false;

  dialog.replaceChildren(renderDeleteWorklogDialog(describeWorklogForDeletion(worklog)));
  dialog.setAttribute('aria-labelledby', 'deleteWorklogTitle');
  dialog.setAttribute('aria-describedby', 'deleteWorklogText');

  // Listeners go on the body, which is replaced on every open, so an earlier dialog
  // can never act on this one.
  const body = dialog.querySelector('.confirm-dialog-body');
  const cancelBtn = body.querySelector('[data-action="cancel"]');
  const deleteBtn = body.querySelector('[data-action="delete"]');

  function sync() {
    const { busy, error } = session.state;
    cancelBtn.disabled = busy;
    deleteBtn.disabled = busy;
    body.querySelector('[data-delete-spinner]').classList.toggle('hidden', !busy);
    body.querySelector('[data-delete-label]').textContent = busy ? 'Deleting…' : 'Delete worklog';
    body.querySelector('[data-delete-error]').textContent = error;
    body.querySelector('.confirm-dialog-error').classList.toggle('hidden', !error);
    dialog.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  // Closes and cleans up synchronously. The dialog's own `close` event fires in a later
  // task, so relying on it would leave a window where the old dialog is still wired up.
  function finish(reason) {
    if (isFinished) return;
    isFinished = true;
    dialog.removeEventListener('cancel', onCancel);
    dialog.removeEventListener('close', onDialogClose);
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    dialog.removeAttribute('aria-busy');
    onClose(reason);
  }

  function onCancel(event) {
    // Escape: handled here, and ignored while the request runs.
    event.preventDefault();
    if (session.canClose()) finish('cancelled');
  }

  function onDialogClose() {
    // Fallback for a close we didn't start.
    finish('cancelled');
  }

  cancelBtn.addEventListener('click', () => {
    if (session.canClose()) finish('cancelled');
  });

  deleteBtn.addEventListener('click', async () => {
    const pending = session.confirm();
    sync();
    const { status } = await pending;
    if (status === 'deleted') {
      finish('deleted');
      return;
    }
    sync();
    if (status === 'error') deleteBtn.focus();
  });

  dialog.addEventListener('cancel', onCancel);
  dialog.addEventListener('close', onDialogClose);

  sync();
  dialog.showModal();
  // The safe choice gets focus.
  cancelBtn.focus();
}
