import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderIssueStatusBadge, renderWorklogItem } from '../src/ui/weekView.js';

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

const worklog = (issueStatus) => ({
  issueKey: 'EKB-30755',
  issueSummary: 'Summary',
  issueStatus,
  comment: '',
  formattedStartTime: '09:00',
  formattedDuration: '1h',
  author: { displayName: 'Dev' }
});

describe('WeekView - issue status badge', () => {
  let previousDocument;
  before(() => {
    previousDocument = globalThis.document;
    installDocumentStub();
  });
  after(() => {
    globalThis.document = previousDocument;
  });

  it('maps Jira status categories to badge classes', () => {
    assert.match(renderIssueStatusBadge({ name: 'To Do', categoryKey: 'new' }), /status-category-new/);
    assert.match(renderIssueStatusBadge({ name: 'In Progress', categoryKey: 'indeterminate' }), /status-category-indeterminate/);
    assert.match(renderIssueStatusBadge({ name: 'Done', categoryKey: 'done' }), /status-category-done/);
  });

  it('renders custom or uncategorized statuses with the neutral style', () => {
    const html = renderIssueStatusBadge({ name: 'Waiting for <Vendor>', categoryKey: 'undefined' });
    assert.match(html, /status-category-unknown/);
    assert.match(html, /class="issue-status-name">Waiting for &lt;Vendor&gt;</);
    assert.match(html, /title="Status: Waiting for &lt;Vendor&gt;"/);
    assert.doesNotMatch(html, /<Vendor>/);
  });

  it('renders nothing when the status is missing', () => {
    assert.equal(renderIssueStatusBadge(null), '');
    assert.equal(renderIssueStatusBadge(undefined), '');
    assert.equal(renderIssueStatusBadge({ name: '  ', categoryKey: 'done' }), '');
  });

  it('places the status directly after the issue key link', () => {
    const html = renderWorklogItem(worklog({ name: 'In Progress', categoryKey: 'indeterminate' }), 'https://jira.example.com/');
    assert.match(html, /<div class="worklog-issue">\s*<a href="https:\/\/jira.example.com\/browse\/EKB-30755"[^>]*class="issue-key-badge"[\s\S]*?<\/a>\s*<span class="issue-status status-category-indeterminate"/);
  });

  it('keeps the worklog item intact without a status', () => {
    const html = renderWorklogItem(worklog(null), 'https://jira.example.com');
    assert.doesNotMatch(html, /issue-status/);
    assert.match(html, /class="issue-key-badge"/);
    assert.match(html, /class="worklog-duration-badge">1h</);
  });
});

describe('WeekView - status label styles', () => {
  const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
  const variablesIn = (selector) => {
    const block = css.slice(css.indexOf(`${selector} {`));
    return new Set([...block.slice(0, block.indexOf('}')).matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
  };

  it('shows the status name as Jira returns it, without uppercasing or single-line truncation', () => {
    const statusRules = [...css.matchAll(/\.issue-status[^{]*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
    assert.doesNotMatch(statusRules, /text-transform/);
    assert.doesNotMatch(statusRules, /text-overflow:\s*ellipsis/);
  });

  it('uses only theme variables, which the light theme overrides or inherits from :root', () => {
    const rootVars = variablesIn(':root');
    const statusRules = [...css.matchAll(/\.(?:issue-status|status-category-)[^{]*\{([^}]*)\}/g)].map((m) => m[1]).join('\n');
    const used = new Set([...statusRules.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));

    assert.ok(used.size > 0);
    for (const variable of used) {
      assert.ok(rootVars.has(variable), `${variable} is not a theme variable`);
    }
    assert.doesNotMatch(statusRules, /#[0-9a-f]{3,8}\b/i, 'status colors should come from theme variables');
  });
});
