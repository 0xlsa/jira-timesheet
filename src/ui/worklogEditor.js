/**
 * Worklog panel, used to edit an existing worklog ('edit' mode) or log new work ('create'
 * mode), either on a given issue or on one the user picks in the panel.
 *
 * - createWorklogEditorSession(): editing state (form values, validation, unsaved-changes and
 *   delete confirmations, busy state). No DOM; saving and deleting are injected callbacks.
 * - renderWorklogEditor(): the panel contents, built as DOM nodes.
 * - openWorklogEditor(): mounts the panel and keeps the DOM in sync with the session.
 */

import { h, svg } from './dom.js';
import { renderIssueStatusBadge } from './weekView.js';
import { renderIssuePicker, attachIssuePicker } from './issuePicker.js';
import { showPanel, hidePanel } from './panel.js';
import {
  MAX_DURATION_HOURS,
  toEditForm,
  validateEditForm,
  isEditFormDirty,
  buildWorklogChanges,
  buildNewWorklog,
  isRichComment
} from '../worklog/worklogEdit.js';

// Quick durations offered when logging new work.
const DURATION_PRESETS = [
  { label: '15m', hours: '0', minutes: '15' },
  { label: '30m', hours: '0', minutes: '30' },
  { label: '1h', hours: '1', minutes: '0' }
];

/**
 * Returns true when logging new work needs the user to pick the issue (none was given).
 * @param {object | null | undefined} worklog
 * @param {'edit' | 'create'} mode
 * @returns {boolean}
 */
function needsIssuePick(worklog, mode) {
  return mode === 'create' && !worklog?.issueKey;
}

/**
 * Creates the editing state for one worklog, or for new work on an issue.
 *
 * @param {object | null} worklog - Edit: source worklog (raw `started` and `comment` as Jira returned them).
 *   Create: the issue (`issueId`, `issueKey`, `issueSummary`, `issueStatus`), or null to pick one in the panel.
 * @param {object} options
 * @param {(values: object, issue: object) => Promise<void>} options.onSave - Edit: saves changed fields.
 *   Create: logs the new worklog from buildNewWorklog() on `issue`. Rejects with a user-facing Error.
 * @param {() => Promise<void>} [options.onDelete] - Deletes the worklog (edit only); rejects with a user-facing Error
 * @param {'edit' | 'create'} [options.mode='edit']
 * @param {object} [options.initialForm] - Create: starting values from toNewWorklogForm()
 */
