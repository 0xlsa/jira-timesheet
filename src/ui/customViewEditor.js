/**
 * The custom view editor: a drawer, in the same place as the other drawers, to create or edit a
 * custom view of My Active Issues (src/jira/customViews.js): its name, and its one condition (a
 * field, an operator, and values). Editing also offers Delete, which asks once more.
 *
 * Only what the chosen field allows is offered: Equals alone, and Me alone, for a user field
 * (Assignee, Reporter, an Additional Assignment Field); for the others, Equals (one value) or Is
 * one of (two or more), with the values the issues already loaded have. Those follow the issues:
 * when they load again, refreshValues() offers their values, keeping what's chosen. Nothing is
 * saved until Save, and only through `onSave`; checking is `validate`'s (validateViewDraft()).
 */

import { h, svg, fragment } from './dom.js';
import { showPanel, hidePanel } from './panel.js';
import { OPERATORS, OPERATOR_LABELS, MAX_VIEW_NAME_LENGTH, operatorsFor, conditionKind } from '../jira/customViews.js';

export const LOADING_VALUES = 'Loading values…';
export const NO_VALUES = 'None of your active issues has a value for this field.';
export const VALUES_UNAVAILABLE = "Couldn't load the values from Jira.";
export const LOADING_FIELDS = 'Loading custom fields…';
export const FIELDS_UNAVAILABLE = "Couldn't load the custom fields from Jira. The standard fields can still be used.";
export const VALUES_LISTED = 'In your active issues';
export const VALUES_OTHERS = 'Also in Jira';
export const NO_MATCHING_VALUES = 'No values match.';

// Lists longer than this get a box to filter them by name.
export const VALUE_FILTER_THRESHOLD = 10;

const closeIcon = () => svg('svg', {
  class: 'icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'aria-hidden': 'true'
}, svg('line', { x1: '18', y1: '6', x2: '6', y2: '18' }), svg('line', { x1: '6', y1: '6', x2: '18', y2: '18' }));

/** A value's key in the form: its ID, or `me`. */
const valueKey = (value) => (value.currentUser ? 'me' : value.id);

/**
 * Opens the editor inside `root` (an initially hidden panel element). Focus moves to the name.
 * Escape, Cancel, or the close button closes it without saving.
 *
 * @param {HTMLElement} root
 * @param {object} options
 * @param {{ id: string, name: string, conditions: Array<object> } | null} options.view - The view to
 *   edit; null to create one
 * @param {Array<{ id: string, name: string, kind: 'user' | 'option', group: string }>} options.fields -
 *   The fields to offer at once (the standard ones and the Additional Assignment Fields)
 * @param {() => Promise<Array<{ id: string, name: string, kind: 'option' }>>} [options.loadCustomFields] -
 *   The site's custom single-select fields, offered once loaded
 * @param {(field: object) => Promise<Array<{ id: string, label: string } | { currentUser: true, label: string }>>} options.loadValues
 * @param {(draft: object) => { errors: object, view: object | null }} options.validate
 * @param {(view: { name: string, conditions: Array<object> }) => Promise<void>} options.onSave - Rejects
 *   with a user-facing Error when it couldn't be saved
 * @param {() => Promise<void>} [options.onDelete] - Editing only; rejects like onSave
 * @param {() => void} options.onClose - Called as soon as the editor closes
 * @returns {{ close: () => void, refreshValues: () => void, readonly isOpen: boolean }}
 */
