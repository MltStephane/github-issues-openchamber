/** Working tree changes read from Git. Pure ESM, no Node import. */

/** Most changed files the panel lists; a bigger change set is reported as `truncated`. */
export const CHANGES_MAX = 300;

/**
 * Parses `git status --porcelain=v1 -z`.
 *
 * Each entry is `XY path`, NUL-terminated. A rename or copy (`R`/`C` in the
 * index column) is followed by one more NUL-separated field: the original
 * path, which is consumed and not listed.
 *
 * Returns `{ files: [{ status, path }], truncated }`.
 */
export function parsePorcelainZ(output) {
  const fields = typeof output === 'string' ? output.split('\0') : [];
  const files = [];
  let truncated = false;

  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry.length < 4) continue;

    const status = entry.slice(0, 2);
    if (status[0] === 'R' || status[0] === 'C') index += 1;

    if (files.length >= CHANGES_MAX) {
      truncated = true;
      break;
    }

    files.push({ status, path: entry.slice(3) });
  }

  return { files, truncated };
}
