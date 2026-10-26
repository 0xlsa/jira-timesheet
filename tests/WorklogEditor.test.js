process.env.TZ = 'Europe/London';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWorklogEditorSession, renderWorklogEditor } from '../src/ui/worklogEditor.js';
import { renderWorklogItem } from '../src/ui/weekView.js';
import { toNewWorklogForm } from '../src/worklog/worklogEdit.js';

// escapeHtml() relies on a DOM element's textContent -> innerHTML round trip; emulate it.
function installDocumentStub() {
  globalThis.document = {
    createElement() {
      let text = '';
      return {
        set textContent(value) { text = String(value); },
        get innerHTML() {
          return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
      };
    }
  };
}

const worklog = {
  id: '10042',
  issueId: '100',
  issueKey: 'EKB-30804',
  issueSummary: 'cleanup postgres container policy and retention',
  issueStatus: { name: 'In Progress', categoryKey: 'indeterminate' },
  started: '2026-10-22T09:39:00.000+0100',
  timeSpentSeconds: 7200,
  comment: {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Investigated the configuration' }] }]
  }
};

/** Session whose save/delete callbacks record calls and resolve or reject on demand. */
function setup({ saveError, deleteError } = {}) {
  const calls = { save: [], delete: 0 };
  const session = createWorklogEditorSession(worklog, {
    async onSave(changes) {
      calls.save.push(changes);
      if (saveError) throw saveError;
    },
    async onDelete() {
      calls.delete++;
      if (deleteError) throw deleteError;
    }
  });
  return { session, calls };
}

describe('WorklogEditor session - opening', () => {
  it('prepopulates every field from the worklog', () => {
    const { session } = setup();
    assert.deepEqual(session.state.form, {
      date: '2026-10-22',
      time: '09:39',
      hours: '2',
      minutes: '0',
      comment: 'Investigated the configuration'
    });
    assert.equal(session.isDirty, false);
    assert.equal(session.state.busy, null);
    assert.equal(session.state.confirm, null);
  });
});

describe('WorklogEditor session - editing and saving', () => {
  it('saves edited date, start time, duration, and comment', async () => {
    const { session, calls } = setup();
    session.setField('date', '2026-10-21');
    session.setField('time', '13:15');
    session.setField('hours', '1');
    session.setField('minutes', '45');
    session.setField('comment', 'Updated the retention policy');

    assert.deepEqual(await session.save(), { status: 'saved' });
    assert.equal(calls.save.length, 1);
    assert.equal(calls.save[0].started.getTime(), new Date(2026, 9, 21, 13, 15).getTime());
    assert.equal(calls.save[0].timeSpentSeconds, 6300);
    assert.equal(calls.save[0].comment, 'Updated the retention policy');
  });

  it('does not send the comment when only other fields changed', async () => {
    const { session, calls } = setup();
    session.setField('hours', '3');
    await session.save();
    assert.deepEqual(calls.save, [{ timeSpentSeconds: 10800 }]);
  });

  it('closes without a request when nothing changed', async () => {
    const { session, calls } = setup();
    assert.deepEqual(await session.save(), { status: 'unchanged' });
    assert.equal(calls.save.length, 0);
  });

  it('shows validation errors and does not call Jira', async () => {
    const { session, calls } = setup();
    session.setField('hours', '0');
    session.setField('minutes', '0');
    session.setField('time', '');

    assert.deepEqual(await session.save(), { status: 'invalid' });
    assert.match(session.state.errors.duration, /at least 1 minute/);
    assert.ok(session.state.errors.time);
    assert.equal(calls.save.length, 0);

    // Editing a field clears its error.
    session.setField('minutes', '30');
    assert.equal(session.state.errors.duration, undefined);
    assert.ok(session.state.errors.time);
  });

  it('keeps the changes and shows the error when saving fails', async () => {
    const error = new Error("You don't have permission to edit this worklog in Jira.");
    const { session } = setup({ saveError: error });
    session.setField('comment', 'Unsaved text');

    assert.deepEqual(await session.save(), { status: 'error' });
    assert.equal(session.state.submitError, error.message);
    assert.equal(session.state.form.comment, 'Unsaved text');
    assert.equal(session.isDirty, true);
    assert.equal(session.state.busy, null);
  });

  it('ignores a second save while one is in progress', async () => {
    let release;
    const calls = [];
    const session = createWorklogEditorSession(worklog, {
      onSave: (changes) => { calls.push(changes); return new Promise((resolve) => { release = resolve; }); },
      onDelete: async () => {}
    });
    session.setField('hours', '4');

    const first = session.save();
    assert.equal(session.state.busy, 'saving');
    assert.deepEqual(await session.save(), { status: 'busy' });
    session.setField('hours', '5');
    assert.equal(session.state.form.hours, '4', 'fields are locked while saving');
    assert.equal(session.requestClose(), false, 'cannot close while saving');

    release();
    assert.deepEqual(await first, { status: 'saved' });
    assert.equal(calls.length, 1);
  });
});

describe('WorklogEditor session - unsaved changes', () => {
  it('closes immediately when there are no changes', () => {
    const { session } = setup();
    assert.equal(session.requestClose(), true);
    assert.equal(session.state.confirm, null);
  });

  it('asks before discarding changes on close or cancel', () => {
    const { session } = setup();
    session.setField('comment', 'Draft');

    assert.equal(session.requestClose(), false);
    assert.equal(session.state.confirm, 'discard');

    session.keepEditing();
    assert.equal(session.state.confirm, null);
    assert.equal(session.state.form.comment, 'Draft');

    session.requestClose();
    assert.equal(session.discardChanges(), true);
  });

  it('only discards after the confirmation was shown', () => {
    const { session } = setup();
    session.setField('comment', 'Draft');
    assert.equal(session.discardChanges(), false);
  });

  it('treats reverting a field to its original value as no change', () => {
    const { session } = setup();
    session.setField('minutes', '15');
    session.setField('minutes', '0');
    assert.equal(session.isDirty, false);
    assert.equal(session.requestClose(), true);
  });
});

describe('WorklogEditor session - deleting', () => {
  it('requires explicit confirmation', async () => {
    const { session, calls } = setup();
    assert.deepEqual(await session.confirmDelete(), { status: 'ignored' });
    assert.equal(calls.delete, 0);

    session.requestDelete();
    assert.equal(session.state.confirm, 'delete');
    assert.deepEqual(await session.confirmDelete(), { status: 'deleted' });
    assert.equal(calls.delete, 1);
  });

  it('can be cancelled', async () => {
    const { session, calls } = setup();
    session.requestDelete();
    session.keepEditing();
    assert.deepEqual(await session.confirmDelete(), { status: 'ignored' });
    assert.equal(calls.delete, 0);
  });

  it('is never triggered by saving or closing', async () => {
    const { session, calls } = setup();
    session.requestDelete();
    session.setField('hours', '3');
    await session.save();
    assert.equal(session.state.confirm, null);
    session.requestClose();
    assert.equal(calls.delete, 0);
    assert.deepEqual(await session.confirmDelete(), { status: 'ignored' });
    assert.equal(calls.delete, 0);
  });

  it('shows the error and keeps the editor open when deletion fails', async () => {
    const { session } = setup({ deleteError: new Error('This worklog no longer exists in Jira.') });
    session.requestDelete();
    assert.deepEqual(await session.confirmDelete(), { status: 'error' });
    assert.equal(session.state.submitError, 'This worklog no longer exists in Jira.');
    assert.equal(session.state.confirm, null);
    assert.equal(session.state.busy, null);
  });
});

describe('WorklogEditor markup', () => {
  let previousDocument;
  before(() => {
    previousDocument = globalThis.document;
    installDocumentStub();
  });
  after(() => {
    globalThis.document = previousDocument;
  });

  it('prepopulates labeled inputs and shows the issue read-only', () => {
    const { session } = setup();
    const html = renderWorklogEditor(worklog, session.initialForm, 'https://acme.atlassian.net');

    assert.match(html, /<label for="worklogEditDate" class="form-label">Date<\/label>\s*<input type="date" id="worklogEditDate" name="date" value="2026-10-22"/);
    assert.match(html, /<label for="worklogEditTime" class="form-label">Start time<\/label>\s*<input type="time" id="worklogEditTime" name="time" value="09:39"/);
    assert.match(html, /<label for="worklogEditHours" class="sr-only">Hours<\/label>\s*<input type="number" id="worklogEditHours" name="hours" value="2"/);
    assert.match(html, /<label for="worklogEditMinutes" class="sr-only">Minutes<\/label>\s*<input type="number" id="worklogEditMinutes" name="minutes" value="0"/);
    assert.match(html, /<label for="worklogEditComment" class="form-label">Work description \(comment\)<\/label>\s*<textarea[^>]*>Investigated the configuration<\/textarea>/);

    // Issue key, title, and status are shown but not editable.
    assert.match(html, /href="https:\/\/acme.atlassian.net\/browse\/EKB-30804"[^>]*class="issue-key-badge"/);
    assert.match(html, /class="editor-issue-summary">cleanup postgres container policy and retention</);
    assert.match(html, /issue-status status-category-indeterminate/);
    const fieldNames = [...html.matchAll(/<(?:input|textarea|select)[^>]*name="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(fieldNames, ['date', 'time', 'hours', 'minutes', 'comment']);
  });

  it('has separate save, cancel, and delete actions, with delete behind a confirmation', () => {
    const { session } = setup();
    const html = renderWorklogEditor(worklog, session.initialForm, '');
    assert.match(html, /type="submit"[^>]*data-action="save"/);
    assert.match(html, /type="button"[^>]*data-action="cancel"/);
    assert.match(html, /type="button"[^>]*data-action="delete"/);
    assert.match(html, /data-confirm="delete"[\s\S]*data-action="confirm-delete"/);
    assert.match(html, /data-confirm="discard"[\s\S]*data-action="discard"/);
  });

  it('warns that editing a formatted Jira Cloud comment saves plain text', () => {
    const rich = { ...worklog, comment: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'strong' }] }] }] } };
    assert.match(renderWorklogEditor(rich, createWorklogEditorSession(rich, {}).initialForm, ''), /saved as plain text/);
    assert.doesNotMatch(renderWorklogEditor(worklog, setup().session.initialForm, ''), /saved as plain text/);
  });

  it('escapes worklog text', () => {
    const hostile = { ...worklog, issueSummary: '<img src=x>', comment: '</textarea><b>' };
    const html = renderWorklogEditor(hostile, createWorklogEditorSession(hostile, {}).initialForm, '');
    assert.doesNotMatch(html, /<img src=x>|<\/textarea><b>/);
  });

  it('adds an edit button for the worklog only when editing is available', () => {
    const item = { ...worklog, formattedStartTime: '09:39', formattedDuration: '2h', comment: '', author: { displayName: 'Dev' } };
    const editable = renderWorklogItem(item, '', { editable: true });
    assert.match(editable, /<button type="button" class="worklog-edit-btn" data-worklog-id="10042" aria-label="Edit worklog for EKB-30804, started 09:39"/);
    assert.doesNotMatch(renderWorklogItem(item, ''), /worklog-edit-btn/);
  });

  it('orders the right-hand controls as duration, log work, edit, with labels and tooltips', () => {
    const item = { ...worklog, formattedStartTime: '09:39', formattedDuration: '2h', comment: '', author: { displayName: 'Dev' } };
    const html = renderWorklogItem(item, '', { editable: true, canLogWork: true });
    const side = html.slice(html.indexOf('class="worklog-side"'));

    const order = ['worklog-duration-badge', 'worklog-log-btn', 'worklog-edit-btn'].map((cls) => side.indexOf(`class="${cls}"`));
    assert.ok(order.every((i) => i > 0), 'all three controls render');
    assert.deepEqual([...order].sort((a, b) => a - b), order);

    assert.match(side, /class="worklog-log-btn" data-worklog-id="10042" aria-label="Log work on EKB-30804" title="Log work"/);
    assert.match(side, /class="worklog-edit-btn"[^>]*title="Edit worklog"/);
    assert.doesNotMatch(renderWorklogItem(item, '', { editable: true }), /worklog-log-btn/);
  });
});

