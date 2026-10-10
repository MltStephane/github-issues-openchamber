# GitHub Issues for OpenChamber

GitHub Issues is a compact OpenChamber panel that lists the GitHub issues of the open project, hands one to an agent, and commits the fix with a closing keyword so GitHub closes the issue.

It relies on the GitHub CLI (`gh`) and `git` already installed and authenticated on the machine. A small local service runs them: the panel is a sandboxed iframe and cannot start a process.

## Install

1. Install and log in to the GitHub CLI: `gh auth login`.
2. In OpenChamber, open **Settings → Extensions** and add `https://github.com/MltStephane/github-issues-openchamber`. A git install follows new versions.
3. Approve the declared permissions (see below).
4. Open the **GitHub Issues** panel from the rail.

To work on it locally, clone the repository and add its folder instead. The built bundles are committed as `panel/main.js` and `service/main.js`; rebuild them with:

```bash
bun install
bun run build
```

## Use

- **Open / Closed** switches the issue state. **Refresh** reloads the list; it also reloads when the project changes.
- **Filter** narrows the list by title, `#number` or label, without a new request.
- **Click an issue title** (or press Enter on it) to open it on GitHub.
- **Implement** opens a menu:
  - **Implement in this session** sends a short prompt to the current session and links the issue to it.
  - **Implement in a new session** starts a session linked to the issue, with the same prompt.

  The prompt asks the agent to investigate, fix and verify, and **not** to commit.
- **Commit** opens an inline composer (no modal) for that issue:
  - the current branch and the changed files (`git status`);
  - **Subject**, prefilled with the issue title (72 characters max);
  - **Closing keyword**: `Closes`, `Fixes` or `Resolves`, with a preview of the footer, e.g. `Closes #12`;
  - **Comment**, optional. On a branch other than the default one it is prefilled with a note that the issue closes once the branch is merged. It is posted on the issue with the commit SHA. Leave it empty to skip.

  **Commit** runs `git add -A` and `git commit`. The message is:

  ```text
  <subject>

  Closes #12
  ```

  GitHub closes the issue when this commit reaches the default branch.

## Service routes

| Method | Route | What it does |
| --- | --- | --- |
| GET | `/health` | Host start-up probe |
| GET | `/issues?directory&state=open\|closed` | `gh issue list` (100 max) and `gh repo view` for the repo name and default branch |
| GET | `/changes?directory` | Current branch and `git status --porcelain=v1 -z` |
| POST | `/commit?directory` | `git add -A`, `git commit -F -`, then `gh issue comment --body-file -` when a comment is given |

| Status | Meaning |
| --- | --- |
| 400 | Invalid input, invalid directory, or not a Git repository |
| 409 | Nothing to commit |
| 422 | `git` refused (commit hook, missing identity…), with its output |
| 502 | `gh` failed (not a GitHub repository, not authenticated, issues disabled…), with its output |

A failed comment never undoes the commit: `/commit` answers 200 with `commentError` and the panel shows it.

## Permissions

| Declared | Why |
| --- | --- |
| `capabilities: ["prompt"]` | Send the Implement prompt to the current session |
| `capabilities: ["sessions"]` | Start a new session linked to the issue |
| `service.permissions.exec: ["gh", "git"]` | List issues, read changes, commit, comment |

No `sockets`, no `filesystem`, no integration.

The service binds `127.0.0.1`, requires the OpenChamber service bearer token on every request, and answers 401/404/405 the way the host expects. It runs `gh` and `git` with `execFile` — never a shell — with argument arrays, the validated project directory as `cwd`, a timeout (30 s, 120 s for `git commit` so hooks can run), an 8 MB output cap and interactive prompts disabled. The commit message and the comment go through stdin.

Like every OpenChamber service, this one is **not sandboxed at the OS level**: it runs with your user's rights, and `gh` uses your GitHub login.

## Caps

| Area | Cap |
| --- | --- |
| Issues listed | 100 per state |
| Issue body kept | 4,000 characters |
| Implement prompt | 16,000 characters |
| Changed files listed | 300 (all of them are still committed) |
| Issue comment | 8,000 characters |
| Request body | 64 KB |

## Development

```bash
bun run check
bun run build
```

- `src/*.js` is plain ESM JavaScript with no Node imports, covered by `node --test` (`tests/*.test.js`).
- `panel/main.ts` and `service/main.ts` are bundled by `openchamber-guest-bundle` into `panel/main.js` (browser IIFE, minified) and `service/main.js` (Node ESM, unminified).
- The panel is not covered by `node --test`; verify UI changes with a simulated host.
- When testing `/commit` for real, always send an empty comment so nothing is posted on GitHub.
