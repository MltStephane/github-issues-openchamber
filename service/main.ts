import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';

import { parsePorcelainZ } from '../src/changes.js';
import { buildCommitMessage, buildIssueComment } from '../src/commit.js';
import { normalizeIssue, parseIssueNumber } from '../src/issue.js';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64_000;
const MAX_OUTPUT_BYTES = 8_388_608;
const COMMAND_TIMEOUT_MS = 30_000;
// Commit hooks (lint, tests) may run inside `git commit`.
const COMMIT_TIMEOUT_MS = 120_000;
const ERROR_TEXT_MAX = 500;
const ISSUE_LIMIT = 100;
const ISSUE_FIELDS = 'number,title,url,author,labels,updatedAt,body';
const ISSUE_STATES = ['open', 'closed'];

// No interactive prompt may ever wait for a terminal nobody is looking at.
const COMMAND_ENV = {
  ...process.env,
  GH_PROMPT_DISABLED: '1',
  GIT_TERMINAL_PROMPT: '0',
  NO_COLOR: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
};

const port = Number.parseInt(process.env.OPENCHAMBER_SERVICE_PORT || '', 10);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN || '';

if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  console.error('OPENCHAMBER_SERVICE_PORT must be a valid TCP port.');
  process.exit(1);
}

if (!token) {
  console.error('OPENCHAMBER_SERVICE_TOKEN is required.');
  process.exit(1);
}

const server = createServer((request, response) => {
  // A request must never take the service down: answer a clean 500 instead.
  handleRequest(request, response).catch((error: unknown) => {
    console.error(`GitHub Issues request failed: ${error instanceof Error ? error.message : String(error)}`);
    if (response.headersSent || response.writableEnded) return;
    sendJson(response, 500, { ok: false, error: 'The GitHub Issues service failed to answer.' });
  });
});

server.listen(port, HOST, () => {
  console.info(`GitHub Issues service listening on ${HOST}:${port}`);
});

async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  if (!isAuthorized(request)) {
    sendJson(response, 401, { ok: false, error: 'Unauthorized.' });
    return;
  }

  const url = new URL(request.url || '/', `http://${HOST}`);
  const method = request.method || 'GET';

  if (url.pathname === '/health') {
    if (method !== 'GET') return methodNotAllowed(response);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname === '/issues') {
    if (method !== 'GET') return methodNotAllowed(response);
    await handleIssues(url, response);
    return;
  }

  if (url.pathname === '/changes') {
    if (method !== 'GET') return methodNotAllowed(response);
    await handleChanges(url, response);
    return;
  }

  if (url.pathname === '/commit') {
    if (method !== 'POST') return methodNotAllowed(response);
    await handleCommit(url, request, response);
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

async function handleIssues(url: URL, response: ServerResponse) {
  const directory = await resolveDirectory(url);
  if (!directory.ok) {
    sendJson(response, 400, { ok: false, error: directory.error });
    return;
  }

  const state = url.searchParams.get('state') || 'open';
  if (!ISSUE_STATES.includes(state)) {
    sendJson(response, 400, { ok: false, error: 'The state must be open or closed.' });
    return;
  }

  const cwd = directory.path;
  const [list, repo] = await Promise.all([
    run('gh', ['issue', 'list', '--state', state, '--limit', String(ISSUE_LIMIT), '--json', ISSUE_FIELDS], { cwd }),
    run('gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], { cwd }),
  ]);

  const failed = list.code !== 0 ? list : repo.code !== 0 ? repo : null;
  if (failed) {
    sendJson(response, 502, { ok: false, error: commandError(failed, 'GitHub CLI could not list the issues.') });
    return;
  }

  const rawIssues = parseJsonOutput(list.stdout);
  const rawRepo = asObject(parseJsonOutput(repo.stdout));
  const defaultBranchRef = asObject(rawRepo.defaultBranchRef);

  sendJson(response, 200, {
    ok: true,
    repo: typeof rawRepo.nameWithOwner === 'string' ? rawRepo.nameWithOwner : '',
    defaultBranch: typeof defaultBranchRef.name === 'string' ? defaultBranchRef.name : '',
    issues: (Array.isArray(rawIssues) ? rawIssues : []).map(normalizeIssue).filter(Boolean),
  });
}

async function handleChanges(url: URL, response: ServerResponse) {
  const directory = await resolveDirectory(url);
  if (!directory.ok) {
    sendJson(response, 400, { ok: false, error: directory.error });
    return;
  }

  const cwd = directory.path;
  const status = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd });
  if (status.code !== 0) {
    sendJson(response, 400, { ok: false, error: commandError(status, 'This directory is not a Git repository.') });
    return;
  }

  const { files, truncated } = parsePorcelainZ(status.stdout);
  sendJson(response, 200, { ok: true, branch: await currentBranch(cwd), files, truncated });
}

