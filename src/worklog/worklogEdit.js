/**
 * Worklog editing logic: converts between Jira worklogs and the edit form,
 * validates form values, and works out which fields changed.
 * No DOM and no network access; the UI and JiraClient build on these.
 */

import { getLocalDateKey } from './worklogUtils.js';

// Largest duration the form accepts. Jira has no hard cap; this only catches typos.
export const MAX_DURATION_HOURS = 999;

// ADF nodes whose children are blocks, so their text is separated by line breaks.
const ADF_BLOCK_CONTAINERS = new Set([
  'doc', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'panel', 'expand',
  'nestedExpand', 'table', 'tableRow', 'tableHeader', 'tableCell', 'layoutSection', 'layoutColumn'
]);

// ADF nodes that plain text represents without losing anything.
const ADF_PLAIN_NODES = new Set(['doc', 'paragraph', 'text', 'hardBreak']);

/**
 * Returns true when a worklog can be edited: it has a real Jira worklog ID and a parent issue.
 * @param {object} worklog
 * @returns {boolean}
 */
export function isEditableWorklog(worklog) {
  return Boolean(worklog) && /^\d+$/.test(String(worklog.id ?? '')) && Boolean(worklog.issueId || worklog.issueKey);
}

/**
 * Converts a worklog comment (plain string on Data Center / Server, Atlassian Document
 * Format on Jira Cloud) to text for a textarea, keeping paragraph and line breaks.
 *
 * @param {string | object | null | undefined} comment
 * @returns {string}
 */
export function commentToEditableText(comment) {
  if (!comment) return '';
  if (typeof comment === 'string') return comment.replace(/\r\n?/g, '\n');
  if (typeof comment !== 'object') return '';

  function toText(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'mention' || node.type === 'emoji') return node.attrs?.text || node.attrs?.shortName || '';
    if (node.type === 'inlineCard') return node.attrs?.url || '';

    const children = Array.isArray(node.content) ? node.content.map(toText) : [];
    return children.join(ADF_BLOCK_CONTAINERS.has(node.type) ? '\n' : '');
  }

  return toText(comment);
}

/**
 * Returns true when an ADF comment uses formatting that plain text can't keep
 * (marks such as bold or links, lists, mentions, and so on).
 *
 * @param {string | object | null | undefined} comment
 * @returns {boolean}
 */
export function isRichComment(comment) {
  if (!comment || typeof comment !== 'object') return false;

  const visit = (node) => {
    if (!node || typeof node !== 'object') return false;
    if (!ADF_PLAIN_NODES.has(node.type)) return true;
    if (Array.isArray(node.marks) && node.marks.length > 0) return true;
    return Array.isArray(node.content) && node.content.some(visit);
  };

  return visit(comment);
}

/**
 * Converts textarea text to an Atlassian Document Format document for Jira Cloud.
 * Each line becomes a paragraph, which is how Jira's own editor stores Enter.
 *
 * @param {string} text
 * @returns {{ type: 'doc', version: 1, content: Array<object> }}
 */
export function plainTextToAdf(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!normalized.trim()) {
    return { type: 'doc', version: 1, content: [] };
  }

  return {
    type: 'doc',
    version: 1,
    content: normalized.split('\n').map((line) => (
      line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }
    ))
  };
}

/**
 * Formats a Date in Jira's worklog `started` format, `yyyy-MM-dd'T'HH:mm:ss.SSSZ`,
 * using the local wall-clock time and the local UTC offset in effect on that date.
 * The offset makes the instant unambiguous, so Jira stores exactly this moment.
 *
 * @param {Date} date
 * @returns {string} e.g. "2026-10-22T09:39:00.000+0100"
 */
export function formatJiraDateTime(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    throw new Error('A valid date is required.');
  }

  const pad = (n, width = 2) => String(n).padStart(width, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);

  return `${getLocalDateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absOffset / 60))}${pad(absOffset % 60)}`;
}

/**
 * Builds the edit form values for a worklog, in the browser's local time zone
 * (the same zone the weekly view groups worklogs by).
 *
 * @param {{ started: string | Date, timeSpentSeconds: number, comment?: string | object }} worklog
 * @returns {{ date: string, time: string, hours: string, minutes: string, comment: string }}
 */
