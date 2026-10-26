/**
 * Edit Worklog panel.
 *
 * - createWorklogEditorSession(): editing state (form values, validation, unsaved-changes and
 *   delete confirmations, busy state). No DOM; saving and deleting are injected callbacks.
 * - renderWorklogEditor(): the panel markup.
 * - openWorklogEditor(): mounts the panel and keeps the DOM in sync with the session.
 */

import { escapeHtml } from './html.js';
import { renderIssueStatusBadge } from './weekView.js';
import {
  MAX_DURATION_HOURS,
  toEditForm,
  validateEditForm,
  isEditFormDirty,
  buildWorklogChanges,
  isRichComment
} from '../worklog/worklogEdit.js';

/**
 * Creates the editing state for one worklog.
 *
 * @param {object} worklog - Source worklog (raw `started` and `comment` as Jira returned them)
 * @param {object} callbacks
 * @param {(changes: object) => Promise<void>} callbacks.onSave - Saves changed fields; rejects with a user-facing Error
 * @param {() => Promise<void>} callbacks.onDelete - Deletes the worklog; rejects with a user-facing Error
 */
export function createWorklogEditorSession(worklog, { onSave, onDelete }) {
  const initialForm = toEditForm(worklog);
  const state = {
    form: { ...initialForm },
    errors: {},
    // 'saving' | 'deleting' while a Jira request is in flight
    busy: null,
    // 'discard' (unsaved changes on close) | 'delete' (confirm deletion)
    confirm: null,
    submitError: ''
  };

  return {
    worklog,
    initialForm,
    state,

    get isDirty() {
      return isEditFormDirty(initialForm, state.form);
    },

    /**
     * @param {'date' | 'time' | 'hours' | 'minutes' | 'comment'} field
     * @param {string} value
     */
    setField(field, value) {
      if (state.busy) return;
      state.form[field] = value;
      delete state.errors[field === 'hours' || field === 'minutes' ? 'duration' : field];
      if (state.confirm === 'discard') state.confirm = null;
    },

    /**
     * Returns true when the editor can close now. With unsaved changes it asks for
     * confirmation instead (state.confirm = 'discard') and returns false.
     * @returns {boolean}
     */
    requestClose() {
      if (state.busy) return false;
      if (!this.isDirty) return true;
      state.confirm = 'discard';
      return false;
    },

    /** Dismisses the discard or delete confirmation. */
    keepEditing() {
      if (!state.busy) state.confirm = null;
    },

    /**
     * Confirms closing with unsaved changes.
     * @returns {boolean} True when the editor should close
     */
    discardChanges() {
      return state.confirm === 'discard' && !state.busy;
    },

    /**
     * Validates and saves the changed fields.
     * @returns {Promise<{ status: 'saved' | 'unchanged' | 'invalid' | 'error' | 'busy' }>}
     */
    async save() {
      if (state.busy) return { status: 'busy' };

      state.confirm = null;
      const { isValid, errors } = validateEditForm(state.form);
      state.errors = errors;
      if (!isValid) return { status: 'invalid' };

      const changes = buildWorklogChanges(initialForm, state.form);
      if (Object.keys(changes).length === 0) return { status: 'unchanged' };

      state.busy = 'saving';
      state.submitError = '';
      try {
        await onSave(changes);
        return { status: 'saved' };
      } catch (err) {
        state.submitError = err?.message || 'The worklog could not be saved.';
        return { status: 'error' };
      } finally {
        state.busy = null;
      }
    },

    /** Asks for confirmation before deleting. */
    requestDelete() {
      if (!state.busy) state.confirm = 'delete';
    },

    /**
     * Deletes the worklog. Only runs after requestDelete().
     * @returns {Promise<{ status: 'deleted' | 'error' | 'ignored' }>}
     */
    async confirmDelete() {
      if (state.busy || state.confirm !== 'delete') return { status: 'ignored' };

      state.busy = 'deleting';
      state.submitError = '';
      try {
        await onDelete();
        return { status: 'deleted' };
      } catch (err) {
        state.submitError = err?.message || 'The worklog could not be deleted.';
        return { status: 'error' };
      } finally {
        state.busy = null;
        state.confirm = null;
      }
    }
  };
}

/**
 * Builds the panel markup for a worklog.
 *
 * @param {object} worklog - Source worklog
 * @param {object} form - Initial form values from toEditForm()
 * @param {string} baseUrl - Jira instance URL for the issue link
 * @returns {string}
 */
