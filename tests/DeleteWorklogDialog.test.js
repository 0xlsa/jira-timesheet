import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// The dialog's date formatters are created when its module loads, so the time zone must be
// set before importing it (static imports would run first).
process.env.TZ = 'Europe/Rome';
const {
  describeWorklogForDeletion,
  createDeleteWorklogSession,
  renderDeleteWorklogDialog
} = await import('../src/ui/deleteWorklogDialog.js');

// Start times use the locale's default time format, like the worklog cards.
const localTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
  id: '10012',
  issueId: '10018',
  issueKey: 'KAN-9',
  issueSummary: 'Implement worklog editing',
  started: '2026-10-21T14:00:00.000+0200',
  timeSpentSeconds: 7200
};

describe('Delete worklog dialog - details', () => {
  it('shows the issue, local date, start time, and duration', () => {
    const details = describeWorklogForDeletion(worklog);
    assert.equal(details.issueKey, 'KAN-9');
    assert.equal(details.issueSummary, 'Implement worklog editing');
    assert.equal(details.date, 'Wednesday, 21 October 2026');
    assert.equal(details.startTime, localTime('2026-10-21T12:00:00.000Z'));
    assert.equal(details.duration, '2h 00m');
  });

  it('uses the local date for a start near midnight', () => {
    // 23:30 UTC on the 20th is 01:30 on the 21st in Rome.
    assert.equal(describeWorklogForDeletion({ ...worklog, started: '2026-10-20T23:30:00.000+0000' }).date, 'Wednesday, 21 October 2026');
  });

  it('formats short durations with hours and two-digit minutes', () => {
    assert.equal(describeWorklogForDeletion({ ...worklog, timeSpentSeconds: 2700 }).duration, '0h 45m');
  });
});

describe('Delete worklog dialog - session', () => {
  it('deletes once and reports success', async () => {
    let calls = 0;
    const session = createDeleteWorklogSession(async () => { calls++; });
    assert.deepEqual(await session.confirm(), { status: 'deleted' });
    assert.equal(calls, 1);
    assert.equal(session.state.busy, false);
  });

  it('keeps the error and allows a retry when Jira rejects the deletion', async () => {
    let fail = true;
    const session = createDeleteWorklogSession(async () => {
      if (fail) throw new Error("You don't have permission to delete this worklog in Jira.");
    });

    assert.deepEqual(await session.confirm(), { status: 'error' });
    assert.match(session.state.error, /permission to delete this worklog/);
    assert.equal(session.state.busy, false);
    assert.equal(session.canClose(), true);

    fail = false;
    assert.deepEqual(await session.confirm(), { status: 'deleted' });
    assert.equal(session.state.error, '');
  });

  it('ignores a second confirmation while the request is in progress and blocks closing', async () => {
    let release;
    let calls = 0;
    const session = createDeleteWorklogSession(() => { calls++; return new Promise((resolve) => { release = resolve; }); });

    const first = session.confirm();
    assert.equal(session.state.busy, true);
    assert.equal(session.canClose(), false);
    assert.deepEqual(await session.confirm(), { status: 'busy' });

    release();
    assert.deepEqual(await first, { status: 'deleted' });
    assert.equal(calls, 1);
  });

  it('falls back to a generic message for errors without one', async () => {
    const session = createDeleteWorklogSession(async () => { throw new Error(''); });
    await session.confirm();
    assert.equal(session.state.error, 'The worklog could not be deleted.');
  });
});

describe('Delete worklog dialog - markup', () => {
  let previousDocument;
  before(() => {
    previousDocument = globalThis.document;
    installDocumentStub();
  });
  after(() => {
    globalThis.document = previousDocument;
  });

  it('names the worklog, says it cannot be undone, and offers Cancel and Delete', () => {
    const html = renderDeleteWorklogDialog(describeWorklogForDeletion(worklog));
    assert.match(html, /id="deleteWorklogTitle">Delete worklog\?</);
    assert.match(html, /can't be undone/);
    assert.match(html, /<dd>KAN-9 · Implement worklog editing<\/dd>/);
    assert.ok(html.includes(`<dd>Wednesday, 21 October 2026, started ${localTime('2026-10-21T12:00:00.000Z')}</dd>`));
    assert.match(html, /<dd>2h 00m<\/dd>/);
    assert.match(html, /type="button"[^>]*data-action="cancel">Cancel</);
    assert.match(html, /type="button" class="btn btn-danger btn-sm" data-action="delete"/);
    // Cancel comes before Delete.
    assert.ok(html.indexOf('data-action="cancel"') < html.indexOf('data-action="delete"'));
  });

  it('escapes worklog text', () => {
    const html = renderDeleteWorklogDialog(describeWorklogForDeletion({ ...worklog, issueSummary: '<img src=x>' }));
    assert.doesNotMatch(html, /<img src=x>/);
    assert.match(html, /&lt;img src=x&gt;/);
  });
});
