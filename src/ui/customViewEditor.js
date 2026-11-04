/**
 * The custom view editor: a drawer, in the same place as the other drawers, to create or edit a
 * custom view of My Work (src/jira/customViews.js): its name, its conditions (each a field, an
 * operator, and values; an issue must meet all of them), and its order. Editing also offers Delete,
 * which asks once more.
 *
 * Conditions are cards, numbered in order: + Add Condition adds an empty one, and each card's Delete
 * takes it away (the others keep what they have). A card's header (chevron and number) expands and
 * collapses it; collapsed, one line sums it up ("Status · Not in · Pending, Verify"). A view with
 * several conditions opens with them collapsed; a new condition, a single one, and one with an
 * error on Save show expanded. Every field offers In and Not in, each with
 * one or more values (checkboxes); a user field (Assignee, Reporter, a custom user field) has Me
 * alone, chosen already. Choosing another field starts the condition afresh (In, no values);
 * changing the operator keeps the values. Status and Priority offer every value Jira lists; a custom
 * field's values are searched in Jira as the user types (Jira's suggestions), the chosen ones
 * staying listed. Then the order Jira sorts the view's issues in: one of ORDER_BY_FIELDS, ascending
 * or descending (Updated, descending, for a new view; the saved order, or that default, when editing).
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
export const VIEW_SEARCH_HINT = `A view is a Jira search of its own: it lists the first ${CUSTOM_VIEW_RESULT_LIMIT} issues you can see in Jira that match all its conditions, whether Active lists them or not.`;
export const ADD_CONDITION = '+ Add Condition';

// Lists longer than this get a box to filter them by name.
export const VALUE_FILTER_THRESHOLD = 10;
// A custom field's values are searched in Jira once typing pauses this long.
export const VALUE_SEARCH_DELAY_MS = 250;

const closeIcon = () => svg('svg', {
  class: 'icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'aria-hidden': 'true'
}, svg('line', { x1: '18', y1: '6', x2: '6', y2: '18' }), svg('line', { x1: '6', y1: '6', x2: '18', y2: '18' }));

/** A value's key in the form: its ID, or `me`. */
const valueKey = (value) => (value.currentUser ? 'me' : value.id);

/** Values in alphabetical order (then by key, for equal names). */
const byLabel = (a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }) || valueKey(a).localeCompare(valueKey(b));

/** Whether a field's values are searched in Jira as the user types (a custom option field). */
const isSearchedField = (item) => item?.kind === 'option' && item.id.startsWith('customfield_');

/** An error line below a control, which `showError` fills. */
const errorEl = (id) => h('div', { id, class: 'field-error', role: 'alert' });

function showError(el, message) {
  el.textContent = message || '';
  el.classList.toggle('visible', Boolean(message));
}

/**
 * Opens the editor inside `root` (an initially hidden panel element). Focus moves to the name.
 * Escape, Cancel, or the close button closes it without saving.
 *
 * @param {HTMLElement} root
 * @param {object} options
 * @param {{ id: string, name: string, conditions: Array<object>, orderBy?: object } | null} options.view - The
 *   view to edit; null to create one (with one empty condition)
 * @param {Array<{ id: string, name: string, kind: 'user' | 'option', group: string }>} options.fields -
 *   The fields to offer at once (the standard ones and the Additional Assignment Fields)
 * @param {() => Promise<Array<{ id: string, name: string, kind: 'user' | 'option', group: string }>>} [options.loadCustomFields] -
 *   The site's other fields views can use (custom single-select and user fields), offered once loaded
 * @param {(field: object, query: string) => Promise<Array<{ id: string, label: string } | { currentUser: true, label: string }>>} options.loadValues -
 *   The values to offer for a field; for a custom field, those whose name starts with `query`
 * @param {(draft: object) => { errors: object, view: object | null }} options.validate
 * @param {(view: { name: string, conditions: Array<object>, orderBy: object }) => Promise<void>} options.onSave -
 *   Rejects with a user-facing Error when it couldn't be saved
 * @param {() => Promise<void>} [options.onDelete] - Editing only; rejects like onSave
 * @param {() => void} options.onClose - Called as soon as the editor closes
 * @param {number} [options.searchDelayMs=VALUE_SEARCH_DELAY_MS] - The pause in typing before a custom
 *   field's values are searched
 * @returns {{ close: () => void, readonly isOpen: boolean }}
 */
