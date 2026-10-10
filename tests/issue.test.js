import assert from 'node:assert/strict';
import test from 'node:test';

import { filterIssues, ISSUE_BODY_MAX, normalizeIssue, parseIssueNumber } from '../src/issue.js';

test('parseIssueNumber accepts positive integers and digit strings', () => {
  assert.equal(parseIssueNumber(12), 12);
  assert.equal(parseIssueNumber('12'), 12);
  assert.equal(parseIssueNumber('007'), 7);
});

test('parseIssueNumber rejects everything else', () => {
  for (const value of [0, -3, 1.5, '0', '-3', '1.5', '12abc', '', ' 12', null, undefined, {}, Number.NaN, 2 ** 60, '99999999999999999999']) {
    assert.equal(parseIssueNumber(value), null, `value ${String(value)}`);
  }
});

test('normalizeIssue maps a gh issue list item', () => {
  const issue = normalizeIssue({
    number: 4,
    title: '  Crash on start  ',
    url: 'https://github.com/o/r/issues/4',
    author: { login: 'octocat' },
    labels: [{ name: 'bug' }, { name: '' }, { color: 'red' }, { name: 'p1' }],
    updatedAt: '2026-10-01T10:00:00Z',
    body: 'Steps',
  });

  assert.deepEqual(issue, {
    number: 4,
    title: 'Crash on start',
    url: 'https://github.com/o/r/issues/4',
    author: 'octocat',
    labels: ['bug', 'p1'],
    updatedAt: '2026-10-01T10:00:00Z',
    body: 'Steps',
  });
});

test('normalizeIssue fills missing optional fields and truncates the body', () => {
  const issue = normalizeIssue({ number: 1, title: 'A', body: 'x'.repeat(ISSUE_BODY_MAX + 50) });
  assert.equal(issue.url, '');
  assert.equal(issue.author, '');
  assert.deepEqual(issue.labels, []);
  assert.equal(issue.updatedAt, '');
  assert.equal(issue.body.length, ISSUE_BODY_MAX);
});

test('normalizeIssue refuses an unusable number or title', () => {
  assert.equal(normalizeIssue(null), null);
  assert.equal(normalizeIssue('issue'), null);
  assert.equal(normalizeIssue({ number: 0, title: 'A' }), null);
  assert.equal(normalizeIssue({ number: 3, title: '   ' }), null);
  assert.equal(normalizeIssue({ number: 3 }), null);
});

test('filterIssues matches title, number and labels case-insensitively', () => {
  const issues = [
    { number: 12, title: 'Login fails', labels: ['bug'] },
    { number: 30, title: 'Add dark mode', labels: ['Enhancement'] },
  ];

  assert.deepEqual(filterIssues(issues, 'LOGIN').map((issue) => issue.number), [12]);
  assert.deepEqual(filterIssues(issues, '#30').map((issue) => issue.number), [30]);
  assert.deepEqual(filterIssues(issues, '12').map((issue) => issue.number), [12]);
  assert.deepEqual(filterIssues(issues, 'enhance').map((issue) => issue.number), [30]);
  assert.deepEqual(filterIssues(issues, 'nothing'), []);
});

test('filterIssues keeps everything for a blank query and tolerates bad input', () => {
  const issues = [{ number: 1, title: 'A', labels: [] }];
  const result = filterIssues(issues, '  ');
  assert.deepEqual(result, issues);
  assert.notEqual(result, issues);
  assert.deepEqual(filterIssues(null, 'a'), []);
});