export function createWorklogEditorSession(worklog, { onSave, onDelete, mode = 'edit', initialForm: newForm }) {
  const isCreate = mode === 'create';
  const pickIssue = needsIssuePick(worklog, mode);
  const initialForm = isCreate ? { ...newForm } : toEditForm(worklog);
  const state = {
    form: { ...initialForm },
    errors: {},
    // The issue to log work on; chosen in the panel when none was given
    issue: pickIssue ? null : worklog,
    // 'saving' | 'deleting' while a Jira request is in flight
    busy: null,
    // 'discard' (unsaved changes on close) | 'delete' (confirm deletion)
    confirm: null,
    submitError: ''
  };

  return {
    worklog,
    mode,
    pickIssue,
    initialForm,
    state,

    get isDirty() {
      return isEditFormDirty(initialForm, state.form) || (pickIssue && Boolean(state.issue));
    },

    /**
     * Log work without a given issue only: sets (or clears, with null) the issue to log work on.
     * @param {object | null} issue - `issueId`, `issueKey`, `issueSummary`, `issueStatus`
     */
    setIssue(issue) {
      if (!pickIssue || state.busy) return;
      state.issue = issue || null;
      delete state.errors.issue;
      if (state.confirm === 'discard') state.confirm = null;
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

    /**
     * Log work only: moves the default date to `dateKey` (the day selected in the calendar).
     * It's a new default, not an edit, so it doesn't count as an unsaved change.
     * @param {string} dateKey - YYYY-MM-DD
     */
    setDefaultDate(dateKey) {
      if (!isCreate || state.busy) return;
      initialForm.date = dateKey;
      state.form.date = dateKey;
      delete state.errors.date;
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
     * Validates, then saves the changed fields (edit) or logs the new worklog (create).
     * @returns {Promise<{ status: 'saved' | 'unchanged' | 'invalid' | 'error' | 'busy' }>}
     */
    async save() {
      if (state.busy) return { status: 'busy' };

      state.confirm = null;
      const { errors } = validateEditForm(state.form);
      if (pickIssue && !state.issue) errors.issue = 'Choose the issue to log work on.';
      state.errors = errors;
      if (Object.keys(errors).length > 0) return { status: 'invalid' };

      const values = isCreate ? buildNewWorklog(state.form) : buildWorklogChanges(initialForm, state.form);
      if (!isCreate && Object.keys(values).length === 0) return { status: 'unchanged' };

      state.busy = 'saving';
      state.submitError = '';
      try {
        await onSave(values, state.issue);
        return { status: 'saved' };
      } catch (err) {
        state.submitError = err?.message || (isCreate ? 'The work could not be logged.' : 'The worklog could not be saved.');
        return { status: 'error' };
      } finally {
        state.busy = null;
      }
    },

    /** Asks for confirmation before deleting (edit only). */
    requestDelete() {
      if (!isCreate && !state.busy) state.confirm = 'delete';
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
 * Builds the read-only issue summary: key (linked to Jira), status, and summary.
 * @param {{ issueKey: string, issueSummary?: string, issueStatus?: object }} issue
 * @param {string} baseUrl - Jira instance URL for the issue link
 * @returns {HTMLElement}
 */
export function renderEditorIssue(issue, baseUrl) {
  const issueUrl = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(issue.issueKey)}` : '#';
  return h('div', { class: 'editor-issue' },
    h('div', { class: 'editor-issue-row' },
      h('a', { href: issueUrl, target: '_blank', rel: 'noopener noreferrer', class: 'issue-key-badge', title: `Open ${issue.issueKey || ''} in Jira` },
        issue.issueKey || 'ISSUE'),
      renderIssueStatusBadge(issue.issueStatus)),
    h('p', { class: 'editor-issue-summary' }, issue.issueSummary || 'No summary available'));
}

/**
 * Builds the panel for a worklog, or for logging new work on an issue.
 *
 * @param {object | null} worklog - Source worklog (edit), or the issue (create; null to pick it in the panel)
 * @param {object} form - Initial form values
 * @param {string} baseUrl - Jira instance URL for the issue link
 * @param {object} [options]
 * @param {'edit' | 'create'} [options.mode='edit']
 * @returns {HTMLFormElement}
 */
export function renderWorklogEditor(worklog, form, baseUrl, { mode = 'edit' } = {}) {
  const isCreate = mode === 'create';
  const pickIssue = needsIssuePick(worklog, mode);
  const icon = (attributes, ...shapes) => svg('svg', {
    ...attributes, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'aria-hidden': 'true'
  }, ...shapes);
  const durationField = (id, name, label, value, max, unit) => h('span', { class: 'editor-duration-field' },
    h('label', { for: id, class: 'sr-only' }, label),
    h('input', {
      type: 'number', id, name, value, min: '0', max: String(max), step: '1', inputmode: 'numeric',
      'aria-describedby': 'worklogEditDurationError'
    }),
    h('span', { class: 'editor-duration-unit', 'aria-hidden': 'true' }, unit));

  return h('form', { class: 'editor-form', novalidate: true },
    h('div', { class: 'editor-header' },
      h('h2', { class: 'editor-title', id: 'worklogEditorTitle' }, isCreate ? 'Log work' : 'Edit worklog'),
      h('button', { type: 'button', class: 'editor-icon-btn', 'data-action': 'close', 'aria-label': 'Close editor', title: 'Close' },
        icon({ class: 'icon' },
          svg('line', { x1: '18', y1: '6', x2: '6', y2: '18' }),
          svg('line', { x1: '6', y1: '6', x2: '18', y2: '18' })))),

    h('div', { class: 'editor-body' },
      !pickIssue && renderEditorIssue(worklog, baseUrl),

      h('div', { class: 'editor-note' },
        icon({ class: 'editor-note-icon' },
          svg('circle', { cx: '12', cy: '12', r: '10' }),
          svg('line', { x1: '12', y1: '16', x2: '12', y2: '12' }),
          svg('line', { x1: '12', y1: '8', x2: '12.01', y2: '8' })),
        h('span', {}, pickIssue
          ? 'Find the issue by its key, then enter the date, start time, duration, and work description.'
          : isCreate ? 'Enter the date, start time, duration, and work description.' : 'Edit the date, time, duration, and work description.')),

      h('fieldset', { class: 'editor-fields' },
        pickIssue && renderIssuePicker(),

        h('div', { class: 'form-group' },
          h('label', { for: 'worklogEditDate', class: 'form-label' }, 'Date'),
          h('input', { type: 'date', id: 'worklogEditDate', name: 'date', value: form.date, required: true, 'aria-describedby': 'worklogEditDateError' }),
          h('div', { id: 'worklogEditDateError', class: 'field-error', 'data-error-for': 'date' })),

        h('div', { class: 'form-group' },
          h('label', { for: 'worklogEditTime', class: 'form-label' }, 'Start time'),
          h('input', { type: 'time', id: 'worklogEditTime', name: 'time', value: form.time, required: true, 'aria-describedby': 'worklogEditTimeError' }),
          h('div', { id: 'worklogEditTimeError', class: 'field-error', 'data-error-for': 'time' })),

        h('fieldset', { class: 'form-group editor-duration' },
          h('legend', { class: 'form-label' }, 'Duration'),
          isCreate && h('div', { class: 'editor-duration-presets', role: 'group', 'aria-label': 'Quick durations' },
            DURATION_PRESETS.map((p) => h('button', {
              type: 'button', class: 'duration-preset', 'data-preset-hours': p.hours, 'data-preset-minutes': p.minutes, 'aria-pressed': 'false'
            }, p.label)),
            h('button', { type: 'button', class: 'duration-preset', 'data-action': 'custom-duration', 'aria-pressed': 'false' }, 'Custom')),
          h('div', { class: 'editor-duration-inputs' },
            durationField('worklogEditHours', 'hours', 'Hours', form.hours, MAX_DURATION_HOURS, 'h'),
            durationField('worklogEditMinutes', 'minutes', 'Minutes', form.minutes, 59, 'm')),
          h('div', { id: 'worklogEditDurationError', class: 'field-error', 'data-error-for': 'duration' })),

        h('div', { class: 'form-group' },
          h('label', { for: 'worklogEditComment', class: 'form-label' }, 'Work description (comment)'),
          // A textarea's text is its initial value, like the text between <textarea> tags.
          h('textarea', { id: 'worklogEditComment', name: 'comment', rows: '5' }, form.comment),
          isRichComment(worklog?.comment) && h('div', { class: 'field-hint editor-rich-note' },
            "This comment has formatting from Jira. If you edit it here, it's saved as plain text.")))),

    h('div', { class: 'editor-footer' },
      h('div', { class: 'panel-alert alert-danger editor-submit-error hidden', role: 'alert' },
        h('div', { class: 'alert-content' }, h('p', { 'data-submit-error': true }))),

      h('div', { class: 'editor-actions', 'data-actions': 'main' },
        !isCreate && h('button', { type: 'button', class: 'btn btn-danger-outline btn-sm', 'data-action': 'delete' }, 'Delete worklog'),
        h('span', { class: 'editor-actions-spacer' }),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'cancel' }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-primary btn-sm', 'data-action': 'save' },
          h('span', { class: 'btn-spinner hidden', 'data-spinner': 'saving' }),
          h('span', { 'data-save-label': true }, isCreate ? 'Log work' : 'Save changes'))),

      h('div', { class: 'editor-confirm hidden', 'data-confirm': 'discard', role: 'alertdialog', 'aria-labelledby': 'worklogEditorDiscardText' },
        h('p', { id: 'worklogEditorDiscardText' }, 'You have unsaved changes. Discard them?'),
        h('div', { class: 'editor-actions' },
          h('span', { class: 'editor-actions-spacer' }),
          h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'keep-editing' }, 'Keep editing'),
          h('button', { type: 'button', class: 'btn btn-danger-outline btn-sm', 'data-action': 'discard' }, 'Discard changes'))),

      !isCreate && h('div', { class: 'editor-confirm hidden', 'data-confirm': 'delete', role: 'alertdialog', 'aria-labelledby': 'worklogEditorDeleteText' },
        h('p', { id: 'worklogEditorDeleteText' }, "Delete this worklog from Jira? This can't be undone."),
        h('div', { class: 'editor-actions' },
          h('span', { class: 'editor-actions-spacer' }),
          h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'keep-worklog' }, 'Keep worklog'),
          h('button', { type: 'button', class: 'btn btn-danger btn-sm', 'data-action': 'confirm-delete' },
            h('span', { class: 'btn-spinner hidden', 'data-spinner': 'deleting' }),
            h('span', {}, 'Delete worklog')))))
  );
}

/**
 * Opens the panel inside `root` (an initially hidden panel element), to edit a worklog
 * or to log new work on an issue.
 *
 * @param {HTMLElement} root
 * @param {object} options
 * @param {object | null} options.worklog - Source worklog (edit), or the issue (create; null to pick it in the panel)
 * @param {string} options.baseUrl
 * @param {(values: object, issue: object) => Promise<void>} options.onSave
 * @param {() => Promise<void>} [options.onDelete] - Edit only
 * @param {(reason: 'saved' | 'deleted' | 'closed') => void} options.onClose - Called as soon as the panel closes
 *   (it's inert at once and finishes sliding out afterwards)
 * @param {'edit' | 'create'} [options.mode='edit']
 * @param {object} [options.initialForm] - Create: starting values from toNewWorklogForm()
 * @param {(dateKey: string) => void} [options.onDateChange] - Create: called when the user enters a complete date
 * @param {(query: string, options: { maxResults: number, signal: AbortSignal }) => Promise<Array<object>>} [options.searchIssues]
 *   Create without an issue: finds issues for the issue field (see createIssueSuggester())
 * @returns {{ worklogId: string | null, mode: 'edit' | 'create', readonly isDirty: boolean, requestClose: () => boolean,
 *   focus: () => void, setDefaultDate: (dateKey: string) => void }}
 *   `worklogId` is null when logging new work. `setDefaultDate` only applies when logging new work.
 */
export function openWorklogEditor(root, { worklog, baseUrl, onSave, onDelete, onClose, mode = 'edit', initialForm, onDateChange, searchIssues }) {
  const session = createWorklogEditorSession(worklog, { onSave, onDelete, mode, initialForm });
  const isCreate = mode === 'create';
  const saveLabel = isCreate ? 'Log work' : 'Save changes';
  const firstField = session.pickIssue ? '#worklogIssueSearch' : isCreate ? '#worklogEditHours' : '#worklogEditDate';

  showPanel(root, renderWorklogEditor(worklog, session.initialForm, baseUrl, { mode }));
  root.setAttribute('aria-labelledby', 'worklogEditorTitle');

  const form = root.querySelector('.editor-form');
  const fields = root.querySelector('.editor-fields');
  const inputs = [...root.querySelectorAll('input[name], textarea[name]')];
  const button = (action) => root.querySelector(`[data-action="${action}"]`);
  let isOpen = true;

  // null (not false) without a picker, so `issuePicker?.destroy()` is skipped on close.
  const issuePicker = !session.pickIssue ? null : attachIssuePicker(root.querySelector('[data-issue-picker]'), {
    search: searchIssues ?? (async () => []),
    renderSelected: (issue) => renderEditorIssue(issue, baseUrl),
    onSelect: (issue) => {
      session.setIssue(issue);
      sync();
    }
  });

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
    if (issuePicker) {
      issuePicker.input.classList.toggle('is-invalid', Boolean(state.errors.issue));
      issuePicker.input.setAttribute('aria-invalid', state.errors.issue ? 'true' : 'false');
    }

    const submitError = root.querySelector('.editor-submit-error');
    root.querySelector('[data-submit-error]').textContent = state.submitError;
    submitError.classList.toggle('hidden', !state.submitError);

    // Keep the values while a request runs; just stop edits.
    fields.disabled = Boolean(state.busy);
    button('close').disabled = Boolean(state.busy);
    button('cancel').disabled = Boolean(state.busy);
    // New work can always be submitted (validation explains what's missing); edits need a change.
    button('save').disabled = Boolean(state.busy) || (!isCreate && !session.isDirty);
    for (const action of ['delete', 'keep-worklog', 'confirm-delete']) {
      if (button(action)) button(action).disabled = Boolean(state.busy);
    }
    root.querySelector('[data-spinner="saving"]').classList.toggle('hidden', state.busy !== 'saving');
    root.querySelector('[data-spinner="deleting"]')?.classList.toggle('hidden', state.busy !== 'deleting');
    root.querySelector('[data-save-label]').textContent = state.busy === 'saving' ? 'Saving…' : saveLabel;

    // Quick durations show as pressed when the duration matches; Custom for any other duration.
    const presets = [...root.querySelectorAll('[data-preset-hours]')];
    const matching = presets.find((el) => Number(el.dataset.presetHours) === Number(state.form.hours || 0) &&
      Number(el.dataset.presetMinutes) === Number(state.form.minutes || 0));
    for (const el of presets) {
      el.setAttribute('aria-pressed', el === matching ? 'true' : 'false');
      el.disabled = Boolean(state.busy);
    }
    const custom = button('custom-duration');
    if (custom) {
      custom.setAttribute('aria-pressed', !matching && Boolean(state.form.hours || state.form.minutes) ? 'true' : 'false');
      custom.disabled = Boolean(state.busy);
    }
    root.setAttribute('aria-busy', state.busy ? 'true' : 'false');

    root.querySelector('[data-actions="main"]').classList.toggle('hidden', Boolean(state.confirm));
    for (const el of root.querySelectorAll('[data-confirm]')) {
      el.classList.toggle('hidden', el.dataset.confirm !== state.confirm);
    }
  }

  function close(reason) {
    if (!isOpen) return;
    isOpen = false;
    issuePicker?.destroy();
    hidePanel(root);
    root.removeAttribute('aria-busy');
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
      // Log work: keep the calendar on the day being logged.
      if (isCreate && input.name === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(input.value)) {
        onDateChange?.(input.value);
      }
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
    const preset = event.target.closest('[data-preset-hours]');
    if (isOpen && preset) {
      // Fills the duration only; never submits.
      for (const [field, value] of [['hours', preset.dataset.presetHours], ['minutes', preset.dataset.presetMinutes]]) {
        session.setField(field, value);
        form.querySelector(`[name="${field}"]`).value = value;
      }
      sync();
      return;
    }

    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!isOpen || !action || action === 'save') return;

    if (action === 'custom-duration') {
      root.querySelector('#worklogEditHours').focus();
      root.querySelector('#worklogEditHours').select();
      return;
    }

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
  root.querySelector(firstField).focus();

  return {
    worklogId: isCreate ? null : String(worklog.id),
    mode,
    get isDirty() {
      return isOpen && session.isDirty;
    },
    requestClose: () => !isOpen || attemptClose(),
    focus: () => root.querySelector(firstField)?.focus(),
    setDefaultDate(dateKey) {
      if (!isOpen || !isCreate || session.state.busy) return;
      session.setDefaultDate(dateKey);
      root.querySelector('#worklogEditDate').value = dateKey;
      sync();
    }
  };
}
