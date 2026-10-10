import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCommitMessage,
  buildIssueComment,
  CLOSING_KEYWORDS,
  COMMENT_MAX,
  DEFAULT_CLOSING_KEYWORD,
  defaultCommitSubject,
  SUBJECT_MAX,
  suggestIssueComment,
} from '../src/commit.js';

test('closing keywords are GitHub ones and the default is among them', () => {
  assert.deepEqual(CLOSING_KEYWORDS, ['Closes', 'Fixes', 'Resolves']);
  assert.ok(CLOSING_KEYWORDS.includes(DEFAULT_CLOSING_KEYWORD));
});

test('defaultCommitSubject keeps a short title on one line', () => {
  assert.equal(defaultCommitSubject({ title: '  Fix login\n crash ' }), 'Fix login crash');
  assert.equal(defaultCommitSubject({}), '');
});

test('defaultCommitSubject cuts a long title on a word boundary', () => {
  const title = `${'word '.repeat(20)}end`;
  const subject = defaultCommitSubject({ title });
  assert.ok(subject.length <= SUBJECT_MAX);
  assert.ok(subject.endsWith('word'));
  assert.ok(!subject.includes('…'));
});

test('defaultCommitSubject hard cuts a title without spaces', () => {
  assert.equal(defaultCommitSubject({ title: 'x'.repeat(100) }), 'x'.repeat(SUBJECT_MAX));
});

test('buildCommitMessage adds the closing footer', () => {
  assert.deepEqual(buildCommitMessage({ subject: ' Fix login ', issueNumber: 12, keyword: 'Closes' }), {
    ok: true,
    value: 'Fix login\n\nCloses #12\n',
    error: '',
  });
  assert.equal(buildCommitMessage({ subject: 'Fix', issueNumber: '3', keyword: 'Fixes' }).value, 'Fix\n\nFixes #3\n');
});

test('buildCommitMessage refuses bad input', () => {
  assert.equal(buildCommitMessage({ subject: '  ', issueNumber: 1, keyword: 'Closes' }).ok, false);
  assert.equal(buildCommitMessage({ subject: 'Fix', issueNumber: 1, keyword: 'closes' }).ok, false);
  assert.equal(buildCommitMessage({ subject: 'Fix', issueNumber: 1, keyword: 'Closes #2' }).ok, false);
  assert.equal(buildCommitMessage({ subject: 'Fix', issueNumber: 0, keyword: 'Closes' }).ok, false);
  assert.equal(buildCommitMessage({ subject: 'Fix', issueNumber: '1a', keyword: 'Closes' }).ok, false);
  assert.equal(buildCommitMessage().ok, false);
  assert.equal(buildCommitMessage({ subject: 'Fix', issueNumber: 1, keyword: 'Nope' }).value, '');
});

test('suggestIssueComment only speaks for a side branch', () => {
  assert.equal(suggestIssueComment({ branch: 'main', defaultBranch: 'main' }), '');
  assert.equal(suggestIssueComment({ branch: '', defaultBranch: 'main' }), '');
  assert.equal(suggestIssueComment({ branch: 'fix/login', defaultBranch: '' }), '');
  assert.equal(suggestIssueComment(), '');
  assert.equal(
    suggestIssueComment({ branch: 'fix/login', defaultBranch: 'main' }),
    'Fix committed on `fix/login`. This issue closes once it is merged into `main`.',
  );
});

test('buildIssueComment appends the SHA and skips a blank text', () => {
  assert.equal(buildIssueComment({ text: '  ', sha: 'abc' }), '');
  assert.equal(buildIssueComment(), '');
  assert.equal(buildIssueComment({ text: ' Done. ', sha: 'abc123' }), 'Done.\n\nCommit: abc123');
});

test('buildIssueComment stays within the comment cap and keeps the SHA', () => {
  const comment = buildIssueComment({ text: 'x'.repeat(COMMENT_MAX * 2), sha: 'abc123' });
  assert.equal(comment.length, COMMENT_MAX);
  assert.ok(comment.endsWith('Commit: abc123'));
});
