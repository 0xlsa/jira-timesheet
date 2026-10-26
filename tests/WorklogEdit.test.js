// Pin a time zone with daylight saving: the UK is UTC+0 in winter and UTC+1 in summer,
// and clocks skip from 01:00 to 02:00 on Sunday 29 March 2026.
process.env.TZ = 'Europe/London';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEditableWorklog,
  commentToEditableText,
  isRichComment,
  plainTextToAdf,
  formatJiraDateTime,
  toEditForm,
  validateEditForm,
  isEditFormDirty,
  buildWorklogChanges
} from '../src/worklog/worklogEdit.js';

const adf = (...paragraphs) => ({
  type: 'doc',
  version: 1,
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
});

const validForm = { date: '2026-10-22', time: '09:39', hours: '2', minutes: '0', comment: 'Work' };

describe('worklogEdit - prepopulating the form', () => {
  it('uses the local date and time of a Jira start with an offset', () => {
    // 08:39 UTC is 09:39 in London (BST, UTC+1) on 22 October 2026.
    const form = toEditForm({ started: '2026-10-22T10:39:00.000+0200', timeSpentSeconds: 7200, comment: 'Done' });
    assert.deepEqual(form, { date: '2026-10-22', time: '09:39', hours: '2', minutes: '0', comment: 'Done' });
  });

  it('crosses midnight into the local date', () => {
    const form = toEditForm({ started: '2026-10-22T23:30:00.000-0500', timeSpentSeconds: 60 });
    assert.equal(form.date, '2026-10-23');
    assert.equal(form.time, '05:30');
  });

  it('splits the duration into whole hours and minutes', () => {
    const form = toEditForm({ started: '2026-10-22T09:00:00.000+0100', timeSpentSeconds: 9000 });
    assert.equal(form.hours, '2');
    assert.equal(form.minutes, '30');
    const withSeconds = toEditForm({ started: '2026-10-22T09:00:00.000+0100', timeSpentSeconds: 3630 });
    assert.equal(withSeconds.hours, '1');
    assert.equal(withSeconds.minutes, '0');
  });

  it('keeps line breaks from Jira Cloud (ADF) and Data Center / Server comments', () => {
    assert.equal(toEditForm({ started: '2026-10-22T09:00:00.000+0100', timeSpentSeconds: 60, comment: adf('First', 'Second') }).comment, 'First\nSecond');
    assert.equal(toEditForm({ started: '2026-10-22T09:00:00.000+0100', timeSpentSeconds: 60, comment: 'Line 1\r\nLine 2' }).comment, 'Line 1\nLine 2');
    assert.equal(toEditForm({ started: '2026-10-22T09:00:00.000+0100', timeSpentSeconds: 60 }).comment, '');
  });
});