export function toEditForm(worklog) {
  const started = new Date(worklog.started);
  const totalMinutes = Math.floor(Math.max(0, Number(worklog.timeSpentSeconds) || 0) / 60);
  const pad = (n) => String(n).padStart(2, '0');

  return {
    date: getLocalDateKey(started),
    time: isNaN(started.getTime()) ? '' : `${pad(started.getHours())}:${pad(started.getMinutes())}`,
    hours: String(Math.floor(totalMinutes / 60)),
    minutes: String(totalMinutes % 60),
    comment: commentToEditableText(worklog.comment)
  };
}

/**
 * Parses a whole number from a form field, or returns null when it isn't one.
 * @param {string} value
 * @returns {number | null}
 */
function parseWholeNumber(value) {
  const trimmed = String(value ?? '').trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

/**
 * Builds the local Date for the form's date and time, or null when they don't name a real local time.
 * @param {string} date - YYYY-MM-DD
 * @param {string} time - HH:MM
 * @returns {Date | null}
 */
function toLocalDateTime(date, time) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(String(time ?? ''));
  if (!dateMatch || !timeMatch) return null;

  const [year, month, day] = dateMatch.slice(1).map(Number);
  const [hours, minutes] = timeMatch.slice(1).map(Number);
  const result = new Date(year, month - 1, day, hours, minutes, 0, 0);

  // Rejects impossible dates (Feb 30) and times skipped by a daylight-saving change.
  if (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== day ||
      result.getHours() !== hours || result.getMinutes() !== minutes) {
    return null;
  }
  return result;
}

/**
 * Validates edit form values.
 *
 * @param {{ date: string, time: string, hours: string, minutes: string }} form
 * @returns {{ isValid: boolean, errors: { date?: string, time?: string, duration?: string } }}
 */
export function validateEditForm(form) {
  const errors = {};

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(form.date ?? ''))) {
    errors.date = 'Enter a date.';
  } else if (!toLocalDateTime(form.date, '12:00')) {
    errors.date = 'Enter a valid date.';
  }

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(form.time ?? ''))) {
    errors.time = 'Enter a start time.';
  } else if (!errors.date && !toLocalDateTime(form.date, form.time)) {
    errors.time = "This time doesn't exist on that date because of a daylight-saving change.";
  }

  const hours = parseWholeNumber(form.hours);
  const minutes = parseWholeNumber(form.minutes);
  if (hours === null || minutes === null) {
    errors.duration = 'Enter whole numbers for hours and minutes.';
  } else if (minutes > 59) {
    errors.duration = 'Minutes must be between 0 and 59.';
  } else if (hours > MAX_DURATION_HOURS) {
    errors.duration = `Hours must be ${MAX_DURATION_HOURS} or less.`;
  } else if (hours === 0 && minutes === 0) {
    errors.duration = 'Duration must be at least 1 minute.';
  }

  return { isValid: Object.keys(errors).length === 0, errors };
}

/**
 * Returns true when any form field differs from its initial value.
 *
 * @param {object} initialForm
 * @param {object} form
 * @returns {boolean}
 */
export function isEditFormDirty(initialForm, form) {
  return ['date', 'time', 'hours', 'minutes', 'comment'].some(
    (field) => String(form[field] ?? '') !== String(initialForm[field] ?? '')
  );
}

/**
 * Works out the worklog fields to send to Jira: only those the user changed, so
 * unchanged values (including rich-text comments) are left exactly as Jira has them.
 * Call validateEditForm() first; this assumes valid values.
 *
 * @param {object} initialForm - From toEditForm()
 * @param {object} form - Current form values
 * @returns {{ started?: Date, timeSpentSeconds?: number, comment?: string }}
 */
export function buildWorklogChanges(initialForm, form) {
  const changes = {};

  if (form.date !== initialForm.date || form.time !== initialForm.time) {
    changes.started = toLocalDateTime(form.date, form.time);
  }

  const initialMinutes = parseWholeNumber(initialForm.hours) * 60 + parseWholeNumber(initialForm.minutes);
  const minutes = parseWholeNumber(form.hours) * 60 + parseWholeNumber(form.minutes);
  if (minutes !== initialMinutes) {
    // Integer arithmetic only: whole minutes to whole seconds.
    changes.timeSpentSeconds = minutes * 60;
  }

  if (String(form.comment ?? '') !== String(initialForm.comment ?? '')) {
    changes.comment = String(form.comment ?? '');
  }

  return changes;
}