const issue = {
  issueId: '100',
  issueKey: 'EKB-30835',
  issueSummary: 'Performance regression investigation',
  issueStatus: { name: 'Selected for Development', categoryKey: 'new' }
};

function setupCreate({ saveError } = {}) {
  const calls = [];
  const session = createWorklogEditorSession(issue, {
    mode: 'create',
    initialForm: toNewWorklogForm({ dateKey: '2026-10-21', now: new Date(2026, 9, 26, 14, 7) }),
    async onSave(values) {
      calls.push(values);
      if (saveError) throw saveError;
    }
  });
  return { session, calls };
}

describe('WorklogEditor session - logging new work', () => {
  it('starts on the selected day at the current time with no duration', () => {
    const { session } = setupCreate();
    assert.equal(session.mode, 'create');
    assert.deepEqual(session.state.form, { date: '2026-10-21', time: '14:07', hours: '', minutes: '', comment: '' });
    assert.equal(session.isDirty, false);
  });

  it('requires a duration before logging', async () => {
    const { session, calls } = setupCreate();
    assert.deepEqual(await session.save(), { status: 'invalid' });
    assert.match(session.state.errors.duration, /Enter a duration/);
    assert.equal(calls.length, 0);
  });

  it('logs the new worklog with the entered values', async () => {
    const { session, calls } = setupCreate();
    session.setField('minutes', '30');
    session.setField('comment', 'Profiling');

    assert.deepEqual(await session.save(), { status: 'saved' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].started.getTime(), new Date(2026, 9, 21, 14, 7).getTime());
    assert.equal(calls[0].timeSpentSeconds, 1800);
    assert.equal(calls[0].comment, 'Profiling');
  });

  it('keeps the input and shows the error when Jira rejects it', async () => {
    const { session } = setupCreate({ saveError: new Error("You don't have permission to log work on this issue in Jira.") });
    session.setField('hours', '1');
    session.setField('comment', 'Keep me');

    assert.deepEqual(await session.save(), { status: 'error' });
    assert.match(session.state.submitError, /permission to log work/);
    assert.equal(session.state.form.hours, '1');
    assert.equal(session.state.form.comment, 'Keep me');
    assert.equal(session.state.busy, null);
  });

  it('ignores a second submit while logging is in progress', async () => {
    let release;
    const calls = [];
    const session = createWorklogEditorSession(issue, {
      mode: 'create',
      initialForm: toNewWorklogForm({ dateKey: '2026-10-21', now: new Date(2026, 9, 26, 9, 0) }),
      onSave: (values) => { calls.push(values); return new Promise((resolve) => { release = resolve; }); }
    });
    session.setField('hours', '1');

    const first = session.save();
    assert.deepEqual(await session.save(), { status: 'busy' });
    release();
    assert.deepEqual(await first, { status: 'saved' });
    assert.equal(calls.length, 1);
  });

  it('asks before discarding entered work and has no delete', () => {
    const { session } = setupCreate();
    session.setField('minutes', '15');
    assert.equal(session.requestClose(), false);
    assert.equal(session.state.confirm, 'discard');
    session.keepEditing();
    session.requestDelete();
    assert.equal(session.state.confirm, null);
  });
});

