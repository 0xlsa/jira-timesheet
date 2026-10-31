/**
 * Screenshot harness for Timesheet for Jira (see README.md in this folder).
 *
 * capture.py serves the repository and loads options.html with this script before options.js, so
 * the real page, styles, and modules run unchanged. This script only stands in for what a capture
 * can't have: the browser extension APIs, the Jira site, Nager.Date, and the clock.
 *
 * - window.__CAPTURE__ (set by capture.py): { scenario, data, manifest, holidays }
 * - The clock is fixed at the scenario's `now` and runs on from there.
 * - chrome.storage.local is an in-memory area seeded with the scenario's storage.
 * - fetch() answers the Jira REST endpoints the extension calls from demo-data.json, and
 *   Nager.Date from the holiday data capture.py fetched. Anything else goes to the network.
 * - CSS transitions and animations are off: Chrome runs them in real time, not the capture's
 *   virtual time, so a drawer could be captured mid-slide.
 * - After the page has loaded, the scenario's steps run (clicks, typing), and the page is marked
 *   ready with `document.documentElement.dataset.captureReady`.
 *
 * Nothing here is part of the extension.
 */
(() => {
  const { scenario, data, manifest, holidays } = window.__CAPTURE__;
  const SITE = data.site;
  const user = data.user;

  // ---------------------------------------------------------------------------------- Clock
  const RealDate = Date;
  const offset = RealDate.parse(scenario.now) - RealDate.now();
  class CaptureDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() { return RealDate.now() + offset; }
  }
  window.Date = CaptureDate;
  const at = (iso) => RealDate.parse(iso);

  // ------------------------------------------------------------------------------ Transitions
  document.documentElement.append(Object.assign(document.createElement('style'), {
    textContent: '*, *::before, *::after { transition: none !important; animation: none !important; }'
  }));

  // ---------------------------------------------------------------------------- localStorage
  localStorage.clear();
  for (const [key, value] of Object.entries(scenario.localStorage || {})) localStorage.setItem(key, value);

  // ------------------------------------------------------------------------ Extension storage
  const store = structuredClone(scenario.storage || {});
  // Timestamps in the seeded timer state are written as ISO dates in the scenario.
  if (store.timeTracking) {
    const toMs = (record) => {
      for (const key of ['startedAt', 'stoppedAt', 'resumedAt']) {
        if (typeof record[key] === 'string') record[key] = at(record[key]);
      }
      return record;
    };
    if (store.timeTracking.running) toMs(store.timeTracking.running);
    store.timeTracking.pending = (store.timeTracking.pending || []).map(toMs);
  }
  const listeners = new Set();
  const keysOf = (keys) => (keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys));
  const local = {
    async get(keys) {
      const result = {};
      if (keys && typeof keys === 'object' && !Array.isArray(keys)) Object.assign(result, keys);
      for (const key of keysOf(keys)) if (key in store) result[key] = structuredClone(store[key]);
      return result;
    },
    async set(items) {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: store[key], newValue: value };
        store[key] = structuredClone(value);
      }
      for (const listener of listeners) queueMicrotask(() => listener(changes, 'local'));
    },
    async remove(keys) {
      const changes = {};
      for (const key of keysOf(keys)) {
        if (key in store) changes[key] = { oldValue: store[key] };
        delete store[key];
      }
      for (const listener of listeners) queueMicrotask(() => listener(changes, 'local'));
    }
  };
  window.chrome = {
    runtime: { id: 'capture', getManifest: () => manifest },
    storage: {
      local,
      onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) }
    }
    // No permissions API: site access then always counts as granted.
  };

  // ---------------------------------------------------------------------------------- Jira
  const STATUS_NAMES = { new: 'To Do', indeterminate: 'In Progress', done: 'Done' };
  const STATUS_IDS = { new: 2, indeterminate: 4, done: 3 };
  const jiraUser = { accountId: user.accountId, displayName: user.displayName, emailAddress: user.emailAddress, active: true, timeZone: scenario.timeZone };
  const adf = (text) => (text ? { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } : undefined);
  const toWorklog = (issue, wl) => ({
    id: wl.id,
    issueId: issue.id,
    author: jiraUser,
    updateAuthor: jiraUser,
    comment: adf(wl.comment),
    started: wl.started,
    timeSpent: formatJiraDuration(wl.seconds),
    timeSpentSeconds: wl.seconds
  });
  function formatJiraDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return [h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m';
  }
  const worklogPage = (issue) => {
    const worklogs = issue.worklogs.map((wl) => toWorklog(issue, wl));
    return { startAt: 0, maxResults: worklogs.length, total: worklogs.length, worklogs };
  };
  const toJiraIssue = (issue, fields) => {
    const all = {
      summary: issue.summary,
      status: {
        name: issue.status,
        statusCategory: { id: STATUS_IDS[issue.category], key: issue.category, name: STATUS_NAMES[issue.category] }
      },
      assignee: issue.assigned ? jiraUser : null,
      updated: issue.updated,
      worklog: worklogPage(issue)
    };
    const picked = {};
    for (const field of fields) if (field in all) picked[field] = all[field];
    return { id: issue.id, key: issue.key, fields: picked };
  };
  const byUpdated = (a, b) => at(b.updated) - at(a.updated);
  const issueByKey = (key) => data.issues.find((issue) => issue.key === key);

  // The worklog date range of a JQL query: worklogDate >= "YYYY-MM-DD" AND worklogDate <= "YYYY-MM-DD".
  function loggedInRange(issue, jql) {
    const from = /worklogDate >= "(\d{4}-\d{2}-\d{2})"/.exec(jql)?.[1];
    const to = /worklogDate <= "(\d{4}-\d{2}-\d{2})"/.exec(jql)?.[1];
    if (!from || !to) return false;
    return issue.worklogs.some((wl) => {
      const day = wl.started.slice(0, 10);
      return day >= from && day <= to;
    });
  }

  function search(jql) {
    // Issue key suggestions: the query names the keys it wants.
    const keys = [...jql.matchAll(/\b([A-Z][A-Z0-9_]*-\d+)\b/g)].map((m) => m[1]);
    if (keys.length) return keys.map(issueByKey).filter(Boolean);
    const activeClause = jql.includes('statusCategory = "In Progress"');
    return data.issues
      .filter((issue) => loggedInRange(issue, jql) || (activeClause && issue.assigned && issue.category === 'indeterminate'))
      .sort(byUpdated);
  }

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  function answerJira(url, init) {
    const method = (init?.method || 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/rest\/api\/[23]\//, '');
    if (path === 'myself') return json(jiraUser);
    if (path === 'serverInfo') return json({ version: '10.3.1', deploymentType: 'Server', serverTitle: 'Jira' });
    if (path === 'search/jql' || path === 'search') {
      const fields = (url.searchParams.get('fields') || 'summary').split(',');
      const issues = search(url.searchParams.get('jql') || '').map((issue) => toJiraIssue(issue, fields));
      return json({ issues, isLast: true, startAt: 0, maxResults: issues.length, total: issues.length });
    }
    let match = /^issue\/([^/]+)\/worklog$/.exec(path);
    if (match) {
      const issue = issueByKey(decodeURIComponent(match[1])) || data.issues.find((i) => i.id === match[1]);
      if (!issue) return json({ errorMessages: ['Issue does not exist'] }, 404);
      if (method === 'POST') {
        const body = JSON.parse(init.body || '{}');
        return json({ id: String(Date.now()), issueId: issue.id, author: jiraUser, started: body.started, timeSpentSeconds: body.timeSpentSeconds }, 201);
      }
      return json(worklogPage(issue));
    }
    match = /^issue\/([^/?]+)$/.exec(path);
    if (match) {
      const issue = issueByKey(decodeURIComponent(match[1]));
      if (!issue) return json({ errorMessages: ['Issue does not exist'] }, 404);
      return json(toJiraIssue(issue, (url.searchParams.get('fields') || 'summary').split(',')));
    }
    return json({ errorMessages: [`Not available in the screenshot harness: ${method} ${url.pathname}`] }, 404);
  }

  // ------------------------------------------------------------------------------ Nager.Date
  function answerNager(url) {
    if (url.pathname.endsWith('/Countries/Available')) return json(holidays.countries);
    const match = /\/Holidays\/([A-Z]{2})\/(\d{4})$/.exec(url.pathname);
    const list = match && holidays.years[`${match[1]}:${match[2]}`];
    return list ? json(list) : json([], 404);
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin === new URL(SITE).origin) return answerJira(url, init);
    if (url.hostname === 'nagerholidays.com') return answerNager(url);
    return realFetch(input, init);
  };

  // ------------------------------------------------------------------------------ Scenario steps
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(selector, timeoutMs = 5000) {
    const start = performance.now();
    for (;;) {
      const el = document.querySelector(selector);
      if (el) return el;
      if (performance.now() - start > timeoutMs) throw new Error(`capture: ${selector} never appeared`);
      await sleep(50);
    }
  }
  function type(el, text) {
    el.focus();
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const STEPS = {
    async click(step) { (await waitFor(step.selector)).click(); },
    async type(step) { type(await waitFor(step.selector), step.text); },
    async wait(step) { await waitFor(step.selector, step.timeoutMs); },
    async sleep(step) { await sleep(step.ms); },
    async key(step) {
      document.activeElement?.blur?.();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: step.key, bubbles: true }));
    },
    async blur() { document.activeElement?.blur?.(); }
  };

  window.addEventListener('load', async () => {
    try {
      for (const step of scenario.steps || []) await STEPS[step.do](step);
      await sleep(300);
      document.documentElement.dataset.captureReady = 'true';
    } catch (err) {
      document.documentElement.dataset.captureReady = 'error';
      document.body.prepend(Object.assign(document.createElement('pre'), { textContent: String(err), style: 'color:red;font-size:24px' }));
    }
  });
})();