describe('worklogEdit - comments', () => {
  it('reads hard breaks, lists, and mentions from ADF', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] },
        { type: 'bulletList', content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }] }
        ] },
        { type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@Dev' } }] }
      ]
    };
    assert.equal(commentToEditableText(doc), 'a\nb\nitem\n@Dev');
  });

  it('round-trips plain text through ADF', () => {
    const text = 'Investigated\n\nUpdated the retention policy';
    assert.equal(commentToEditableText(plainTextToAdf(text)), text);
    assert.deepEqual(plainTextToAdf('  '), { type: 'doc', version: 1, content: [] });
  });

  it('detects formatting that plain text would lose', () => {
    assert.equal(isRichComment(adf('plain')), false);
    assert.equal(isRichComment('plain string'), false);
    assert.equal(isRichComment({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b', marks: [{ type: 'strong' }] }] }] }), true);
    assert.equal(isRichComment({ type: 'doc', content: [{ type: 'bulletList', content: [] }] }), true);
  });
});

describe('worklogEdit - Jira date/time format', () => {
  it('writes the local time with the offset in effect on that date', () => {
    assert.equal(formatJiraDateTime(new Date(2026, 9, 22, 9, 39)), '2026-10-22T09:39:00.000+0100');
    assert.equal(formatJiraDateTime(new Date(2026, 11, 1, 9, 5)), '2026-12-01T09:05:00.000+0000');
  });

  it('represents the same instant the user picked', () => {
    const picked = new Date(2026, 9, 22, 9, 39);
    const jira = formatJiraDateTime(picked).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    assert.equal(new Date(jira).getTime(), picked.getTime());
  });

  it('rejects invalid dates', () => {
    assert.throws(() => formatJiraDateTime(new Date('nope')));
  });
});

describe('worklogEdit - validation', () => {
  it('accepts a valid form', () => {
    assert.deepEqual(validateEditForm(validForm), { isValid: true, errors: {} });
  });

  it('requires a valid date and time', () => {
    assert.ok(validateEditForm({ ...validForm, date: '' }).errors.date);
    assert.ok(validateEditForm({ ...validForm, date: '2026-02-30' }).errors.date);
    assert.ok(validateEditForm({ ...validForm, time: '' }).errors.time);
    assert.ok(validateEditForm({ ...validForm, time: '24:00' }).errors.time);
  });

  it('rejects a start time skipped by a daylight-saving change', () => {
    const { errors } = validateEditForm({ ...validForm, date: '2026-03-29', time: '01:30' });
    assert.match(errors.time, /daylight-saving/);
  });

  it('rejects zero, negative, fractional, and out-of-range durations', () => {
    const durationError = (hours, minutes) => validateEditForm({ ...validForm, hours, minutes }).errors.duration;
    assert.match(durationError('0', '0'), /at least 1 minute/);
    assert.ok(durationError('-1', '0'));
    assert.ok(durationError('1.5', '0'));
    assert.ok(durationError('', '30'));
    assert.match(durationError('1', '60'), /0 and 59/);
    assert.ok(durationError('1000', '0'));
    assert.equal(durationError('0', '1'), undefined);
  });
});

describe('worklogEdit - changed fields', () => {
  it('sends nothing when nothing changed', () => {
    assert.deepEqual(buildWorklogChanges(validForm, { ...validForm }), {});
    assert.equal(isEditFormDirty(validForm, { ...validForm }), false);
  });

  it('sends a new local start when the date or time changes', () => {
    const changes = buildWorklogChanges(validForm, { ...validForm, date: '2026-10-21', time: '13:05' });
    assert.deepEqual(Object.keys(changes), ['started']);
    assert.equal(changes.started.getTime(), new Date(2026, 9, 21, 13, 5).getTime());
  });

  it('converts the duration to whole seconds without rounding errors', () => {
    assert.deepEqual(buildWorklogChanges(validForm, { ...validForm, hours: '1', minutes: '7' }), { timeSpentSeconds: 4020 });
    assert.deepEqual(buildWorklogChanges(validForm, { ...validForm, hours: '0', minutes: '59' }), { timeSpentSeconds: 3540 });
  });

  it('treats an equal duration typed differently as unchanged', () => {
    assert.deepEqual(buildWorklogChanges(validForm, { ...validForm, hours: '02', minutes: '00' }), {});
  });

  it('keeps the comment out of the update unless it was edited', () => {
    assert.equal('comment' in buildWorklogChanges(validForm, { ...validForm, hours: '3' }), false);
    assert.deepEqual(buildWorklogChanges(validForm, { ...validForm, comment: '' }), { comment: '' });
  });
});

describe('worklogEdit - editable worklogs', () => {
  it('needs a Jira worklog ID and an issue', () => {
    assert.equal(isEditableWorklog({ id: '10042', issueId: '1' }), true);
    assert.equal(isEditableWorklog({ id: '10042', issueKey: 'A-1' }), true);
    assert.equal(isEditableWorklog({ id: 'wl-0.123', issueId: '1' }), false);
    assert.equal(isEditableWorklog({ id: '10042' }), false);
    assert.equal(isEditableWorklog(null), false);
  });
});
