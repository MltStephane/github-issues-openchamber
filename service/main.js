// service/main.ts
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, resolve } from "node:path";

// src/changes.js
var CHANGES_MAX = 300;
function parsePorcelainZ(output) {
  const fields = typeof output === "string" ? output.split("\x00") : [];
  const files = [];
  let truncated = false;
  for (let index = 0;index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry.length < 4)
      continue;
    const status = entry.slice(0, 2);
    if (status[0] === "R" || status[0] === "C")
      index += 1;
    if (files.length >= CHANGES_MAX) {
      truncated = true;
      break;
    }
    files.push({ status, path: entry.slice(3) });
  }
  return { files, truncated };
}

// src/issue.js
var ISSUE_BODY_MAX = 4000;
function parseIssueNumber(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string" || !/^[0-9]+$/.test(value))
    return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
function normalizeIssue(raw) {
  if (!raw || typeof raw !== "object")
    return null;
  const number = parseIssueNumber(raw.number);
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (number === null || title === "")
    return null;
  return {
    number,
    title,
    url: typeof raw.url === "string" ? raw.url : "",
    author: typeof raw.author?.login === "string" ? raw.author.login : "",
    labels: labelNames(raw.labels),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    body: typeof raw.body === "string" ? raw.body.slice(0, ISSUE_BODY_MAX) : ""
  };
}
function labelNames(labels) {
  if (!Array.isArray(labels))
    return [];
  return labels.map((label) => typeof label === "string" ? label : label?.name).filter((name) => typeof name === "string" && name !== "");
}

// src/commit.js
var CLOSING_KEYWORDS = ["Closes", "Fixes", "Resolves"];
var COMMENT_MAX = 8000;
function buildCommitMessage({ subject, issueNumber, keyword } = {}) {
  const line = oneLine(subject);
  if (line === "")
    return { ok: false, value: "", error: "A commit subject is required." };
  if (!CLOSING_KEYWORDS.includes(keyword)) {
    return { ok: false, value: "", error: `The closing keyword must be one of ${CLOSING_KEYWORDS.join(", ")}.` };
  }
  const number = parseIssueNumber(issueNumber);
  if (number === null)
    return { ok: false, value: "", error: "A valid issue number is required." };
  return { ok: true, value: `${line}

${keyword} #${number}
`, error: "" };
}
function buildIssueComment({ text, sha } = {}) {
  const message = typeof text === "string" ? text.trim() : "";
  if (message === "")
    return "";
  const footer = `

Commit: ${typeof sha === "string" ? sha.trim() : ""}`;
  return `${message.slice(0, Math.max(0, COMMENT_MAX - footer.length))}${footer}`.slice(0, COMMENT_MAX);
}
function oneLine(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

// service/main.ts
var HOST = "127.0.0.1";
var MAX_BODY_BYTES = 64000;
var MAX_OUTPUT_BYTES = 8388608;
var COMMAND_TIMEOUT_MS = 30000;
var COMMIT_TIMEOUT_MS = 120000;
var ERROR_TEXT_MAX = 500;
var ISSUE_LIMIT = 100;
var ISSUE_FIELDS = "number,title,url,author,labels,updatedAt,body";
var ISSUE_STATES = ["open", "closed"];
var COMMAND_ENV = {
  ...process.env,
  GH_PROMPT_DISABLED: "1",
  GIT_TERMINAL_PROMPT: "0",
  NO_COLOR: "1",
  GH_NO_UPDATE_NOTIFIER: "1"
};
var port = Number.parseInt(process.env.OPENCHAMBER_SERVICE_PORT || "", 10);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN || "";
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error("OPENCHAMBER_SERVICE_PORT must be a valid TCP port.");
  process.exit(1);
}
if (!token) {
  console.error("OPENCHAMBER_SERVICE_TOKEN is required.");
  process.exit(1);
}
var server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error(`GitHub Issues request failed: ${error instanceof Error ? error.message : String(error)}`);
    if (response.headersSent || response.writableEnded)
      return;
    sendJson(response, 500, { ok: false, error: "The GitHub Issues service failed to answer." });
  });
});
server.listen(port, HOST, () => {
  console.info(`GitHub Issues service listening on ${HOST}:${port}`);
});
async function handleRequest(request, response) {
  if (!isAuthorized(request)) {
    sendJson(response, 401, { ok: false, error: "Unauthorized." });
    return;
  }
  const url = new URL(request.url || "/", `http://${HOST}`);
  const method = request.method || "GET";
  if (url.pathname === "/health") {
    if (method !== "GET")
      return methodNotAllowed(response);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (url.pathname === "/issues") {
    if (method !== "GET")
      return methodNotAllowed(response);
    await handleIssues(url, response);
    return;
  }
  if (url.pathname === "/changes") {
    if (method !== "GET")
      return methodNotAllowed(response);
    await handleChanges(url, response);
    return;
  }
  if (url.pathname === "/commit") {
    if (method !== "POST")
      return methodNotAllowed(response);
    await handleCommit(url, request, response);
    return;
  }
  sendJson(response, 404, { ok: false, error: "Not found." });
}
async function handleIssues(url, response) {
  const directory = await resolveDirectory(url);
  if (!directory.ok) {
    sendJson(response, 400, { ok: false, error: directory.error });
    return;
  }
  const state = url.searchParams.get("state") || "open";
  if (!ISSUE_STATES.includes(state)) {
    sendJson(response, 400, { ok: false, error: "The state must be open or closed." });
    return;
  }
  const cwd = directory.path;
  const [list, repo] = await Promise.all([
    run("gh", ["issue", "list", "--state", state, "--limit", String(ISSUE_LIMIT), "--json", ISSUE_FIELDS], { cwd }),
    run("gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"], { cwd })
  ]);
  const failed = list.code !== 0 ? list : repo.code !== 0 ? repo : null;
  if (failed) {
    sendJson(response, 502, { ok: false, error: commandError(failed, "GitHub CLI could not list the issues.") });
    return;
  }
  const rawIssues = parseJsonOutput(list.stdout);
  const rawRepo = asObject(parseJsonOutput(repo.stdout));
  const defaultBranchRef = asObject(rawRepo.defaultBranchRef);
  sendJson(response, 200, {
    ok: true,
    repo: typeof rawRepo.nameWithOwner === "string" ? rawRepo.nameWithOwner : "",
    defaultBranch: typeof defaultBranchRef.name === "string" ? defaultBranchRef.name : "",
    issues: (Array.isArray(rawIssues) ? rawIssues : []).map(normalizeIssue).filter(Boolean)
  });
}
async function handleChanges(url, response) {
  const directory = await resolveDirectory(url);
  if (!directory.ok) {
    sendJson(response, 400, { ok: false, error: directory.error });
    return;
  }
  const cwd = directory.path;
  const status = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
  if (status.code !== 0) {
    sendJson(response, 400, { ok: false, error: commandError(status, "This directory is not a Git repository.") });
    return;
  }
  const { files, truncated } = parsePorcelainZ(status.stdout);
  sendJson(response, 200, { ok: true, branch: await currentBranch(cwd), files, truncated });
}
async function handleCommit(url, request, response) {
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
    sendJson(response, 400, { ok: false, error: "A valid issue number is required." });
    return;
  }
  const message = buildCommitMessage({ subject: input.subject, issueNumber, keyword: input.keyword });
  if (!message.ok) {
    sendJson(response, 400, { ok: false, error: message.error });
    return;
  }
  const cwd = directory.path;
  const add = await run("git", ["add", "-A"], { cwd });
  if (add.code !== 0) {
    sendJson(response, 422, { ok: false, error: commandError(add, "git add failed.") });
    return;
  }
  const staged = await run("git", ["diff", "--cached", "--quiet"], { cwd });
  if (staged.code === 0) {
    sendJson(response, 409, { ok: false, error: "Nothing to commit." });
    return;
  }
  if (staged.code !== 1) {
    sendJson(response, 422, { ok: false, error: commandError(staged, "git could not read the staged changes.") });
    return;
  }
  const commit = await run("git", ["commit", "-F", "-"], { cwd, input: message.value, timeout: COMMIT_TIMEOUT_MS });
  if (commit.code !== 0) {
    sendJson(response, 422, { ok: false, error: commandError(commit, "git commit failed.") });
    return;
  }
  const head = await run("git", ["rev-parse", "HEAD"], { cwd });
  const sha = head.code === 0 ? head.stdout.trim() : "";
  const branch = await currentBranch(cwd);
  const comment = buildIssueComment({ text: input.comment, sha });
  if (comment === "") {
    sendJson(response, 200, { ok: true, sha, branch, commented: false });
    return;
  }
  const posted = await run("gh", ["issue", "comment", String(issueNumber), "--body-file", "-"], { cwd, input: comment });
  if (posted.code !== 0) {
    sendJson(response, 200, {
      ok: true,
      sha,
      branch,
      commented: false,
      commentError: commandError(posted, "GitHub CLI could not post the comment.")
    });
    return;
  }
  sendJson(response, 200, { ok: true, sha, branch, commented: true });
}
async function currentBranch(cwd) {
  const result = await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd });
  return result.code === 0 ? result.stdout.trim() : "";
}
async function resolveDirectory(url) {
  const directory = url.searchParams.get("directory") || "";
  if (directory.trim() === "")
    return { ok: false, error: "A non-empty absolute directory path is required." };
  if (directory.includes("\x00"))
    return { ok: false, error: "Directory path must not contain NUL bytes." };
  if (!isAbsolute(directory))
    return { ok: false, error: "Directory path must be absolute." };
  const path = resolve(directory);
  try {
    if (!(await stat(path)).isDirectory())
      return { ok: false, error: "Directory path is not a directory." };
  } catch {
    return { ok: false, error: "Directory path does not exist." };
  }
  return { ok: true, path };
}
function run(bin, args, { cwd, input, timeout = COMMAND_TIMEOUT_MS }) {
  return new Promise((resolveResult) => {
    const child = execFile(bin, args, { cwd, env: COMMAND_ENV, timeout, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resolveResult({ code: 0, stdout, stderr });
        return;
      }
      const code = error.code;
      if (code === "ENOENT") {
        resolveResult({ code: 127, stdout: "", stderr: `${bin} is not installed or not on PATH.` });
        return;
      }
      if (error.killed) {
        resolveResult({ code: -1, stdout, stderr: `${bin} ${args[0]} timed out.` });
        return;
      }
      resolveResult({ code: typeof code === "number" ? code : -1, stdout, stderr: stderr || error.message });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}
function commandError(result, fallback) {
  const text = (result.stderr.trim() || result.stdout.trim()).slice(0, ERROR_TEXT_MAX);
  return text || fallback;
}
function parseJsonOutput(text) {
  try {
    return JSON.parse(text || "null");
  } catch {
    return null;
  }
}
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES)
      return { ok: false, error: "Request body is too large." };
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "")
    return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: "Request body must be valid JSON." };
  }
}
function isAuthorized(request) {
  return request.headers.authorization === `Bearer ${token}`;
}
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function methodNotAllowed(response) {
  sendJson(response, 405, { ok: false, error: "Method not allowed." });
}
function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
