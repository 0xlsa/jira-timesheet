/**
 * Submitting a pending worklog (a stopped timer session, see src/timer/timeTrackingStore.js) to
 * Jira as a worklog, with the session's issue, start, duration, and comment.
 *
 * The pending worklog leaves this browser only once Jira has confirmed the worklog. Jira can create
 * a worklog and still have its answer lost (a timeout, a dropped connection, a server error), so an
 * unanswered submission is recorded as uncertain, never as failed: submitting it again first looks
 * for the worklog in Jira, and sends nothing when it's there. A refusal from Jira (an HTTP error
 * that says why) created nothing, and submitting again is safe. Nothing is retried automatically.
 */

import { logWork } from './weeklyWorklogService.js';
import { isWorklogByUser } from '../jira/JiraClient.js';

// Jira answered with a refusal (JiraClient's worklog errors): no worklog was created. Any other
// error, including a timeout, a network failure, a server error, or an unreadable answer to a
// request Jira accepted, may hide a created worklog.
const DEFINITE_FAILURES = new Set(['AUTH_INVALID', 'XSRF', 'FORBIDDEN', 'NOT_FOUND', 'INVALID', 'HTTP_ERROR']);

// How close a Jira worklog's start and duration must be to the pending worklog's to be the same
// one: Jira may keep only whole minutes.
const MATCH_TOLERANCE_SECONDS = 60;

/**
 * True when a failed request certainly created no worklog in Jira.
 * @param {Error & { errorType?: string }} err
 * @returns {boolean}
 */
export function isDefiniteFailure(err) {
  return DEFINITE_FAILURES.has(err?.errorType);
}

/**
 * Looks in Jira for a worklog that a submission of this pending worklog created: by the current
 * user, on its issue, starting and lasting the same (to the minute).
 *
 * @param {{ getCurrentUser: Function, getAllIssueWorklogs: Function }} client
 * @param {{ issueId?: string, issueKey: string, startedAt: number, timeSpentSeconds: number }} entry
 * @returns {Promise<object | null>} Jira's worklog, or null
 */
export async function findSubmittedWorklog(client, entry) {
  const [user, worklogs] = await Promise.all([
    client.getCurrentUser(),
    client.getAllIssueWorklogs(entry.issueId || entry.issueKey)
  ]);
  return worklogs.find((wl) =>
    isWorklogByUser(wl, user) &&
    Math.abs(new Date(wl.started).getTime() - entry.startedAt) < MATCH_TOLERANCE_SECONDS * 1000 &&
    Math.abs(Number(wl.timeSpentSeconds) - entry.timeSpentSeconds) < MATCH_TOLERANCE_SECONDS) || null;
}

/** A Jira worklog as a source worklog of the week (like logWork()'s), for the timesheet. */
function toSourceWorklog(worklog, entry, author) {
  return {
    id: String(worklog.id),
    issueId: entry.issueId,
    issueKey: entry.issueKey,
    issueSummary: entry.issueSummary,
    started: worklog.started,
    timeSpentSeconds: Number(worklog.timeSpentSeconds) || 0,
    timeSpent: worklog.timeSpent ?? '',
    comment: worklog.comment,
    author: worklog.author ?? author
  };
}

/**
 * Submits one pending worklog to Jira.
 *
 * 1. Marks it as being submitted (refused when it's under a minute, from another Jira site, changed
 *    since the user chose it, or already being submitted); that throws, and nothing is sent.
 * 2. After an uncertain submission, looks for it in Jira first; found, it's complete without sending.
 * 3. Creates the worklog, then removes the pending worklog. A refusal keeps it as failed; no answer
 *    keeps it as uncertain.
 *
 * @param {object} options
 * @param {{ beginSubmission: Function, completeSubmission: Function, failSubmission: Function }} options.timer -
 *   The page's timer controller
 * @param {object} options.client - JiraClient for the connected site
 * @param {string} options.id - The pending worklog's ID
 * @param {string} options.site - The connected site's ID; the pending worklog must be from it
 * @param {object} [options.expected] - The values the user chose to submit
 * @param {object} [options.author] - Shown on the new worklog when Jira's answer has no author
 * @returns {Promise<{ status: 'submitted' | 'already-in-jira' | 'failed' | 'uncertain', entry: object,
 *   worklog?: object, message?: string }>} `worklog`, once Jira has it, as a source worklog of the week
 * @throws {Error} A user-facing reason when the pending worklog can't be submitted (step 1)
 */
export async function submitPendingWorklog({ timer, client, id, site, expected, author }) {
  const { entry, previous } = await timer.beginSubmission(id, { site, expected });
  const keep = async (uncertain, message) => {
    try {
      await timer.failSubmission(id, { uncertain, message: uncertain ? undefined : message });
    } catch {
      // Left marked as being submitted, it reads as uncertain once stale: still never lost or sent twice.
    }
    return { status: uncertain ? 'uncertain' : 'failed', entry, message };
  };
  const complete = async (status, worklog) => {
    try {
      await timer.completeSubmission(id);
      return { status, entry, worklog };
    } catch {
      return {
        status, entry, worklog,
        message: "It's in Jira, but couldn't be removed from Pending here. Submitting it again finds it in Jira and removes it."
      };
    }
  };

  if (previous === 'uncertain') {
    let existing;
    try {
      existing = await findSubmittedWorklog(client, entry);
    } catch (err) {
      return keep(true, `Couldn't check whether Jira already has ${entry.issueKey}'s worklog (${err.message}). ` +
        'Nothing was sent; try again.');
    }
    if (existing) return complete('already-in-jira', toSourceWorklog(existing, entry, author));
  }

  let created;
  try {
    created = await logWork(client,
      { issueId: entry.issueId, issueKey: entry.issueKey, issueSummary: entry.issueSummary },
      {
        started: new Date(entry.startedAt),
        timeSpentSeconds: entry.timeSpentSeconds,
        // A blank comment is left out, as when logging work by hand.
        ...(entry.comment.trim() ? { comment: entry.comment } : {})
      },
      author);
  } catch (err) {
    if (isDefiniteFailure(err)) return keep(false, err.message);
    return keep(true, `Jira didn't answer, so it may or may not have ${entry.issueKey}'s worklog. It's kept in Pending; ` +
      "submitting it again checks Jira first, so it won't be added twice.");
  }
  return complete('submitted', created);
}
