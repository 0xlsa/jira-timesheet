/**
 * The custom view editor: a drawer, in the same place as the other drawers, to create or edit a
 * custom view of My Work (src/jira/customViews.js): its name, and its one condition (a
 * field, an operator, and values). Editing also offers Delete, which asks once more.
 *
 * Only what the chosen field allows is offered: Equals alone, and Me alone, for a user field
 * (Assignee, Reporter, an Additional Assignment Field); for the others, Equals (one value) or Is
 * one of (two or more). Status and Priority offer every value Jira lists; a custom field's values
 * are searched in Jira as the user types (Jira's suggestions), the chosen ones staying listed. Then
 * the order Jira sorts the view's issues in: one of ORDER_BY_FIELDS, ascending or descending
 * (Updated, descending, for a new view; the saved order, or that default, when editing).
 * Nothing is saved until Save, and only through `onSave`; checking is `validate`'s (validateViewDraft()).
 */

import { h, svg, fragment } from './dom.js';
import { showPanel, hidePanel } from './panel.js';
import {
  OPERATORS, OPERATOR_LABELS, MAX_VIEW_NAME_LENGTH, CUSTOM_VIEW_RESULT_LIMIT, ORDER_BY_FIELDS, ORDER_DIRECTIONS, ORDER_DIRECTION_LABELS,
  DEFAULT_ORDER_BY, operatorsFor, conditionKind, normalizeOrderBy
} from '../jira/customViews.js';

export const LOADING_VALUES = 'Loading values…';
export const NO_VALUES = 'Jira has no values for this field.';
export const VALUES_UNAVAILABLE = "Couldn't load the values from Jira.";
export const LOADING_FIELDS = 'Loading custom fields…';
export const FIELDS_UNAVAILABLE = "Couldn't load the custom fields from Jira. The standard fields can still be used.";
export const NO_MATCHING_VALUES = 'No values match.';
// A saved status or priority that Jira doesn't list any more.
export const NOT_IN_JIRA = "not in Jira's list";
export const VIEW_SEARCH_HINT = `A view is a Jira search of its own: it lists the first ${CUSTOM_VIEW_RESULT_LIMIT} issues you can see in Jira that match, whether Active lists them or not.`;

// Lists longer than this get a box to filter them by name.
export const VALUE_FILTER_THRESHOLD = 10;
// A custom field's values are searched in Jira once typing pauses this long.
export const VALUE_SEARCH_DELAY_MS = 250;

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
 * @param {(field: object, query: string) => Promise<Array<{ id: string, label: string } | { currentUser: true, label: string }>>} options.loadValues -
 *   The values to offer for a field; for a custom field, those whose name starts with `query`
 * @param {(draft: object) => { errors: object, view: object | null }} options.validate
 * @param {(view: { name: string, conditions: Array<object> }) => Promise<void>} options.onSave - Rejects
 *   with a user-facing Error when it couldn't be saved
 * @param {() => Promise<void>} [options.onDelete] - Editing only; rejects like onSave
 * @param {() => void} options.onClose - Called as soon as the editor closes
 * @param {number} [options.searchDelayMs=VALUE_SEARCH_DELAY_MS] - The pause in typing before a custom
 *   field's values are searched
 * @returns {{ close: () => void, readonly isOpen: boolean }}
 */
