import assert from 'node:assert/strict';
import test from 'node:test';

import { buildImplementPrompt, PROMPT_MAX } from '../src/prompt.js';

const INSTRUCTIONS =
  'Investigate the cause, implement the fix and verify it. Do not commit: the change is committed from the GitHub Issues panel.';

test('buildImplementPrompt names the issue, its link and its body', () => {
  const prompt = buildImplementPrompt({ number: 7, title: 'Crash', url: 'https://github.com/o/r/issues/7', body: ' Steps \n' });
  assert.equal(prompt, `Fix GitHub issue #7: Crash\nhttps://github.com/o/r/issues/7\n\nSteps\n\n${INSTRUCTIONS}`);
});

test('buildImplementPrompt says when the issue has no description', () => {
  const prompt = buildImplementPrompt({ number: 7, title: 'Crash', url: 'u', body: '   ' });
  assert.match(prompt, /\n\n\(no description\)\n\n/);
});

test('buildImplementPrompt clamps a long body and keeps the instructions', () => {
  const prompt = buildImplementPrompt({ number: 7, title: 'Crash', url: 'u', body: 'x'.repeat(PROMPT_MAX * 2) });
  assert.equal(prompt.length, PROMPT_MAX);
  assert.ok(prompt.endsWith(INSTRUCTIONS));
});
