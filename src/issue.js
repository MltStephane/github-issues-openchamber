/** GitHub issue model shared by the panel and the service. Pure ESM, no Node import. */

/** Longest issue body kept; the panel and the prompt never need the full thread. */
export const ISSUE_BODY_MAX = 4000;

/**
 * Reads an issue number from a number or a digit-only string.
 * Returns a positive safe integer, or `null` for anything else
 * (`0`, negatives, floats, `"12abc"`, empty input).
 */
export function parseIssueNumber(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return null;

  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * Turns one item of `gh issue list --json number,title,url,author,labels,updatedAt,body`
 * into the panel's issue shape. Returns `null` when the number or the title is unusable.
 */
export function normalizeIssue(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const number = parseIssueNumber(raw.number);
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (number === null || title === '') return null;

  return {
    number,
    title,
    url: typeof raw.url === 'string' ? raw.url : '',
    author: typeof raw.author?.login === 'string' ? raw.author.login : '',
    labels: labelNames(raw.labels),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    body: typeof raw.body === 'string' ? raw.body.slice(0, ISSUE_BODY_MAX) : '',
  };
}

/**
 * Keeps the issues whose title, `#number` or a label contains the query,
 * case-insensitively. A blank query keeps every issue.
 */
export function filterIssues(issues, query) {
  const list = Array.isArray(issues) ? issues : [];
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (needle === '') return [...list];

  return list.filter((issue) => {
    if (String(issue?.title || '').toLowerCase().includes(needle)) return true;
    if (`#${issue?.number}`.includes(needle)) return true;
    return labelNames(issue?.labels).some((label) => label.toLowerCase().includes(needle));
  });
}

function labelNames(labels) {
  if (!Array.isArray(labels)) return [];

  return labels
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter((name) => typeof name === 'string' && name !== '');
}
