process.env.TZ = 'Europe/London';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDocument, toHtml } from './support/fakeDom.js';
import { h, svg, fragment } from '../src/ui/dom.js';
import { renderWeek, renderWorklogItem } from '../src/ui/weekView.js';
import { renderWorklogEditor, createWorklogEditorSession } from '../src/ui/worklogEditor.js';
import { renderDeleteWorklogDialog, describeWorklogForDeletion } from '../src/ui/deleteWorklogDialog.js';
import { renderConnectionStatus } from '../src/ui/connectionStatus.js';

// Text from Jira (summaries, statuses, comments, names, error messages) that would run
// script if it were ever parsed as HTML.
const HOSTILE = '<img src=x onerror=alert(1)>';

/** True when `node` or anything below it is an element that only markup could have created. */
function hasInjectedElements(node) {
  const nodes = [node, ...(node.descendants ?? [])];
  return nodes.some((el) => ['img', 'b', 'script', 'iframe'].includes(el.localName) ||
    [...(el.attributes?.keys() ?? [])].some((name) => /^on/i.test(name)));
}

/** Text of a node list, as the user sees it. */
const textOf = (nodes) => [].concat(nodes).map((node) => node.textContent).join('');

const hostileWorklog = {
  id: '10042',
  issueId: '100',
  issueKey: 'KAN-9',
  issueSummary: HOSTILE,
  issueStatus: { name: HOSTILE, categoryKey: 'new' },
  comment: HOSTILE,
  author: { displayName: HOSTILE },
  started: '2026-10-21T12:00:00.000Z',
  timeSpentSeconds: 3600,
  formattedStartTime: '13:00',
  formattedDuration: '1h'
};