describe('WorklogEditor markup - logging new work', () => {
  let previousDocument;
  before(() => {
    previousDocument = globalThis.document;
    installDocumentStub();
  });
  after(() => {
    globalThis.document = previousDocument;
  });

  it('shows the issue read-only, quick durations, and no delete action', () => {
    const { session } = setupCreate();
    const html = renderWorklogEditor(issue, session.initialForm, 'https://acme.atlassian.net', { mode: 'create' });

    assert.match(html, /id="worklogEditorTitle">Log work</);
    assert.match(html, /class="issue-key-badge"[^>]*>EKB-30835</);
    assert.match(html, /class="editor-issue-summary">Performance regression investigation</);
    assert.match(html, /issue-status status-category-new/);
    assert.match(html, /name="date" value="2026-10-21"/);
    assert.match(html, /name="time" value="14:07"/);
    assert.match(html, /data-save-label>Log work</);
    assert.doesNotMatch(html, /data-action="delete"|data-confirm="delete"/);

    const presets = [...html.matchAll(/<button type="button" class="duration-preset"([^>]*)>([^<]+)</g)];
    assert.deepEqual(presets.map((m) => m[2]), ['15m', '30m', '1h', 'Custom']);
    assert.match(presets[0][1], /data-preset-hours="0" data-preset-minutes="15"/);
    assert.match(presets[2][1], /data-preset-hours="1" data-preset-minutes="0"/);

    const fieldNames = [...html.matchAll(/<(?:input|textarea|select)[^>]*name="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(fieldNames, ['date', 'time', 'hours', 'minutes', 'comment']);
  });

  it('keeps quick durations out of the edit panel', () => {
    assert.doesNotMatch(renderWorklogEditor(worklog, setup().session.initialForm, ''), /duration-preset/);
  });
});