async function handleCommit(url: URL, request: IncomingMessage, response: ServerResponse) {
  const directory = await resolveDirectory(url);
  if (!directory.ok) {
    sendJson(response, 400, { ok: false, error: directory.error });
    return;
  }

  const body = await readJsonBody(request);
  if (!body.ok) {
    sendJson(response, 400, { ok: false, error: body.error });
    return;
  }

  const input = asObject(body.value);
  const issueNumber = parseIssueNumber(input.issue);
  if (issueNumber === null) {
    sendJson(response, 400, { ok: false, error: 'A valid issue number is required.' });
    return;
  }

  const message = buildCommitMessage({ subject: input.subject, issueNumber, keyword: input.keyword });
  if (!message.ok) {
    sendJson(response, 400, { ok: false, error: message.error });
    return;
  }

  const cwd = directory.path;

  const add = await run('git', ['add', '-A'], { cwd });
  if (add.code !== 0) {
    sendJson(response, 422, { ok: false, error: commandError(add, 'git add failed.') });
    return;
  }

  // `--quiet` exits 0 when the index matches HEAD, 1 when something is staged.
  const staged = await run('git', ['diff', '--cached', '--quiet'], { cwd });
  if (staged.code === 0) {
    sendJson(response, 409, { ok: false, error: 'Nothing to commit.' });
    return;
  }
  if (staged.code !== 1) {
    sendJson(response, 422, { ok: false, error: commandError(staged, 'git could not read the staged changes.') });
    return;
  }

  const commit = await run('git', ['commit', '-F', '-'], { cwd, input: message.value, timeout: COMMIT_TIMEOUT_MS });
  if (commit.code !== 0) {
    sendJson(response, 422, { ok: false, error: commandError(commit, 'git commit failed.') });
    return;
  }

  const head = await run('git', ['rev-parse', 'HEAD'], { cwd });
  const sha = head.code === 0 ? head.stdout.trim() : '';
  const branch = await currentBranch(cwd);

  // The commit is the work that matters: a failed comment is reported, never undone.
  const comment = buildIssueComment({ text: input.comment, sha });
  if (comment === '') {
    sendJson(response, 200, { ok: true, sha, branch, commented: false });
    return;
  }

  const posted = await run('gh', ['issue', 'comment', String(issueNumber), '--body-file', '-'], { cwd, input: comment });
  if (posted.code !== 0) {
    sendJson(response, 200, {
      ok: true,
      sha,
      branch,
      commented: false,
      commentError: commandError(posted, 'GitHub CLI could not post the comment.'),
    });
    return;
  }

  sendJson(response, 200, { ok: true, sha, branch, commented: true });
}

/** Branch name, also on a repository with no commit yet; `''` on a detached HEAD. */
async function currentBranch(cwd: string) {
  const result = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  return result.code === 0 ? result.stdout.trim() : '';
}

type DirectoryRead = { ok: true; path: string } | { ok: false; error: string };

/** Resolves the project directory sent by the panel; it must be an existing absolute directory. */
async function resolveDirectory(url: URL): Promise<DirectoryRead> {
  const directory = url.searchParams.get('directory') || '';

  if (directory.trim() === '') return { ok: false, error: 'A non-empty absolute directory path is required.' };
  if (directory.includes('\0')) return { ok: false, error: 'Directory path must not contain NUL bytes.' };
  if (!isAbsolute(directory)) return { ok: false, error: 'Directory path must be absolute.' };

  const path = resolve(directory);
  try {
    if (!(await stat(path)).isDirectory()) return { ok: false, error: 'Directory path is not a directory.' };
  } catch {
    return { ok: false, error: 'Directory path does not exist.' };
  }

  return { ok: true, path };
}

type CommandResult = { code: number; stdout: string; stderr: string };
type RunOptions = { cwd: string; input?: string; timeout?: number };

/**
 * Runs a binary without a shell. A non-zero exit is a result, not a throw;
 * a missing binary or a timeout is reported the same way, with a readable stderr.
 */
function run(bin: string, args: string[], { cwd, input, timeout = COMMAND_TIMEOUT_MS }: RunOptions): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = execFile(
      bin,
      args,
      { cwd, env: COMMAND_ENV, timeout, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolveResult({ code: 0, stdout, stderr });
          return;
        }

        const code = (error as { code?: unknown }).code;
        if (code === 'ENOENT') {
          resolveResult({ code: 127, stdout: '', stderr: `${bin} is not installed or not on PATH.` });
          return;
        }
        if ((error as { killed?: boolean }).killed) {
          resolveResult({ code: -1, stdout, stderr: `${bin} ${args[0]} timed out.` });
          return;
        }

        resolveResult({ code: typeof code === 'number' ? code : -1, stdout, stderr: stderr || error.message });
      },
    );

    // Without input, close stdin at once so no command waits on it.
    child.stdin?.on('error', () => {
      // The process may exit before reading stdin; the exit result tells the story.
    });
    child.stdin?.end(input ?? '');
  });
}

/** The command's own words, trimmed, or a fallback when it said nothing. */
function commandError(result: CommandResult, fallback: string) {
  const text = (result.stderr.trim() || result.stdout.trim()).slice(0, ERROR_TEXT_MAX);
  return text || fallback;
}

function parseJsonOutput(text: string): unknown {
  try {
    return JSON.parse(text || 'null');
  } catch {
    return null;
  }
}

type BodyRead = { ok: true; value: unknown } | { ok: false; error: string };

async function readJsonBody(request: IncomingMessage): Promise<BodyRead> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return { ok: false, error: 'Request body is too large.' };
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'Request body must be valid JSON.' };
  }
}

function isAuthorized(request: IncomingMessage) {
  return request.headers.authorization === `Bearer ${token}`;
}

function asObject(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function methodNotAllowed(response: ServerResponse) {
  sendJson(response, 405, { ok: false, error: 'Method not allowed.' });
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