export function openCustomViewEditor(root, { view, fields, loadCustomFields, loadValues, validate, onSave, onDelete, onClose, searchDelayMs = VALUE_SEARCH_DELAY_MS }) {
  const editing = Boolean(view);
  let isOpen = true;
  let busy = false;
  const knownFields = [...fields];
  // The condition blocks, in order; each has its own ID (`uid`), which its controls' IDs end with.
  const blocks = [];
  let nextBlockId = 0;

  const nameInput = h('input', {
    type: 'text', id: 'customViewName', class: 'custom-view-input', maxlength: String(MAX_VIEW_NAME_LENGTH),
    autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'customViewNameError', 'aria-required': 'true'
  });
  nameInput.value = view?.name ?? '';
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
  const errors = {
    name: errorEl('customViewNameError'),
    conditions: errorEl('customViewConditionsError'),
    orderBy: errorEl('customViewOrderByError'),
    form: errorEl('customViewFormError')
  };
  const fieldsStatus = h('div', { id: 'customViewFieldsStatus', class: 'field-hint' });
  const conditionList = h('div', { class: 'custom-view-conditions' });
  const addConditionButton = h('button', { type: 'button', class: 'btn btn-secondary btn-sm custom-view-add-condition', 'data-action': 'add-condition' }, ADD_CONDITION);
  const saveButton = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save');
  const deleteArea = editing ? h('div', { class: 'custom-view-delete' }) : null;

  const form = h('form', { class: 'custom-view-form', novalidate: true },
    h('p', { class: 'field-hint custom-view-hint' }, VIEW_SEARCH_HINT),
    h('div', { class: 'form-group' },
      h('label', { for: 'customViewName', class: 'form-label' }, 'Name'),
      nameInput,
      errors.name),
    h('div', { class: 'form-group custom-view-conditions-group', role: 'group', 'aria-labelledby': 'customViewConditionsTitle' },
      h('p', { class: 'form-label', id: 'customViewConditionsTitle' }, 'Conditions'),
      fieldsStatus,
      conditionList,
      errors.conditions,
      addConditionButton),
    h('div', { class: 'form-group' },
      h('label', { for: 'customViewOrderBy', class: 'form-label' }, 'Order by'),
      orderBySelect,
      errors.orderBy),
    // Ascending and Descending say what they are: their group is named for assistive technology only.
    h('fieldset', { class: 'form-group custom-view-values-group' },
      h('legend', { class: 'sr-only' }, 'Direction'),
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

  /**
   * One condition's block: its number and Remove, then its field, operator, and values, with their
   * own state. `saved` is the view's condition it starts from; none for an empty one.
   */
  function createConditionBlock(saved = null) {
    const uid = ++nextBlockId;
    const id = (name) => `${name}-${uid}`;
    // The condition's values: the chosen field, operator, and values (by key, in the order chosen).
    let field = null;
    let operator = saved?.operator ?? OPERATORS.IN;
    let chosen = new Map(saved ? saved.values.map((value) => [valueKey(value), value]) : []);
    // The values offered (Jira's), and those drawn (with the chosen ones of a searched field).
    let options = [];
    let shown = [];
    let valuesRequest = 0;
    let searchTimer = null;
    // What the values are filtered by (or, for a custom field, searched for), kept while they're drawn again.
    let valueFilter = '';
    const valueName = id('customViewValue');

    const title = h('span', { class: 'custom-view-condition-title', id: id('customViewConditionTitle') });
    // What the condition compares, shown while it's collapsed.
    const summary = h('p', { class: 'custom-view-condition-summary', id: id('customViewConditionSummary') });
    const toggleButton = h('button', {
      type: 'button', class: 'custom-view-condition-toggle', 'data-action': 'toggle-condition',
      'aria-controls': id('customViewConditionBody'), 'aria-describedby': summary.id
    },
      svg('svg', {
        class: 'custom-view-condition-chevron', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true'
      }, svg('polyline', { points: '6 9 12 15 18 9' })),
      title);
    const deleteButton = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'delete-condition' }, 'Delete');
    const fieldSelect = h('select', { id: id('customViewField'), class: 'custom-view-input', 'aria-describedby': `${id('customViewFieldError')} customViewFieldsStatus` });
    const operatorSelect = h('select', { id: id('customViewOperator'), class: 'custom-view-input', 'aria-describedby': id('customViewOperatorError') });
    const valuesBox = h('div', { id: id('customViewValues'), class: 'custom-view-values' });
    const valuesLegend = h('legend', { class: 'form-label' }, 'Values');
    const blockErrors = {
      field: errorEl(id('customViewFieldError')),
      operator: errorEl(id('customViewOperatorError')),
      values: errorEl(id('customViewValuesError'))
    };
    // A custom field's search box, kept while its results are drawn again so typing keeps focus.
    const searchInput = h('input', {
      type: 'search', id: id('customViewValueSearch'), class: 'custom-view-input custom-view-value-filter',
      placeholder: 'Search values in Jira', 'aria-label': 'Search values in Jira', 'aria-controls': id('customViewValueResults'),
      autocomplete: 'off', spellcheck: 'false'
    });
    const searchResults = h('div', { id: id('customViewValueResults') });

    const body = h('div', { id: id('customViewConditionBody'), class: 'custom-view-condition-body' },
      h('div', { class: 'form-group' },
        h('label', { for: fieldSelect.id, class: 'form-label' }, 'Field'),
        fieldSelect,
        blockErrors.field),
      h('div', { class: 'form-group' },
        h('label', { for: operatorSelect.id, class: 'form-label' }, 'Operator'),
        operatorSelect,
        blockErrors.operator),
      h('fieldset', { class: 'form-group custom-view-values-group', 'aria-describedby': blockErrors.values.id },
        valuesLegend,
        valuesBox,
        blockErrors.values));
    const element = h('div', { class: 'custom-view-condition', role: 'group', 'aria-labelledby': title.id, 'data-condition': String(uid) },
      h('div', { class: 'custom-view-condition-header' }, toggleButton, deleteButton),
      summary,
      body);
    // The saved field, until it's known (a custom field, once the custom fields have loaded) or another is chosen.
    let pendingField = saved?.field ?? null;

    /** "Status · Not in · Pending, Verify": the field, the operator, and the values, alphabetically. */
    function updateSummary() {
      const fieldName = field?.name ?? pendingField?.name;
      if (!fieldName) {
        summary.textContent = 'No field chosen yet';
        return;
      }
      const values = [...chosen.values()].sort(byLabel).map((value) => value.label);
      summary.textContent = [fieldName, OPERATOR_LABELS[operator] ?? OPERATOR_LABELS[OPERATORS.IN], values.length ? values.join(', ') : 'No values chosen'].join(' · ');
    }

    /** Shows the condition's field, operator, and values, or only its summary line. */
    function setExpanded(expanded) {
      toggleButton.setAttribute('aria-expanded', String(expanded));
      element.classList.toggle('is-collapsed', !expanded);
      body.classList.toggle('hidden', !expanded);
      summary.classList.toggle('hidden', expanded);
    }

    /** Fills the field list: the standard fields, the user fields, the custom fields. */
    function renderFieldOptions() {
      const groups = new Map();
      for (const item of knownFields) {
        if (!groups.has(item.group)) groups.set(item.group, []);
        groups.get(item.group).push(item);
      }
      const unknownSaved = saved && !field && !knownFields.some((item) => item.id === saved.field.id);
      // fragment() flattens the groups and leaves out what isn't there (replaceChildren() would add them as text).
      fieldSelect.replaceChildren(fragment(
        h('option', { value: '' }, 'Choose a field…'),
        [...groups].map(([label, items]) => h('optgroup', { label },
          items.map((item) => h('option', { value: item.id }, item.name)))),
        // A saved field that isn't offered any more: shown, but can't be chosen again.
        unknownSaved && h('option', { value: saved.field.id, disabled: true }, `${saved.field.name} (no longer available)`)));
      fieldSelect.value = field?.id ?? '';
    }

    /** Fills the operators the chosen field allows, keeping the chosen one when it still applies. */
    function renderOperators() {
      const allowed = field ? operatorsFor(field.kind) : [];
      if (!allowed.includes(operator)) operator = allowed[0] ?? OPERATORS.IN;
      operatorSelect.replaceChildren(...allowed.map((op) => h('option', { value: op }, OPERATOR_LABELS[op])));
      operatorSelect.value = operator;
      operatorSelect.disabled = !field || allowed.length < 2;
    }

    /**
     * Draws the values, as checkboxes (In and Not in take one or more): the chosen ones first, then
     * the others, each in alphabetical order, so the chosen ones are always at hand. A custom field has
     * a search box, then its chosen values and Jira's others; the other fields their whole list, with
     * a filter when it's long. Neither the search nor the filter ever hides a chosen value, or changes
     * what's chosen. `message` says why there are none (loading, or Jira couldn't be asked).
     */
    function renderValues(message) {
      updateSummary();
      if (!field) {
        valuesBox.replaceChildren(h('p', { class: 'field-hint' }, 'Choose a field first.'));
        return;
      }
      const chosenCount = chosen.size;
      const item = (option, index) => {
        const key = valueKey(option);
        const inputId = `${valueName}-${index}`;
        const input = h('input', { type: 'checkbox', name: valueName, id: inputId, value: key });
        input.checked = chosen.has(key);
        // The first value not chosen, after the chosen ones, starts a group of its own.
        const startsOthers = chosenCount > 0 && index === chosenCount;
        return h('li', { 'data-label': option.label.toLowerCase(), class: startsOthers ? 'custom-view-value-others' : undefined },
          h('label', { class: 'custom-view-value', for: inputId }, input,
            h('span', {}, option.label),
            option.note && h('span', { class: 'custom-view-value-note' }, ` (${option.note})`)));
      };
      /**
       * The chosen values, then the others, each alphabetically, each once. A chosen value is drawn
       * as it's offered when it is (with its note, such as "not in Jira's list").
       */
      const ordered = (offered) => [
        ...[...chosen.values()].map((value) => offered.find((option) => valueKey(option) === valueKey(value)) ?? value).sort(byLabel),
        ...offered.filter((option) => !chosen.has(valueKey(option))).sort(byLabel)
      ];

      if (isSearchedField(field)) {
        // The chosen values stay listed, checked, whatever the search shows.
        shown = ordered(options);
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

      if (message) {
        shown = [];
        valuesBox.replaceChildren(h('p', { class: 'field-hint', role: 'status' }, message));
        return;
      }
      if (options.length === 0) {
        shown = [];
        valuesBox.replaceChildren(h('p', { class: 'field-hint', role: 'status' }, NO_VALUES));
        return;
      }
      // Every chosen value is among the options (showValues() adds the saved ones Jira doesn't list).
      shown = ordered(options);
      const filter = options.length > VALUE_FILTER_THRESHOLD && h('input', {
        type: 'search', id: id('customViewValueFilter'), class: 'custom-view-input custom-view-value-filter',
        placeholder: 'Filter values', 'aria-label': 'Filter values', autocomplete: 'off', spellcheck: 'false'
      });
      const noMatch = h('p', { class: 'field-hint hidden', role: 'status' }, NO_MATCHING_VALUES);
      const list = h('ul', { class: 'custom-view-value-list' }, shown.map(item));
      valuesBox.replaceChildren(fragment(filter, h('div', { class: 'custom-view-value-scroll' }, list), noMatch));

      /**
       * Shows only the values whose name has the filter's text, and every chosen one (which doesn't
       * count as a match: "No values match." says when no name does).
       */
      const applyFilter = () => {
        const wanted = valueFilter.trim().toLowerCase();
        let matched = 0;
        for (const li of list.querySelectorAll('li')) {
          const matches = !wanted || li.dataset.label.includes(wanted);
          li.classList.toggle('hidden', !matches && !li.querySelector('input').checked);
          if (matches) matched++;
        }
        noMatch.classList.toggle('hidden', matched > 0);
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
     * Priority, adding the condition's saved values Jira doesn't list any more (marked); Jira's
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
     * Changes the field. Another field starts afresh: its first operator (In), and no values.
     * `keepValues` keeps the condition's saved operator and values (its saved field, known only once
     * the custom fields have loaded).
     */
    function chooseField(fieldId, { keepValues = false } = {}) {
      const next = knownFields.find((item) => item.id === fieldId) ?? null;
      if (!keepValues) pendingField = null;
      if (next?.id !== field?.id) {
        valueFilter = '';
        searchInput.value = '';
        if (!keepValues) {
          chosen = new Map();
          operator = null;
        }
      }
      field = next;
      fieldSelect.value = field?.id ?? '';
      renderOperators();
      showValues();
    }

    fieldSelect.addEventListener('change', () => chooseField(fieldSelect.value));
    operatorSelect.addEventListener('change', () => {
      operator = operatorSelect.value;
      renderValues();
    });
    valuesBox.addEventListener('change', (event) => {
      const input = event.target.closest?.(`input[name="${valueName}"]`);
      const option = input && shown.find((value) => valueKey(value) === input.value);
      if (!option) return;
      if (input.checked) chosen.set(input.value, option);
      else chosen.delete(input.value);
      // At once: the chosen ones first. Focus stays on the value just changed, in its new place.
      renderValues();
      valuesBox.querySelectorAll(`input[name="${valueName}"]`).find((other) => other.value === input.value)?.focus();
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

    // A saved condition starts on its field, when it's offered (otherwise it's shown as no longer
    // available, until the custom fields have loaded).
    field = saved ? knownFields.find((item) => item.id === saved.field.id && item.kind === conditionKind(saved)) ?? null : null;
    renderFieldOptions();
    renderOperators();
    showValues();

    return {
      uid,
      element,
      fieldSelect,
      toggleButton,
      /** Numbers the card: "Condition 2", and its Delete button's label. */
      setNumber(number) {
        title.textContent = `Condition ${number}`;
        deleteButton.setAttribute('aria-label', `Delete condition ${number}`);
      },
      setExpanded,
      toggle() {
        setExpanded(body.classList.contains('hidden'));
      },
      /** The condition as the editor has it, for validate(). */
      draft() {
        return {
          field: field && { id: field.id, name: field.name, kind: field.kind },
          operator,
          values: [...chosen.values()].map((value) => (value.currentUser ? { currentUser: true, label: 'Me' } : { id: value.id, label: value.label }))
        };
      },
      showErrors(found = {}) {
        for (const [key, el] of Object.entries(blockErrors)) showError(el, found[key]);
        // A condition with something to fix shows it.
        if (Object.values(found).some(Boolean)) setExpanded(true);
        fieldSelect.classList.toggle('is-invalid', Boolean(found.field));
      },
      /** The control to fix first, for these errors. */
      firstInvalid(found) {
        return found.field ? fieldSelect : found.operator ? operatorSelect : valuesBox.querySelector('input') ?? fieldSelect;
      },
      /** The custom fields are in: offers them, and a saved custom field becomes the chosen one. */
      fieldsLoaded() {
        renderFieldOptions();
        const savedField = !field && saved && knownFields.find((item) => item.id === saved.field.id && item.kind === conditionKind(saved));
        if (savedField) chooseField(savedField.id, { keepValues: true });
      },
      dispose() {
        clearTimeout(searchTimer);
        valuesRequest++;
      }
    };
  }

  /** Numbers the conditions in order, after one is added or removed. */
  function renumber() {
    blocks.forEach((block, index) => block.setNumber(index + 1));
  }

  function addCondition(saved = null, { expanded = true } = {}) {
    const block = createConditionBlock(saved);
    block.setExpanded(expanded);
    blocks.push(block);
    conditionList.append(block.element);
    renumber();
    return block;
  }

  /** Deletes a condition, leaving the others as they are, and moves focus to the next one's header (or +). */
  function deleteCondition(uid) {
    const index = blocks.findIndex((block) => block.uid === uid);
    if (index < 0) return;
    const [block] = blocks.splice(index, 1);
    block.dispose();
    block.element.remove();
    renumber();
    const next = blocks[index] ?? blocks[index - 1];
    (next ? next.toggleButton : addConditionButton).focus();
  }

  function showErrors(found) {
    showError(errors.name, found.name);
    showError(errors.conditions, found.conditions);
    showError(errors.orderBy, found.orderBy);
    showError(errors.form, found.form);
    blocks.forEach((block, index) => block.showErrors(found.byCondition?.[index] ?? {}));
    nameInput.classList.toggle('is-invalid', Boolean(found.name));
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
    for (const block of blocks) block.dispose();
    hidePanel(root);
    onClose();
  }

  async function save() {
    if (busy) return;
    const draft = {
      name: nameInput.value,
      conditions: blocks.map((block) => block.draft()),
      orderBy: { field: orderBySelect.value, direction: directionInputs.find((input) => input.checked)?.value }
    };
    const { errors: found, view: valid } = validate(draft);
    showErrors(found);
    if (!valid) {
      const invalidIndex = found.byCondition?.findIndex(Boolean) ?? -1;
      (found.name ? nameInput
        : invalidIndex >= 0 ? blocks[invalidIndex].firstInvalid(found.byCondition[invalidIndex])
          : found.conditions ? addConditionButton
            : found.orderBy ? orderBySelect : nameInput).focus();
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
  contents.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    const action = target?.dataset.action;
    if (action === 'close-view-editor' || action === 'cancel-view') close();
    else if (action === 'add-condition') addCondition().fieldSelect.focus();
    else if (action === 'delete-condition') deleteCondition(Number(target.closest('[data-condition]')?.dataset.condition));
    else if (action === 'toggle-condition') blocks.find((block) => block.uid === Number(target.closest('[data-condition]')?.dataset.condition))?.toggle();
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
  // Every saved condition, in order; a new view starts with one empty condition.
  // A view with several conditions opens with them collapsed, to their summaries; one condition, or a
  // new view's empty one, open.
  const saved = view?.conditions?.length ? view.conditions : [null];
  for (const condition of saved) addCondition(condition, { expanded: saved.length === 1 });

  if (loadCustomFields) {
    fieldsStatus.textContent = LOADING_FIELDS;
    loadCustomFields().then((custom) => {
      if (!isOpen) return;
      for (const item of custom) if (!knownFields.some((known) => known.id === item.id)) knownFields.push({ group: 'Custom fields', ...item });
      fieldsStatus.textContent = '';
      for (const block of blocks) block.fieldsLoaded();
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