export function openCustomViewEditor(root, { view, fields, loadCustomFields, loadValues, validate, onSave, onDelete, onClose }) {
  const editing = Boolean(view);
  const condition = view?.conditions[0] ?? null;
  // The form's values: the chosen field, operator, and values (by key).
  let field = null;
  let operator = condition?.operator ?? OPERATORS.EQUALS;
  let selected = new Set(condition ? condition.values.map(valueKey) : []);
  let options = [];
  let isOpen = true;
  let busy = false;
  let valuesRequest = 0;
  // What the values are filtered by, kept while they're drawn again.
  let valueFilter = '';
  const knownFields = [...fields];

  const nameInput = h('input', {
    type: 'text', id: 'customViewName', class: 'custom-view-input', maxlength: String(MAX_VIEW_NAME_LENGTH),
    autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'customViewNameError', 'aria-required': 'true'
  });
  nameInput.value = view?.name ?? '';
  const fieldSelect = h('select', { id: 'customViewField', class: 'custom-view-input', 'aria-describedby': 'customViewFieldError customViewFieldsStatus' });
  const operatorSelect = h('select', { id: 'customViewOperator', class: 'custom-view-input', 'aria-describedby': 'customViewOperatorError' });
  const valuesBox = h('div', { id: 'customViewValues', class: 'custom-view-values' });
  const valuesLegend = h('legend', { class: 'form-label' }, 'Value');
  const errorEl = (id) => h('div', { id, class: 'field-error', role: 'alert' });
  const errors = {
    name: errorEl('customViewNameError'),
    field: errorEl('customViewFieldError'),
    operator: errorEl('customViewOperatorError'),
    values: errorEl('customViewValuesError'),
    form: errorEl('customViewFormError')
  };
  const fieldsStatus = h('div', { id: 'customViewFieldsStatus', class: 'field-hint' });
  const saveButton = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save');
  const deleteArea = editing ? h('div', { class: 'custom-view-delete' }) : null;

  const form = h('form', { class: 'custom-view-form', novalidate: true },
    h('div', { class: 'form-group' },
      h('label', { for: 'customViewName', class: 'form-label' }, 'Name'),
      nameInput,
      errors.name),
    h('div', { class: 'form-group' },
      h('label', { for: 'customViewField', class: 'form-label' }, 'Field'),
      fieldSelect,
      fieldsStatus,
      errors.field),
    h('div', { class: 'form-group' },
      h('label', { for: 'customViewOperator', class: 'form-label' }, 'Operator'),
      operatorSelect,
      errors.operator),
    h('fieldset', { class: 'form-group custom-view-values-group', 'aria-describedby': 'customViewValuesError' },
      valuesLegend,
      valuesBox,
      errors.values),
    errors.form,
    h('div', { class: 'custom-view-actions' },
      saveButton,
      h('button', { type: 'button', class: 'btn btn-secondary', 'data-action': 'cancel-view' }, 'Cancel')),
    deleteArea);

  const contents = h('div', { class: 'custom-view-editor-body' },
    h('div', { class: 'custom-view-header' },
      h('h2', { class: 'custom-view-title', id: 'customViewTitle' }, editing ? 'Edit view' : 'New view'),
      h('button', { type: 'button', class: 'editor-icon-btn', 'data-action': 'close-view-editor', 'aria-label': 'Close the view editor', title: 'Close' },
        closeIcon())),
    h('div', { class: 'custom-view-scroll' }, form));

  /** Fills the field list: the standard fields, the Additional Assignment Fields, the custom fields. */
  function renderFieldOptions() {
    const groups = new Map();
    for (const item of knownFields) {
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group).push(item);
    }
    const unknownSaved = condition && !knownFields.some((item) => item.id === condition.field.id);
    // fragment() flattens the groups and leaves out what isn't there (replaceChildren() would add them as text).
    fieldSelect.replaceChildren(fragment(
      h('option', { value: '' }, 'Choose a field…'),
      [...groups].map(([label, items]) => h('optgroup', { label },
        items.map((item) => h('option', { value: item.id }, item.name)))),
      // A saved field that isn't offered any more: shown, but can't be chosen again.
      unknownSaved && h('option', { value: condition.field.id, disabled: true }, `${condition.field.name} (no longer available)`)));
    fieldSelect.value = field?.id ?? '';
  }

  /** Fills the operators the chosen field allows, keeping the chosen one when it still applies. */
  function renderOperators() {
    const allowed = field ? operatorsFor(field.kind) : [];
    if (!allowed.includes(operator)) operator = allowed[0] ?? OPERATORS.EQUALS;
    operatorSelect.replaceChildren(...allowed.map((id) => h('option', { value: id }, OPERATOR_LABELS[id])));
    operatorSelect.value = operator;
    operatorSelect.disabled = !field || allowed.length < 2;
  }

  /** Draws the values: radio buttons for Equals, checkboxes for Is one of. */
  function renderValues(message) {
    const multiple = operator === OPERATORS.IS_ONE_OF;
    valuesLegend.textContent = multiple ? 'Values' : 'Value';
    if (message) {
      valuesBox.replaceChildren(h('p', { class: 'field-hint', role: 'status' }, message));
      return;
    }
    if (!field) {
      valuesBox.replaceChildren(h('p', { class: 'field-hint' }, 'Choose a field first.'));
      return;
    }
    if (options.length === 0) {
      valuesBox.replaceChildren(h('p', { class: 'field-hint', role: 'status' }, NO_VALUES));
      return;
    }
    // Equals keeps one value at most.
    if (!multiple && selected.size > 1) selected = new Set([...selected].slice(0, 1));
    const item = (option) => {
      const index = options.indexOf(option);
      const key = valueKey(option);
      const input = h('input', {
        type: multiple ? 'checkbox' : 'radio', name: 'customViewValue', id: `customViewValue-${index}`, value: key
      });
      input.checked = selected.has(key);
      return h('li', { 'data-label': option.label.toLowerCase() },
        h('label', { class: 'custom-view-value', for: `customViewValue-${index}` }, input, h('span', {}, option.label)));
    };
    // The values the listed issues have first, then Jira's others (Status and Priority), each under
    // its heading; one list without headings when there's only one kind.
    const listed = options.filter((option) => option.listed !== false);
    const others = options.filter((option) => option.listed === false);
    const groups = listed.length && others.length ? [[VALUES_LISTED, listed], [VALUES_OTHERS, others]] : [[null, options]];
    const filter = options.length > VALUE_FILTER_THRESHOLD && h('input', {
      type: 'search', id: 'customViewValueFilter', class: 'custom-view-input custom-view-value-filter',
      placeholder: 'Filter values', 'aria-label': 'Filter values', autocomplete: 'off', spellcheck: 'false'
    });
    const noMatch = h('p', { class: 'field-hint hidden', role: 'status' }, NO_MATCHING_VALUES);
    const lists = h('div', { class: 'custom-view-value-scroll' }, groups.map(([heading, values]) => h('div', { class: 'custom-view-value-group' },
      heading && h('p', { class: 'custom-view-values-heading' }, heading),
      h('ul', { class: 'custom-view-value-list' }, values.map(item)))));
    valuesBox.replaceChildren(fragment(filter, lists, noMatch));

    /** Shows only the values whose name has the filter's text, and the headings of groups with some. */
    const applyFilter = () => {
      const wanted = valueFilter.trim().toLowerCase();
      let shown = 0;
      for (const group of lists.querySelectorAll('.custom-view-value-group')) {
        let groupShown = 0;
        for (const li of group.querySelectorAll('li')) {
          const visible = !wanted || li.dataset.label.includes(wanted);
          li.classList.toggle('hidden', !visible);
          if (visible) groupShown++;
        }
        group.classList.toggle('hidden', groupShown === 0);
        shown += groupShown;
      }
      noMatch.classList.toggle('hidden', shown > 0);
    };
    if (filter) {
      filter.value = valueFilter;
      filter.addEventListener('input', () => {
        valueFilter = filter.value;
        applyFilter();
      });
      // Enter filters; it doesn't save the view.
      filter.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') event.preventDefault();
      });
    } else {
      valueFilter = '';
    }
    applyFilter();
  }

  /**
   * Loads the values for the chosen field, adding the view's saved ones the issues don't have now.
   * `quiet` (the issues loaded again) keeps the values shown while loading, and after a failure.
   */
  async function showValues({ quiet = false } = {}) {
    const request = ++valuesRequest;
    if (!field) {
      options = [];
      renderValues();
      return;
    }
    if (!quiet) {
      options = [];
      renderValues(LOADING_VALUES);
    }
    let loaded;
    try {
      loaded = await loadValues(field);
    } catch {
      if (request === valuesRequest && isOpen && !quiet) renderValues(VALUES_UNAVAILABLE);
      return;
    }
    if (request !== valuesRequest || !isOpen) return;
    const saved = condition && condition.field.id === field.id && conditionKind(condition) === field.kind ? condition.values : [];
    options = [...loaded];
    for (const value of saved) {
      if (!options.some((option) => valueKey(option) === valueKey(value))) options.push({ ...value, label: `${value.label} (not in your current issues)` });
    }
    const available = new Set(options.map(valueKey));
    selected = new Set([...selected].filter((key) => available.has(key)));
    // Me is a user field's only value: chosen already.
    if (field.kind === 'user') selected = new Set(['me']);
    renderValues();
  }

  /**
   * Changes the field. Choosing another one starts its values afresh; `keepValues` keeps the view's
   * saved values (its saved field, known only once the custom fields have loaded).
   */
  function chooseField(id, { keepValues = false } = {}) {
    const next = knownFields.find((item) => item.id === id) ?? null;
    if (next?.id !== field?.id) valueFilter = '';
    if (!keepValues && next?.id !== field?.id) selected = new Set();
    field = next;
    fieldSelect.value = field?.id ?? '';
    renderOperators();
    showValues();
  }

  function showErrors(found) {
    for (const [key, el] of Object.entries(errors)) {
      el.textContent = found[key] || '';
      el.classList.toggle('visible', Boolean(found[key]));
    }
    nameInput.classList.toggle('is-invalid', Boolean(found.name));
    fieldSelect.classList.toggle('is-invalid', Boolean(found.field));
  }

  function setBusy(isBusy) {
    busy = isBusy;
    for (const button of contents.querySelectorAll('button')) {
      if (button.dataset.action !== 'close-view-editor') button.disabled = isBusy;
    }
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    hidePanel(root);
    onClose();
  }

  async function save() {
    if (busy) return;
    const draft = {
      name: nameInput.value,
      field: field && { id: field.id, name: field.name, kind: field.kind },
      operator,
      values: options.filter((option) => selected.has(valueKey(option)))
        .map((option) => (option.currentUser ? { currentUser: true, label: 'Me' } : { id: option.id, label: option.label.replace(/ \(not in your current issues\)$/, '') }))
    };
    const { errors: found, view: valid } = validate(draft);
    showErrors(found);
    if (!valid) {
      (found.name ? nameInput : found.field ? fieldSelect : found.operator ? operatorSelect : valuesBox.querySelector('input') ?? nameInput).focus();
      return;
    }
    setBusy(true);
    try {
      await onSave(valid);
      close();
    } catch (err) {
      if (!isOpen) return;
      showErrors({ form: err.message || "Couldn't save the view. Try again." });
      setBusy(false);
    }
  }

  function askToDelete() {
    deleteArea.replaceChildren(
      h('p', { class: 'custom-view-delete-question' }, `Delete the ${view.name} view? This can't be undone.`),
      h('div', { class: 'custom-view-actions' },
        h('button', { type: 'button', class: 'btn btn-danger', 'data-action': 'confirm-delete-view' }, 'Delete view'),
        h('button', { type: 'button', class: 'btn btn-secondary', 'data-action': 'keep-view' }, 'Keep it')));
    deleteArea.querySelector('[data-action="keep-view"]').focus();
  }

  function showDeleteButton() {
    deleteArea?.replaceChildren(h('button', { type: 'button', class: 'btn btn-danger-outline', 'data-action': 'delete-view' }, 'Delete view'));
  }

  async function confirmDelete() {
    if (busy) return;
    setBusy(true);
    try {
      await onDelete();
      close();
    } catch (err) {
      if (!isOpen) return;
      showErrors({ form: err.message || "Couldn't delete the view. Try again." });
      setBusy(false);
    }
  }

  // Listeners are on the editor's contents, which are replaced on every open.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    save();
  });
  fieldSelect.addEventListener('change', () => chooseField(fieldSelect.value));
  operatorSelect.addEventListener('change', () => {
    operator = operatorSelect.value;
    renderValues();
  });
  valuesBox.addEventListener('change', (event) => {
    const input = event.target.closest?.('input[name="customViewValue"]');
    if (!input) return;
    if (input.type === 'radio') selected = new Set([input.value]);
    else if (input.checked) selected.add(input.value);
    else selected.delete(input.value);
  });
  contents.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'close-view-editor' || action === 'cancel-view') close();
    else if (action === 'delete-view') askToDelete();
    else if (action === 'keep-view') {
      showDeleteButton();
      deleteArea.querySelector('button').focus();
    } else if (action === 'confirm-delete-view') confirmDelete();
  });
  contents.addEventListener('keydown', (event) => {
    if (!isOpen || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });

  showDeleteButton();
  renderFieldOptions();
  // Editing: the saved field, when it's offered (otherwise it's shown as no longer available).
  field = condition ? knownFields.find((item) => item.id === condition.field.id && item.kind === conditionKind(condition)) ?? null : null;
  fieldSelect.value = field?.id ?? '';
  renderOperators();
  showValues();

  if (loadCustomFields) {
    fieldsStatus.textContent = LOADING_FIELDS;
    loadCustomFields().then((custom) => {
      if (!isOpen) return;
      for (const item of custom) if (!knownFields.some((known) => known.id === item.id)) knownFields.push({ ...item, group: 'Custom fields' });
      fieldsStatus.textContent = '';
      renderFieldOptions();
      // A saved custom field becomes the chosen one once it's known, with its saved values.
      const savedField = !field && condition && knownFields.find((item) => item.id === condition.field.id && item.kind === conditionKind(condition));
      if (savedField) chooseField(savedField.id, { keepValues: true });
    }, () => {
      if (isOpen) fieldsStatus.textContent = FIELDS_UNAVAILABLE;
    });
  }

  showPanel(root, contents);
  root.setAttribute('aria-labelledby', 'customViewTitle');
  nameInput.focus();

  return {
    close,
    /** The issues loaded again: offers the chosen field's values from them, keeping what's chosen. */
    refreshValues() {
      if (isOpen && field) showValues({ quiet: true });
    },
    get isOpen() {
      return isOpen;
    }
  };
}