export function renderWorklogEditor(worklog, form, baseUrl) {
  const issueUrl = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(worklog.issueKey)}` : '#';
  const richCommentNote = isRichComment(worklog.comment)
    ? '<div class="field-hint editor-rich-note">This comment has formatting from Jira. If you edit it here, it\'s saved as plain text.</div>'
    : '';

  return `
    <form class="editor-form" novalidate>
      <div class="editor-header">
        <h2 class="editor-title" id="worklogEditorTitle">Edit worklog</h2>
        <button type="button" class="editor-icon-btn" data-action="close" aria-label="Close editor" title="Close">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <div class="editor-body">
        <div class="editor-issue">
          <div class="editor-issue-row">
            <a href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener noreferrer" class="issue-key-badge" title="Open ${escapeHtml(worklog.issueKey)} in Jira">${escapeHtml(worklog.issueKey || 'ISSUE')}</a>
            ${renderIssueStatusBadge(worklog.issueStatus)}
          </div>
          <p class="editor-issue-summary">${escapeHtml(worklog.issueSummary || 'No summary available')}</p>
        </div>

        <div class="editor-note">
          <svg class="editor-note-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
          <span>Edit the date, time, duration, and work description.</span>
        </div>

        <fieldset class="editor-fields">
          <div class="form-group">
            <label for="worklogEditDate" class="form-label">Date</label>
            <input type="date" id="worklogEditDate" name="date" value="${escapeHtml(form.date)}" required aria-describedby="worklogEditDateError">
            <div id="worklogEditDateError" class="field-error" data-error-for="date"></div>
          </div>

          <div class="form-group">
            <label for="worklogEditTime" class="form-label">Start time</label>
            <input type="time" id="worklogEditTime" name="time" value="${escapeHtml(form.time)}" required aria-describedby="worklogEditTimeError">
            <div id="worklogEditTimeError" class="field-error" data-error-for="time"></div>
          </div>

          <fieldset class="form-group editor-duration">
            <legend class="form-label">Duration</legend>
            <div class="editor-duration-inputs">
              <span class="editor-duration-field">
                <label for="worklogEditHours" class="sr-only">Hours</label>
                <input type="number" id="worklogEditHours" name="hours" value="${escapeHtml(form.hours)}" min="0" max="${MAX_DURATION_HOURS}" step="1" inputmode="numeric" aria-describedby="worklogEditDurationError">
                <span class="editor-duration-unit" aria-hidden="true">h</span>
              </span>
              <span class="editor-duration-field">
                <label for="worklogEditMinutes" class="sr-only">Minutes</label>
                <input type="number" id="worklogEditMinutes" name="minutes" value="${escapeHtml(form.minutes)}" min="0" max="59" step="1" inputmode="numeric" aria-describedby="worklogEditDurationError">
                <span class="editor-duration-unit" aria-hidden="true">m</span>
              </span>
            </div>
            <div id="worklogEditDurationError" class="field-error" data-error-for="duration"></div>
          </fieldset>

          <div class="form-group">
            <label for="worklogEditComment" class="form-label">Work description (comment)</label>
            <textarea id="worklogEditComment" name="comment" rows="5" aria-describedby="worklogEditCommentHint">${escapeHtml(form.comment)}</textarea>
            <div id="worklogEditCommentHint" class="field-hint">Describe the work you did. This is saved on the worklog only; the issue title doesn't change.</div>
            ${richCommentNote}
          </div>
        </fieldset>
      </div>

      <div class="editor-footer">
        <div class="panel-alert alert-danger editor-submit-error hidden" role="alert">
          <div class="alert-content"><p data-submit-error></p></div>
        </div>

        <div class="editor-actions" data-actions="main">
          <button type="button" class="btn btn-danger-outline btn-sm" data-action="delete">Delete worklog</button>
          <span class="editor-actions-spacer"></span>
          <button type="button" class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm" data-action="save">
            <span class="btn-spinner hidden" data-spinner="saving"></span>
            <span data-save-label>Save changes</span>
          </button>
        </div>

        <div class="editor-confirm hidden" data-confirm="discard" role="alertdialog" aria-labelledby="worklogEditorDiscardText">
          <p id="worklogEditorDiscardText">You have unsaved changes. Discard them?</p>
          <div class="editor-actions">
            <span class="editor-actions-spacer"></span>
            <button type="button" class="btn btn-secondary btn-sm" data-action="keep-editing">Keep editing</button>
            <button type="button" class="btn btn-danger-outline btn-sm" data-action="discard">Discard changes</button>
          </div>
        </div>

        <div class="editor-confirm hidden" data-confirm="delete" role="alertdialog" aria-labelledby="worklogEditorDeleteText">
          <p id="worklogEditorDeleteText">Delete this worklog from Jira? This can't be undone.</p>
          <div class="editor-actions">
            <span class="editor-actions-spacer"></span>
            <button type="button" class="btn btn-secondary btn-sm" data-action="keep-worklog">Keep worklog</button>
            <button type="button" class="btn btn-danger btn-sm" data-action="confirm-delete">
              <span class="btn-spinner hidden" data-spinner="deleting"></span>
              <span>Delete worklog</span>
            </button>
          </div>
        </div>
      </div>
    </form>
  `;
}

/**
 * Opens the editor for a worklog inside `root` (an initially hidden panel element).
 *
 * @param {HTMLElement} root
 * @param {object} options
 * @param {object} options.worklog - Source worklog
 * @param {string} options.baseUrl
 * @param {(changes: object) => Promise<void>} options.onSave
 * @param {() => Promise<void>} options.onDelete
 * @param {(reason: 'saved' | 'deleted' | 'closed') => void} options.onClose - Called once the panel has closed
 * @returns {{ worklogId: string, readonly isDirty: boolean, requestClose: () => boolean, focus: () => void }}
 */
export function openWorklogEditor(root, { worklog, baseUrl, onSave, onDelete, onClose }) {
  const session = createWorklogEditorSession(worklog, { onSave, onDelete });

  root.innerHTML = renderWorklogEditor(worklog, session.initialForm, baseUrl);
  root.classList.remove('hidden');
  root.setAttribute('aria-labelledby', 'worklogEditorTitle');
  document.documentElement.classList.add('has-worklog-editor');

  const form = root.querySelector('.editor-form');
  const fields = root.querySelector('.editor-fields');
  const inputs = [...root.querySelectorAll('input[name], textarea[name]')];
  const button = (action) => root.querySelector(`[data-action="${action}"]`);
  let isOpen = true;

  function sync() {
    const { state } = session;

    for (const el of root.querySelectorAll('[data-error-for]')) {
      const message = state.errors[el.dataset.errorFor] || '';
      el.textContent = message;
      el.classList.toggle('visible', Boolean(message));
    }
    for (const input of inputs) {
      const errorKey = input.name === 'hours' || input.name === 'minutes' ? 'duration' : input.name;
      const invalid = Boolean(state.errors[errorKey]);
      input.classList.toggle('is-invalid', invalid);
      input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
    }

    const submitError = root.querySelector('.editor-submit-error');
    root.querySelector('[data-submit-error]').textContent = state.submitError;
    submitError.classList.toggle('hidden', !state.submitError);

    // Keep the values while a request runs; just stop edits.
    fields.disabled = Boolean(state.busy);
    button('close').disabled = Boolean(state.busy);
    button('cancel').disabled = Boolean(state.busy);
    button('delete').disabled = Boolean(state.busy);
    button('save').disabled = Boolean(state.busy) || !session.isDirty;
    button('keep-worklog').disabled = Boolean(state.busy);
    button('confirm-delete').disabled = Boolean(state.busy);
    root.querySelector('[data-spinner="saving"]').classList.toggle('hidden', state.busy !== 'saving');
    root.querySelector('[data-spinner="deleting"]').classList.toggle('hidden', state.busy !== 'deleting');
    root.querySelector('[data-save-label]').textContent = state.busy === 'saving' ? 'Saving…' : 'Save changes';
    root.setAttribute('aria-busy', state.busy ? 'true' : 'false');

    root.querySelector('[data-actions="main"]').classList.toggle('hidden', Boolean(state.confirm));
    for (const el of root.querySelectorAll('[data-confirm]')) {
      el.classList.toggle('hidden', el.dataset.confirm !== state.confirm);
    }
  }

  function close(reason) {
    if (!isOpen) return;
    isOpen = false;
    root.classList.add('hidden');
    root.innerHTML = '';
    root.removeAttribute('aria-busy');
    document.documentElement.classList.remove('has-worklog-editor');
    onClose(reason);
  }

  function attemptClose() {
    if (session.requestClose()) {
      close('closed');
      return true;
    }
    sync();
    button('keep-editing')?.focus();
    return false;
  }

  // Listeners go on the form, which is replaced on every open, so a closed editor's
  // session can never react to events in the next one.
  for (const input of inputs) {
    input.addEventListener('input', () => {
      session.setField(input.name, input.value);
      sync();
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!isOpen) return;
    const pending = session.save();
    sync();
    const { status } = await pending;
    if (status === 'saved' || status === 'unchanged') {
      close(status === 'saved' ? 'saved' : 'closed');
      return;
    }
    sync();
    if (status === 'invalid') {
      root.querySelector('input.is-invalid')?.focus();
    } else if (status === 'error') {
      button('save').focus();
    }
  });

  form.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!isOpen || !action || action === 'save') return;

    if (action === 'close' || action === 'cancel') {
      attemptClose();
    } else if (action === 'keep-editing' || action === 'keep-worklog') {
      session.keepEditing();
      sync();
      button(action === 'keep-worklog' ? 'delete' : 'cancel').focus();
    } else if (action === 'discard') {
      if (session.discardChanges()) close('closed');
    } else if (action === 'delete') {
      session.requestDelete();
      sync();
      button('keep-worklog').focus();
    } else if (action === 'confirm-delete') {
      const pending = session.confirmDelete();
      sync();
      const { status } = await pending;
      if (status === 'deleted') {
        close('deleted');
        return;
      }
      sync();
      button('delete').focus();
    }
  });

  form.addEventListener('keydown', (event) => {
    if (!isOpen || event.key !== 'Escape') return;
    event.preventDefault();
    if (session.state.confirm) {
      session.keepEditing();
      sync();
      button('cancel').focus();
    } else {
      attemptClose();
    }
  });

  sync();
  root.querySelector('#worklogEditDate').focus();

  return {
    worklogId: String(worklog.id),
    get isDirty() {
      return isOpen && session.isDirty;
    },
    requestClose: () => !isOpen || attemptClose(),
    focus: () => root.querySelector('#worklogEditDate')?.focus()
  };
}
