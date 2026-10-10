/** Commit message and issue comment rules. Pure ESM, no Node import. */

import { parseIssueNumber } from './issue.js';

/** GitHub keywords that close the referenced issue once the commit reaches the default branch. */
export const CLOSING_KEYWORDS = ['Closes', 'Fixes', 'Resolves'];

export const DEFAULT_CLOSING_KEYWORD = 'Closes';

/** Conventional width of a Git subject line. */
export const SUBJECT_MAX = 72;

/** Longest comment posted on an issue. */
export const COMMENT_MAX = 8000;

/**
 * Proposes a commit subject from the issue title: one line, at most
 * `SUBJECT_MAX` characters, cut on a word boundary when one exists.
 */
export function defaultCommitSubject(issue) {
  const title = oneLine(issue?.title);
  if (title.length <= SUBJECT_MAX) return title;

  const cut = title.slice(0, SUBJECT_MAX);
  const boundary = cut.lastIndexOf(' ');
  return boundary > 0 ? cut.slice(0, boundary).trimEnd() : cut;
}

/**
 * Builds `"<subject>\n\n<keyword> #<n>\n"`.
 *
 * Returns `{ ok, value, error }`; `value` is `''` when the input is refused
 * (empty subject, unknown keyword, invalid issue number).
 */
export function buildCommitMessage({ subject, issueNumber, keyword } = {}) {
  const line = oneLine(subject);
  if (line === '') return { ok: false, value: '', error: 'A commit subject is required.' };

  if (!CLOSING_KEYWORDS.includes(keyword)) {
    return { ok: false, value: '', error: `The closing keyword must be one of ${CLOSING_KEYWORDS.join(', ')}.` };
  }

  const number = parseIssueNumber(issueNumber);
  if (number === null) return { ok: false, value: '', error: 'A valid issue number is required.' };

  return { ok: true, value: `${line}\n\n${keyword} #${number}\n`, error: '' };
}

/**
 * Suggests a comment when the fix lands on a side branch: the issue only
 * closes once that branch is merged into the default branch.
 * Returns `''` on the default branch or when a branch is unknown.
 */
export function suggestIssueComment({ branch, defaultBranch } = {}) {
  const current = typeof branch === 'string' ? branch.trim() : '';
  const target = typeof defaultBranch === 'string' ? defaultBranch.trim() : '';
  if (current === '' || target === '' || current === target) return '';

  return `Fix committed on \`${current}\`. This issue closes once it is merged into \`${target}\`.`;
}

/**
 * Builds the issue comment with the commit SHA appended, capped at
 * `COMMENT_MAX` characters. A blank text means no comment: `''`.
 */
export function buildIssueComment({ text, sha } = {}) {
  const message = typeof text === 'string' ? text.trim() : '';
  if (message === '') return '';

  const footer = `\n\nCommit: ${typeof sha === 'string' ? sha.trim() : ''}`;
  return `${message.slice(0, Math.max(0, COMMENT_MAX - footer.length))}${footer}`.slice(0, COMMENT_MAX);
}

function oneLine(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}
