/**
 * Issue key autocomplete: recognizes a partial issue key typed by the user, builds a bounded
 * JQL query for it, and checks and orders what Jira returns. No DOM and no network access.
 *
 * Jira issue keys are `PROJECTKEY-NUMBER`. Project keys start with a letter followed by
 * letters, digits, or underscores; no project prefix is assumed.
 */

// Most suggestions shown for one query.
export const ISSUE_SUGGESTION_LIMIT = 10;

// Longest issue number accepted; anything longer is a typo, not an issue.
const MAX_QUERY_NUMBER_DIGITS = 12;

const ISSUE_KEY_QUERY = new RegExp(`^([A-Z][A-Z0-9_]*)-([1-9]\\d{0,${MAX_QUERY_NUMBER_DIGITS - 1}})$`);

/**
 * Parses autocomplete input as a partial issue key. It needs the project key, the hyphen,
 * and at least one digit (`ABC-3`); `A`, `ABC`, and `ABC-` aren't searched yet.
 *
 * @param {string} text - As typed; surrounding spaces and letter case are ignored
 * @returns {{ key: string, projectKey: string, number: string } | null}
 */
export function parseIssueKeyQuery(text) {
  const match = ISSUE_KEY_QUERY.exec(String(text ?? '').trim().toUpperCase());
  if (!match) return null;

  const [, projectKey, number] = match;
  return { key: `${projectKey}-${number}`, projectKey, number };
}

/**
 * Builds the JQL for a partial key: the key itself and the ten keys one digit longer
 * (`ABC-3` → ABC-3, ABC-30 … ABC-39), in key order, so the exact key comes first.
 *
 * It lists keys with `key in (…)` rather than key ranges: Jira Cloud rejects the whole query
 * when a range bound names an issue that doesn't exist, but skips missing keys in a list
 * (it only fails, with 400, when none of them exist). Data Center / Server rejects missing
 * keys in a list too, unless the search is sent with `validateQuery=warn`.
 *
 * @param {{ key: string }} query - From parseIssueKeyQuery()
 * @returns {string}
 */
export function buildIssueKeySuggestionJql({ key }) {
  const keys = [key, ...Array.from({ length: 10 }, (_, digit) => `${key}${digit}`)];
  return `key in (${keys.map((k) => `"${k}"`).join(', ')}) ORDER BY key ASC`;
}

/**
 * Returns true when `issueKey` is the typed key itself or the typed key followed by more
 * digits. A shorter key never matches a longer query: `ABC-308` doesn't match `ABC-3086`.
 *
 * @param {string} issueKey
 * @param {{ key: string }} query - From parseIssueKeyQuery()
 * @returns {boolean}
 */
export function issueKeyMatchesQuery(issueKey, { key }) {
  const candidate = String(issueKey ?? '').toUpperCase();
  return candidate === key || (candidate.startsWith(key) && /^\d+$/.test(candidate.slice(key.length)));
}

/**
 * Keeps only issues whose key matches the query and orders them: the exact key first, then
 * shorter numbers before longer ones, then by number (ABC-3, ABC-30, ABC-31, …, ABC-300).
 *
 * @param {Array<{ issueKey: string }>} issues
 * @param {{ key: string }} query - From parseIssueKeyQuery()
 * @returns {Array<{ issueKey: string }>}
 */
export function rankIssueKeyMatches(issues, query) {
  const numberOf = (issue) => issue.issueKey.slice(issue.issueKey.lastIndexOf('-') + 1);
  return issues
    .filter((issue) => issueKeyMatchesQuery(issue.issueKey, query))
    .sort((a, b) => numberOf(a).length - numberOf(b).length || Number(numberOf(a)) - Number(numberOf(b)));
}
