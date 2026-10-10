/** The prompt that asks an agent to fix an issue. Pure ESM, no Node import. */

/** Host compose limit: a longer prompt would be clamped by the host anyway. */
export const PROMPT_MAX = 16000;

const NO_DESCRIPTION = '(no description)';
const INSTRUCTIONS =
  'Investigate the cause, implement the fix and verify it. Do not commit: the change is committed from the GitHub Issues panel.';

/**
 * Builds the short prompt sent for an issue. When the prompt would exceed
 * `PROMPT_MAX`, the issue body is shortened so the instructions always survive.
 */
export function buildImplementPrompt(issue) {
  const head = `Fix GitHub issue #${issue?.number}: ${issue?.title || ''}\n${issue?.url || ''}\n\n`;
  const tail = `\n\n${INSTRUCTIONS}`;
  const body = typeof issue?.body === 'string' && issue.body.trim() !== '' ? issue.body.trim() : NO_DESCRIPTION;

  const room = Math.max(0, PROMPT_MAX - head.length - tail.length);
  return `${head}${body.slice(0, room)}${tail}`.slice(0, PROMPT_MAX);
}