describe('Safe rendering - Jira text is shown as text, never parsed as HTML', () => {
  let restoreDocument;
  before(() => {
    restoreDocument = installFakeDocument();
  });
  after(() => restoreDocument());

  it('dom helpers add strings as text and refuse event handler attributes', () => {
    const el = h('p', { title: HOSTILE }, HOSTILE, 42, null, false, '', [' and ', svg('svg', {})]);
    assert.equal(el.textContent, `${HOSTILE}42 and `);
    assert.equal(el.getAttribute('title'), HOSTILE);
    assert.equal(hasInjectedElements(el), false);
    assert.match(toHtml(el), /^<p title="&lt;img src=x onerror=alert\(1\)&gt;">&lt;img src=x onerror=alert\(1\)&gt;42 and <svg><\/svg><\/p>$/);

    assert.throws(() => h('button', { onclick: 'alert(1)' }), /not allowed/);
    assert.throws(() => svg('svg', { OnLoad: 'alert(1)' }), /not allowed/);
    assert.equal(toHtml(fragment('a', h('b', {}), 'c')), 'a<b></b>c');
  });

  it('worklog cards show the issue summary, status, comment, and author as text', () => {
    const item = renderWorklogItem(hostileWorklog, 'https://jira.example.com', { editable: true, canLogWork: true, deletable: true });
    const wrapper = h('div', {}, item);

    assert.equal(hasInjectedElements(wrapper), false);
    assert.equal(wrapper.querySelector('.issue-summary').textContent, HOSTILE);
    assert.equal(wrapper.querySelector('.issue-summary').getAttribute('title'), HOSTILE);
    assert.equal(wrapper.querySelector('.issue-status-name').textContent, HOSTILE);
    assert.equal(wrapper.querySelector('.worklog-comment').textContent, HOSTILE);
    assert.equal(wrapper.querySelector('.worklog-author').textContent, HOSTILE);
    assert.equal(wrapper.querySelector('.issue-key-badge').getAttribute('href'), 'https://jira.example.com/browse/KAN-9');
  });

  it('the weekly view renders hostile worklogs as text and keeps its buttons working', () => {
    const selected = [];
    const edited = [];
    const container = h('div', {});
    const day = (dateKey, dayOfMonth, worklogs) => ({
      dateKey,
      date: new Date(`${dateKey}T12:00:00`),
      dayName: 'Wednesday',
      shortDayName: 'Wed',
      formattedDate: `${dayOfMonth} Oct`,
      dayOfMonth,
      formattedTotal: worklogs.length ? '1h 00m' : '0h 00m',
      totalDurationSeconds: worklogs.length ? 3600 : 0,
      worklogCount: worklogs.length,
      isToday: false,
      worklogs
    });

    renderWeek(container, { weekDays: [day('2026-10-21', 21, [hostileWorklog]), day('2026-10-22', 22, [])] }, {
      selectedDateKey: '2026-10-21',
      baseUrl: 'https://jira.example.com',
      onSelectDay: (dateKey) => selected.push(dateKey),
      onEditWorklog: (id) => edited.push(id),
      onLogWork: () => {},
      onDeleteWorklog: () => {}
    });

    assert.equal(hasInjectedElements(container), false);
    assert.equal(container.querySelectorAll('.day-card').length, 2);
    assert.equal(container.querySelector('.day-panel-meta').textContent, '1 worklog • 1h 00m total');
    assert.equal(container.querySelector('.day-indicator-fill').getAttribute('style'), 'width: 12.5%');
    assert.equal(container.querySelector('.worklog-comment').textContent, HOSTILE);

    container.querySelector('.day-card[data-date-key="2026-10-22"]').click();
    container.querySelector('.worklog-edit-btn').click();
    assert.deepEqual(selected, ['2026-10-22']);
    assert.deepEqual(edited, ['10042']);

    // Re-rendering replaces the previous contents instead of adding to them.
    renderWeek(container, { weekDays: [day('2026-10-22', 22, [])] }, { selectedDateKey: '2026-10-22', onSelectDay: () => {} });
    assert.equal(container.querySelectorAll('.day-card').length, 1);
    assert.equal(container.querySelector('.empty-day-placeholder').textContent, 'No worklogs logged for this day.');
  });

  it('the edit and log work panel shows the issue as text and the comment as the textarea value', () => {
    const editing = { ...hostileWorklog, comment: `${HOSTILE}</textarea><b>` };
    const form = renderWorklogEditor(editing, createWorklogEditorSession(editing, {}).initialForm, '');

    assert.equal(hasInjectedElements(form), false);
    assert.equal(form.querySelector('.editor-issue-summary').textContent, HOSTILE);
    assert.equal(form.querySelector('.issue-status-name').textContent, HOSTILE);
    assert.equal(form.querySelector('textarea').textContent, `${HOSTILE}</textarea><b>`);
    assert.equal(form.querySelectorAll('textarea').length, 1);

    const create = renderWorklogEditor(hostileWorklog, { date: '2026-10-21', time: '13:00', hours: '', minutes: '', comment: '' }, '', { mode: 'create' });
    assert.equal(hasInjectedElements(create), false);
    assert.equal(create.querySelector('.editor-issue-summary').textContent, HOSTILE);
    assert.equal(create.querySelector('#worklogEditHours').getAttribute('value'), '');
  });

  it('the delete confirmation shows the issue key and summary as text', () => {
    const body = renderDeleteWorklogDialog(describeWorklogForDeletion({ ...hostileWorklog, issueKey: HOSTILE }));
    assert.equal(hasInjectedElements(body), false);
    assert.equal(body.querySelectorAll('dd')[0].textContent, `${HOSTILE} · ${HOSTILE}`);
    assert.equal(body.querySelector('[data-action="delete"]').textContent, 'Delete worklog');
  });

  it('connection status messages show Jira account details and errors as text', () => {
    const success = renderConnectionStatus('success', {
      user: { displayName: HOSTILE, emailAddress: HOSTILE },
      serverInfo: { version: HOSTILE },
      testedAt: '2026-10-21T12:00:00.000Z'
    });
    assert.equal(success.some(hasInjectedElements), false);
    assert.equal(success[1].querySelector('.user-name').textContent, HOSTILE);
    assert.equal(success[1].querySelector('.user-meta').textContent, `${HOSTILE} • Jira v${HOSTILE}`);
    assert.equal(success[1].querySelector('.user-avatar').textContent, '<');

    const error = renderConnectionStatus('error', { error: HOSTILE, serverMessage: HOSTILE, testedAt: '2026-10-21T12:00:00.000Z' });
    assert.equal(error.some(hasInjectedElements), false);
    const paragraphs = error[1].querySelectorAll('p');
    assert.equal(paragraphs[0].textContent, HOSTILE);
    assert.equal(paragraphs[1].textContent, `Server detail: ${HOSTILE}`);
    assert.equal(paragraphs[1].querySelector('strong').textContent, 'Server detail:');
    assert.equal(error[0].textContent, 'Connection Failed');
    const titled = renderConnectionStatus('error', { title: HOSTILE, error: HOSTILE });
    assert.equal(titled.some(hasInjectedElements), false);
    assert.equal(titled[0].textContent, HOSTILE);

    const info = renderConnectionStatus('info', { title: HOSTILE, message: HOSTILE });
    assert.equal(info.some(hasInjectedElements), false);
    assert.equal(textOf(info), `${HOSTILE}${HOSTILE}`);

    const loading = renderConnectionStatus('loading');
    assert.equal(textOf(loading), 'Connecting to Jira...Verifying credentials and identity endpoint.');
    assert.ok(loading[0].querySelector('.btn-spinner'));
  });
});