export function openCustomViewEditor(root, { view, fields, loadCustomFields, loadValues, validate, onSave, onDelete, onClose, searchDelayMs = VALUE_SEARCH_DELAY_MS }) {
  const editing = Boolean(view);
  const condition = view?.conditions[0] ?? null;
  // The form's values: the chosen field, operator, and values (by key, in the order chosen).
  let field = null;
  let operator = condition?.operator ?? OPERATORS.EQUALS;
  let chosen = new Map(condition ? condition.values.map((value) => [valueKey(value), value]) : []);
  // The values offered (Jira's), and those drawn (with the chosen ones of a searched field).
  let options = [];
  let shown = [];
  let isOpen = true;
  let busy = false;
  let valuesRequest = 0;
  let searchTimer = null;
  // What the values are filtered by (or, for a custom field, searched for), kept while they're drawn again.
  let valueFilter = '';
  const knownFields = [...fields];
  // A custom field's search box, kept while its results are drawn again so typing keeps focus.
  const searchInput = h('input', {
    type: 'search', id: 'customViewValueSearch', class: 'custom-view-input custom-view-value-filter',
    placeholder: 'Search values in Jira', 'aria-label': 'Search values in Jira', 'aria-controls': 'customViewValueResults',
    autocomplete: 'off', spellcheck: 'false'
  });
  const searchResults = h('div', { id: 'customViewValueResults' });

  const nameInput = h('input', {
    type: 'text', id: 'customViewName', class: 'custom-view-input', maxlength: String(MAX_VIEW_NAME_LENGTH),
    autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'customViewNameError', 'aria-required': 'true'
  });
  nameInput.value = view?.name ?? '';
  const fieldSelect = h('select', { id: 'customViewField', class: 'custom-view-input', 'aria-describedby': 'customViewFieldError customViewFieldsStatus' });
  const operatorSelect = h('select', { id: 'customViewOperator', class: 'custom-view-input', 'aria-describedby': 'customViewOperatorError' });
  const valuesBox = h('div', { id: 'customViewValues', class: 'custom-view-values' });
  const valuesLegend = h('legend', { class: 'form-label' }, 'Value');
  // The order: the saved one when editing, Updated descending otherwise.
  const savedOrder = normalizeOrderBy(view?.orderBy) ?? DEFAULT_ORDER_BY;
  const orderBySelect = h('select', { id: 'customViewOrderBy', class: 'custom-view-input', 'aria-describedby': 'customViewOrderByError' },
    ORDER_BY_FIELDS.map((item) => h('option', { value: item.id }, item.name)));
  orderBySelect.value = savedOrder.field;
  const directionInputs = Object.values(ORDER_DIRECTIONS).map((direction) => {
    const input = h('input', { type: 'radio', name: 'customViewOrderDirection', id: `customViewOrder${direction}`, value: direction });
    input.checked = direction === savedOrder.direction;
    return input;
  });
  const errorEl = (id) => h('div', { id, class: 'field-error', role: 'alert' });
  const errors = {
    name: errorEl('customViewNameError'),
    field: errorEl('customViewFieldError'),
    operator: errorEl('customViewOperatorError'),
    values: errorEl('customViewValuesError'),
    orderBy: errorEl('customViewOrderByError'),
    form: errorEl('customViewFormError')
  };
  const fieldsStatus = h('div', { id: 'customViewFieldsStatus', class: 'field-hint' });
  const saveButton = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save');
  const deleteArea = editing ? h('div', { class: 'custom-view-delete' }) : null;

  const form = h('form', { class: 'custom-view-form', novalidate: true },
    h('p', { class: 'field-hint custom-view-hint' }, VIEW_SEARCH_HINT),
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
    h('div', { class: 'form-group' },
      h('label', { for: 'customViewOrderBy', class: 'form-label' }, 'Order by'),
      orderBySelect,
      errors.orderBy),
    h('fieldset', { class: 'form-group custom-view-values-group' },
      h('legend', { class: 'form-label' }, 'Direction'),
      h('div', { class: 'custom-view-directions' }, directionInputs.map((input) => h('label', { class: 'custom-view-direction', for: input.id },
        input, h('span', {}, `${ORDER_DIRECTION_LABELS[input.value]} (${input.value})`))))),
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

  /** Whether the chosen field's values are searched in Jira as the user types (a custom field). */
  const isSearchedField = (item) => item?.kind === 'option' && item.id.startsWith('customfield_');

  /**
   * Draws the values: radio buttons for Equals, checkboxes for Is one of. A custom field has a
   * search box, then its chosen values and Jira's others; the other fields their whole list, with
   * a filter when it's long. `message` says why there are none (loading, or Jira couldn't be asked).
   */
  function renderValues(message) {
    const multiple = operator === OPERATORS.IS_ONE_OF;
    valuesLegend.textContent = multiple ? 'Values' : 'Value';
    if (!field) {
      valuesBox.replaceChildren(h('p', { class: 'field-hint' }, 'Choose a field first.'));
      return;
    }
    // Equals keeps one value at most.
    if (!multiple && chosen.size > 1) chosen = new Map([...chosen].slice(0, 1));
    const item = (option, index) => {
      const key = valueKey(option);
      const input = h('input', {
        type: multiple ? 'checkbox' : 'radio', name: 'customViewValue', id: `customViewValue-${index}`, value: key
      });
      input.checked = chosen.has(key);
      return h('li', { 'data-label': option.label.toLowerCase() },
        h('label', { class: 'custom-view-value', for: `customViewValue-${index}` }, input,
          h('span', {}, option.label),
          option.note && h('span', { class: 'custom-view-value-note' }, ` (${option.note})`)));
    };

    if (isSearchedField(field)) {
      // The chosen values stay listed, checked, whatever the search shows.
      shown = [...chosen.values(), ...options.filter((option) => !chosen.has(valueKey(option)))];
      const status = message || (options.length === 0 ? (valueFilter.trim() ? NO_MATCHING_VALUES : NO_VALUES) : '');
      searchResults.replaceChildren(fragment(
        status && h('p', { class: 'field-hint', role: 'status' }, status),
        shown.length > 0 && h('div', { class: 'custom-view-value-scroll' },
          h('ul', { class: 'custom-view-value-list' }, shown.map(item)))));
      if (valuesBox.firstChild !== searchInput) {
        searchInput.value = valueFilter;
        valuesBox.replaceChildren(searchInput, searchResults);
      }
      return;
    }

    shown = options;
    if (message) {
      valuesBox.replaceChildren(h('p', { class: 'field-hint', role: 'status' }, message));
      return;
    }
    if (options.length === 0) {
      valuesBox.replaceChildren(h('p', { class: 'field-hint', role: 'status' }, NO_VALUES));
      return;
    }
    const filter = options.length > VALUE_FILTER_THRESHOLD && h('input', {
      type: 'search', id: 'customViewValueFilter', class: 'custom-view-input custom-view-value-filter',
      placeholder: 'Filter values', 'aria-label': 'Filter values', autocomplete: 'off', spellcheck: 'false'
    });
    const noMatch = h('p', { class: 'field-hint hidden', role: 'status' }, NO_MATCHING_VALUES);
    const list = h('ul', { class: 'custom-view-value-list' }, options.map(item));
    valuesBox.replaceChildren(fragment(filter, h('div', { class: 'custom-view-value-scroll' }, list), noMatch));

    /** Shows only the values whose name has the filter's text. */
    const applyFilter = () => {
      const wanted = valueFilter.trim().toLowerCase();
      let count = 0;
      for (const li of list.querySelectorAll('li')) {
        const visible = !wanted || li.dataset.label.includes(wanted);
        li.classList.toggle('hidden', !visible);
        if (visible) count++;
      }
      noMatch.classList.toggle('hidden', count > 0);
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
   * Loads the values for the chosen field: Me for a user field; Jira's whole list for Status and
   * Priority, adding the view's saved values Jira doesn't list any more (marked); Jira's
   * suggestions for what's typed for a custom field.
   */
  async function showValues() {
    const request = ++valuesRequest;
    clearTimeout(searchTimer);
    if (!field) {
      options = [];
      renderValues();
      return;
    }
    options = [];
    renderValues(LOADING_VALUES);
    let loaded;
    try {
      loaded = await loadValues(field, isSearchedField(field) ? valueFilter.trim() : '');
    } catch {
      if (request === valuesRequest && isOpen) renderValues(VALUES_UNAVAILABLE);
      return;
    }
    if (request !== valuesRequest || !isOpen) return;
    options = [...loaded];
    if (field.kind === 'user') {
      // Me is a user field's only value: chosen already.
      chosen = new Map(options.slice(0, 1).map((option) => [valueKey(option), option]));
    } else if (!isSearchedField(field)) {
      for (const value of chosen.values()) {
        if (!options.some((option) => valueKey(option) === valueKey(value))) options.push({ ...value, note: NOT_IN_JIRA });
      }
    }
    renderValues();
  }

  /**
   * Changes the field. Choosing another one starts its values afresh; `keepValues` keeps the view's
   * saved values (its saved field, known only once the custom fields have loaded).
   */
  function chooseField(id, { keepValues = false } = {}) {
    const next = knownFields.find((item) => item.id === id) ?? null;
    if (next?.id !== field?.id) {
      valueFilter = '';
      searchInput.value = '';
      if (!keepValues) chosen = new Map();
    }
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
    orderBySelect.classList.toggle('is-invalid', Boolean(found.orderBy));
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
    clearTimeout(searchTimer);
    hidePanel(root);
    onClose();
  }

  async function save() {
    if (busy) return;
    const draft = {
      name: nameInput.value,
      field: field && { id: field.id, name: field.name, kind: field.kind },
      operator,
      values: [...chosen.values()].map((value) => (value.currentUser ? { currentUser: true, label: 'Me' } : { id: value.id, label: value.label })),
      orderBy: { field: orderBySelect.value, direction: directionInputs.find((input) => input.checked)?.value }
    };
    const { errors: found, view: valid } = validate(draft);
    showErrors(found);
    if (!valid) {
      (found.name ? nameInput : found.field ? fieldSelect : found.operator ? operatorSelect
        : found.values ? valuesBox.querySelector('input') ?? nameInput : found.orderBy ? orderBySelect : nameInput).focus();
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
    const option = input && shown.find((value) => valueKey(value) === input.value);
    if (!option) return;
    if (input.type === 'radio') chosen = new Map([[input.value, option]]);
    else if (input.checked) chosen.set(input.value, option);
    else chosen.delete(input.value);
  });
  // A custom field's values: searched in Jira once typing pauses.
  searchInput.addEventListener('input', () => {
    valueFilter = searchInput.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(showValues, searchDelayMs);
  });
  // Enter searches; it doesn't save the view.
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    showValues();
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
    get isOpen() {
      return isOpen;
    }
  };
}
