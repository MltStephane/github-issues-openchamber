import { connectHost } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountMenu,
  mountSearchField,
  mountSelect,
  mountTabs,
  mountTextField,
} from '@openchamber/sdk/ui';
import type { ButtonHandle, SelectHandle, TabsHandle, TextFieldHandle } from '@openchamber/sdk/ui';

import { buildCommitMessage, CLOSING_KEYWORDS, DEFAULT_CLOSING_KEYWORD, defaultCommitSubject, suggestIssueComment } from '../src/commit.js';
import { filterIssues } from '../src/issue.js';
import { buildImplementPrompt } from '../src/prompt.js';

/** Provider id the host records on chips and linked sessions. */
const PROVIDER_ID = 'github-issues';

const ISSUE_STATES = [
  { id: 'open', label: 'Open' },
  { id: 'closed', label: 'Closed' },
];

const IMPLEMENT_ITEMS = [
  { id: 'this-session', label: 'Implement in this session' },
  { id: 'new-session', label: 'Implement in a new session' },
];

type Issue = { number: number; title: string; url: string; author: string; labels: string[]; updatedAt: string; body: string };
type IssueList = { repo: string; defaultBranch: string; issues: Issue[] };
type ChangedFile = { status: string; path: string };
type Changes = { branch: string; files: ChangedFile[]; truncated: boolean };
type Composer = { issue: Issue; subject: string; keyword: string; comment: string; commentEdited: boolean };
type ReadyLike = { theme?: unknown; directory?: string | null };
type ServiceResult = { status: number; body: string };
type SentResult = { sent: 'sent' | 'no-model' | 'skipped' | 'failed' };
type StartedSession = SentResult & { sessionId: string | null };
type IssueLink = { providerId: string; id: string; title: string; url: string; kind?: 'issue'; author?: string };
type HostLike = {
  onReady?: (listener: (context: ReadyLike) => void) => unknown;
  onDirectory?: (listener: (directory: string | null) => void) => unknown;
  serviceRequest?: (request: { method: 'GET' | 'POST'; path: string; query?: Record<string, string>; body?: string }) => Promise<ServiceResult>;
  toast?: (request: { kind: 'info' | 'success' | 'error'; message: string }) => Promise<void> | void;
  openUrl?: (url: string) => Promise<void>;
  prompt?: (request: { text: string; send?: boolean }) => Promise<SentResult>;
  sessionLink?: (request: IssueLink) => Promise<void>;
  startSession?: (request: IssueLink & { text: string; navigation?: 'preserve' | 'open' }) => Promise<StartedSession>;
};

const state = {
  directory: '',
  issueState: 'open',
  query: '',
  list: null as IssueList | null,
  loading: false,
  status: '',
  statusBlocked: false,
  composer: null as Composer | null,
  changes: null as Changes | null,
  changesLoading: false,
  committing: false,
  implementing: false,
};

let host: HostLike | null = null;
// Only the latest issue request may paint: a slow answer for another tab or project is dropped.
let issuesRequest = 0;
let changesRequest = 0;
let repoEl: HTMLElement;
let composerEl: HTMLElement;
let composerHeading: HTMLElement;
let branchEl: HTMLElement;
let footerEl: HTMLElement;
let tabs: TabsHandle | null = null;
let subjectField: TextFieldHandle | null = null;
let keywordField: SelectHandle | null = null;
let commentField: TextFieldHandle | null = null;
let commitButton: ButtonHandle | null = null;
let filesBlock: Block;
let listBlock: Block;
let statusArea: Block;

/** A section that only repaints when its payload signature changes. */
class Block {
  root: HTMLElement;
  private disposers: Array<() => void> = [];
  private signature = '';

  constructor(parent: HTMLElement, className: string) {
    this.root = document.createElement('section');
    this.root.className = className;
    parent.append(this.root);
  }

  sync(signature: unknown, build: () => void) {
    const next = JSON.stringify(signature);
    if (next === this.signature) return;
    this.signature = next;
    this.clear();
    build();
  }

  track(handle: { dispose: () => void }) {
    this.disposers.push(() => handle.dispose());
  }

  clear() {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.root.replaceChildren();
  }
}

function boot() {
  injectStyles();
  const root = document.getElementById('app');
  if (!root) return;

  buildSkeleton(root);
  connectToHost();
  renderComposer();
  renderList();
  renderStatus();

  window.addEventListener('focus', () => {
    if (state.composer) void loadChanges();
  });
}

function buildSkeleton(root: HTMLElement) {
  root.replaceChildren();

  buildToolbar(root);
  buildComposer(root);
  listBlock = new Block(root, 'gi-list');
  statusArea = new Block(root, 'gi-status');
}

function buildToolbar(root: HTMLElement) {
  const toolbar = document.createElement('section');
  toolbar.className = 'gi-toolbar';

  const row = document.createElement('div');
  row.className = 'gi-toolbar-row';

  const tabsHolder = document.createElement('span');
  row.append(tabsHolder);
  tabs = mountTabs(tabsHolder, { items: ISSUE_STATES, activeId: state.issueState, onChange: changeIssueState });

  const refreshHolder = document.createElement('span');
  refreshHolder.className = 'gi-push';
  row.append(refreshHolder);
  mountButton(refreshHolder, { label: 'Refresh', variant: 'ghost', size: 'sm', onClick: () => void loadIssues() });

  toolbar.append(row);

  const searchHolder = document.createElement('div');
  toolbar.append(searchHolder);
  mountSearchField(searchHolder, {
    value: '',
    placeholder: 'Filter by title, #number or label',
    onChange: (value) => {
      state.query = value;
      renderList();
    },
  });

  repoEl = document.createElement('div');
  repoEl.className = 'gi-muted';
  toolbar.append(repoEl);

  root.append(toolbar);
}

function buildComposer(root: HTMLElement) {
  composerEl = document.createElement('section');
  composerEl.className = 'gi-card gi-composer';
  composerEl.hidden = true;

  composerHeading = document.createElement('h2');
  composerHeading.className = 'gi-heading';
  composerEl.append(composerHeading);

  branchEl = document.createElement('div');
  branchEl.className = 'gi-muted';
  composerEl.append(branchEl);

  filesBlock = new Block(composerEl, 'gi-files');

  const subjectHolder = document.createElement('div');
  composerEl.append(subjectHolder);
  subjectField = mountTextField(subjectHolder, {
    label: 'Subject',
    value: '',
    onChange: (value) => {
      if (state.composer) state.composer.subject = value;
    },
  });

  const keywordHolder = document.createElement('div');
  composerEl.append(keywordHolder);
  keywordField = mountSelect(keywordHolder, {
    label: 'Closing keyword',
    value: DEFAULT_CLOSING_KEYWORD,
    options: CLOSING_KEYWORDS.map((keyword) => ({ id: keyword, label: keyword })),
    onChange: (id) => {
      if (!state.composer) return;
      state.composer.keyword = id;
      renderFooter();
    },
  });

  footerEl = document.createElement('div');
  footerEl.className = 'gi-footer';
  composerEl.append(footerEl);

  const commentHolder = document.createElement('div');
  composerEl.append(commentHolder);
  commentField = mountTextField(commentHolder, {
    label: 'Comment',
    value: '',
    placeholder: 'Optional',
    multiline: true,
    rows: 3,
    helper: 'Posted on the issue with the commit SHA. Leave empty to skip.',
    onChange: (value) => {
      if (!state.composer) return;
      state.composer.comment = value;
      state.composer.commentEdited = true;
    },
  });

  const actions = document.createElement('div');
  actions.className = 'gi-form-actions';

  const commitHolder = document.createElement('span');
  actions.append(commitHolder);
  commitButton = mountButton(commitHolder, { label: 'Commit', size: 'sm', onClick: () => void commit() });

  const cancelHolder = document.createElement('span');
  actions.append(cancelHolder);
  mountButton(cancelHolder, { label: 'Cancel', variant: 'ghost', size: 'sm', onClick: closeComposer });

  composerEl.append(actions);
  root.append(composerEl);
}

function connectToHost() {
  try {
    host = connectHost() as HostLike;
  } catch (error) {
    setStatus(`OpenChamber host unavailable: ${getErrorMessage(error)}`, true);
    return;
  }

  try {
    // Ready can fire again (theme change, reconnect): repaint the theme, reload only on a new directory.
    host.onReady?.((context) => {
      applyTheme(context);
      applyDirectory(context?.directory || '');
    });
  } catch (error) {
    setStatus(`Host ready hook failed: ${getErrorMessage(error)}`);
  }

  try {
    host.onDirectory?.((directory) => applyDirectory(directory || ''));
  } catch (error) {
    setStatus(`Directory hook failed: ${getErrorMessage(error)}`);
  }
}

function applyTheme(context: ReadyLike) {
  if (!context || !('theme' in context)) return;
  try {
    applyHostReady(context as Parameters<typeof applyHostReady>[0], document.documentElement);
  } catch {
    document.documentElement.dataset.hostTheme = 'fallback';
  }
}

function applyDirectory(directory: string) {
  if (directory === state.directory) return;

  state.directory = directory;
  state.list = null;
  closeComposer();
  renderList();
  void loadIssues();
}

function changeIssueState(id: string) {
  if (id === state.issueState) return;

  state.issueState = id;
  tabs?.update({ activeId: id });
  state.list = null;
  renderList();
  void loadIssues();
}

async function loadIssues() {
  if (!state.directory) return;

  if (typeof host?.serviceRequest !== 'function') {
    setStatus('Authorize the GitHub Issues service in Settings → Extensions.', true);
    return;
  }

  const request = ++issuesRequest;
  state.loading = true;
  renderList();

  try {
    const result = await requestService('GET', '/issues', undefined, { state: state.issueState });
    if (request !== issuesRequest) return;
    const body = parseJson(result.body);

    if (!isOk(result)) {
      setStatus(getServiceError(body, result.status));
      return;
    }

    state.list = {
      repo: typeof body.repo === 'string' ? body.repo : '',
      defaultBranch: typeof body.defaultBranch === 'string' ? body.defaultBranch : '',
      issues: Array.isArray(body.issues) ? (body.issues as Issue[]) : [],
    };
    setStatus('');
  } catch (error) {
    if (request !== issuesRequest) return;
    // A network error must not erase what is already on screen.
    setStatus(getServiceRequestErrorMessage(error), isBlockedError(error));
  } finally {
    if (request === issuesRequest) {
      state.loading = false;
      renderList();
    }
  }
}

function renderList() {
  const list = state.list;
  repoEl.textContent = list?.repo || '';
  repoEl.hidden = !list?.repo;

  const issues = list ? filterIssues(list.issues, state.query) : [];

  listBlock.sync(
    {
      directory: state.directory,
      issueState: state.issueState,
      loaded: Boolean(list),
      total: list?.issues.length ?? 0,
      issues,
      activeNumber: state.composer?.issue.number ?? null,
      loading: state.loading,
    },
    () => {
      if (!state.directory) {
        listBlock.root.append(muted('Open a project to see its issues.'));
        return;
      }

      if (!list) {
        listBlock.root.append(muted(state.loading ? 'Loading the issues…' : 'No issues loaded yet.'));
        return;
      }

      if (list.issues.length === 0) {
        listBlock.root.append(muted(state.issueState === 'open' ? 'No open issues.' : 'No closed issues.'));
        return;
      }

      if (issues.length === 0) {
        listBlock.root.append(muted('No issue matches the filter.'));
        return;
      }

      for (const issue of issues) listBlock.root.append(issueRow(issue));
    },
  );
}

function issueRow(issue: Issue): HTMLElement {
  const row = document.createElement('article');
  row.className = 'gi-card gi-issue';
  if (state.composer?.issue.number === issue.number) row.classList.add('gi-issue-active');

  const number = document.createElement('span');
  number.className = 'gi-number';
  number.textContent = `#${issue.number}`;
  row.append(number);

  const main = document.createElement('div');
  main.className = 'gi-issue-main';

  const title = document.createElement('div');
  title.className = 'gi-issue-title';
  title.textContent = issue.title;
  title.tabIndex = 0;
  title.setAttribute('role', 'link');
  title.addEventListener('click', () => openIssue(issue));
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      openIssue(issue);
    }
  });
  main.append(title);

  const meta = document.createElement('div');
  meta.className = 'gi-meta';
  if (issue.author) {
    const author = document.createElement('span');
    author.textContent = issue.author;
    meta.append(author);
  }
  for (const label of issue.labels) {
    const badgeHolder = document.createElement('span');
    meta.append(badgeHolder);
    listBlock.track(mountBadge(badgeHolder, { label }));
  }
  main.append(meta);

  const actions = document.createElement('div');
  actions.className = 'gi-issue-actions';

  const menuHolder = document.createElement('span');
  actions.append(menuHolder);
  listBlock.track(
    mountMenu(menuHolder, {
      label: 'Implement',
      size: 'xs',
      items: IMPLEMENT_ITEMS,
      onSelect: (id) => void implement(issue, id),
    }),
  );

  const commitHolder = document.createElement('span');
  actions.append(commitHolder);
  listBlock.track(mountButton(commitHolder, { label: 'Commit', variant: 'secondary', size: 'xs', onClick: () => openComposer(issue) }));

  main.append(actions);
  row.append(main);
  return row;
}

function openIssue(issue: Issue) {
  if (!issue.url) return;
  host?.openUrl?.(issue.url)?.catch((error: unknown) => setStatus(getErrorMessage(error)));
}

async function implement(issue: Issue, mode: string) {
  if (state.implementing) return;
  state.implementing = true;

  try {
    if (mode === 'new-session') await implementInNewSession(issue);
    else await implementInThisSession(issue);
  } catch (error) {
    setStatus(getSessionErrorMessage(error));
  } finally {
    state.implementing = false;
  }
}

async function implementInThisSession(issue: Issue) {
  if (typeof host?.prompt !== 'function') throw new Error('NOT_GRANTED');

  const result = await host.prompt({ text: buildImplementPrompt(issue), send: true });

  try {
    await host.sessionLink?.(issueLink(issue, issue.title));
  } catch {
    // Linking is a nicety: the prompt already reached the session.
  }

  if (result.sent === 'sent') toast(`Prompt sent for #${issue.number}`);
  else if (result.sent === 'no-model') toast('No model selected', 'error');
  else if (result.sent === 'failed') toast(`The prompt for #${issue.number} could not be sent.`, 'error');
  else toast(`Prompt ready for #${issue.number}`, 'info');
  setStatus('');
}

async function implementInNewSession(issue: Issue) {
  if (typeof host?.startSession !== 'function') throw new Error('NOT_GRANTED');

  const result = await host.startSession({
    ...issueLink(issue, `#${issue.number} ${issue.title}`),
    text: buildImplementPrompt(issue),
    navigation: 'open',
  });

  if (result.sessionId === null) {
    toast(`The session for #${issue.number} could not be started.`, 'error');
    return;
  }

  if (result.sent === 'no-model') toast(`Session started for #${issue.number}, but no model is selected.`, 'error');
  else if (result.sent === 'failed') toast(`Session started for #${issue.number}, but the prompt could not be sent.`, 'error');
  else toast(`Session started for #${issue.number}`);
  setStatus('');
}

function issueLink(issue: Issue, title: string): IssueLink {
  const link: IssueLink = { providerId: PROVIDER_ID, id: `#${issue.number}`, title, url: issue.url, kind: 'issue' };
  if (issue.author) link.author = issue.author;
  return link;
}

function openComposer(issue: Issue) {
  state.composer = {
    issue,
    subject: defaultCommitSubject(issue),
    keyword: DEFAULT_CLOSING_KEYWORD,
    comment: '',
    commentEdited: false,
  };
  state.changes = null;
  renderComposer();
  renderList();
  void loadChanges();
}

function closeComposer() {
  state.composer = null;
  state.changes = null;
  changesRequest += 1;
  state.changesLoading = false;
  renderComposer();
  renderList();
}

function renderComposer() {
  const composer = state.composer;
  composerEl.hidden = !composer;
  if (!composer) return;

  composerHeading.textContent = `Commit for #${composer.issue.number}`;
  subjectField?.update({ value: composer.subject, error: '' });
  keywordField?.update({ value: composer.keyword });
  commentField?.update({ value: composer.comment });
  renderFooter();
  renderChanges();
}

function renderFooter() {
  const composer = state.composer;
  footerEl.textContent = composer ? `${composer.keyword} #${composer.issue.number}` : '';
}

async function loadChanges() {
  if (!state.composer || !state.directory) return;

  const request = ++changesRequest;
  state.changesLoading = true;
  renderChanges();

  try {
    const result = await requestService('GET', '/changes');
    if (request !== changesRequest) return;
    const body = parseJson(result.body);

    if (!isOk(result)) {
      setStatus(getServiceError(body, result.status));
      return;
    }

    state.changes = {
      branch: typeof body.branch === 'string' ? body.branch : '',
      files: Array.isArray(body.files) ? (body.files as ChangedFile[]) : [],
      truncated: Boolean(body.truncated),
    };

    // Suggest the comment once the branch is known, unless the user already wrote one.
    const composer = state.composer;
    if (composer && !composer.commentEdited) {
      composer.comment = suggestIssueComment({ branch: state.changes.branch, defaultBranch: state.list?.defaultBranch || '' });
      commentField?.update({ value: composer.comment });
    }
  } catch (error) {
    if (request !== changesRequest) return;
    setStatus(getServiceRequestErrorMessage(error), isBlockedError(error));
  } finally {
    if (request === changesRequest) {
      state.changesLoading = false;
      renderChanges();
    }
  }
}

function renderChanges() {
  const changes = state.changes;
  branchEl.textContent = changes?.branch ? `Branch: ${changes.branch}` : '';
  branchEl.hidden = !changes?.branch;
  renderCommitButton();

  filesBlock.sync({ changes, loading: state.changesLoading }, () => {
    if (!changes) {
      filesBlock.root.append(muted(state.changesLoading ? 'Reading the changes…' : 'Changes not loaded.'));
      return;
    }

    if (changes.files.length === 0) {
      filesBlock.root.append(muted('No changes to commit'));
      return;
    }

    const list = document.createElement('ul');
    list.className = 'gi-file-list';
    for (const file of changes.files) {
      const item = document.createElement('li');
      const status = document.createElement('span');
      status.className = 'gi-file-status';
      status.textContent = file.status;
      item.append(status, document.createTextNode(file.path));
      list.append(item);
    }
    filesBlock.root.append(list);

    if (changes.truncated) filesBlock.root.append(muted('More files changed than listed here; all of them are committed.'));
  });
}

function renderCommitButton() {
  const hasFiles = Boolean(state.changes && state.changes.files.length > 0);
  commitButton?.update({ disabled: state.committing || state.changesLoading || !hasFiles, loading: state.committing });
}

async function commit() {
  const composer = state.composer;
  if (!composer || state.committing) return;

  const message = buildCommitMessage({ subject: composer.subject, issueNumber: composer.issue.number, keyword: composer.keyword });
  if (!message.ok) {
    subjectField?.update({ error: message.error });
    return;
  }
  subjectField?.update({ error: '' });

  const number = composer.issue.number;
  state.committing = true;
  renderCommitButton();

  try {
    const result = await requestService(
      'POST',
      '/commit',
      JSON.stringify({ issue: number, subject: composer.subject, keyword: composer.keyword, comment: composer.comment }),
    );
    const body = parseJson(result.body);

    if (!isOk(result)) {
      setStatus(getServiceError(body, result.status));
      return;
    }

    const sha = typeof body.sha === 'string' ? body.sha.slice(0, 7) : '';
    toast(body.commented === true ? `Committed ${sha} and commented on #${number}` : `Committed ${sha}`);
    setStatus(typeof body.commentError === 'string' ? `Committed, but the comment failed: ${body.commentError}` : '');
    closeComposer();
  } catch (error) {
    setStatus(getServiceRequestErrorMessage(error), isBlockedError(error));
  } finally {
    state.committing = false;
    renderCommitButton();
  }
}

/** Forwards a call to this guest's local service, with the project directory attached. */
function requestService(method: 'GET' | 'POST', path: string, body?: string, extraQuery?: Record<string, string>): Promise<ServiceResult> {
  const query: Record<string, string> = { directory: state.directory };
  if (extraQuery) Object.assign(query, extraQuery);

  if (typeof host?.serviceRequest !== 'function') throw new Error('NO_SERVICE');
  return host.serviceRequest({ method, path, query, body });
}

function renderStatus() {
  const status = state.status;
  const blocked = state.statusBlocked;
  statusArea.root.hidden = status === '';

  statusArea.sync({ status, blocked }, () => {
    if (status === '') return;

    if (blocked) {
      statusArea.track(
        mountBanner(statusArea.root, { tone: 'error', title: status, action: { label: 'Retry', onClick: () => void loadIssues() } }),
      );
      return;
    }

    statusArea.root.append(muted(status));
  });
}

function setStatus(message: string, blocked = false) {
  if (state.status === message && state.statusBlocked === blocked) return;
  state.status = message;
  state.statusBlocked = blocked;
  renderStatus();
}

function toast(message: string, kind: 'info' | 'success' | 'error' = 'success') {
  try {
    void host?.toast?.({ kind, message });
  } catch {
    // A toast is a nicety; never let it break the flow.
  }
}

function isOk(result: ServiceResult) {
  return result.status >= 200 && result.status < 300;
}

function getServiceError(payload: { error?: unknown } | null, status: number) {
  if (payload && typeof payload.error === 'string' && payload.error.trim() !== '') return payload.error;
  return `The GitHub Issues service returned HTTP ${status}.`;
}

function getServiceRequestErrorMessage(error: unknown) {
  const code = getHostErrorCode(error);
  const message = getErrorMessage(error);

  if (hasCode(code, message, 'NO_SERVICE') || hasCode(code, message, 'NOT_GRANTED')) {
    return 'Authorize the GitHub Issues service in Settings → Extensions.';
  }
  if (hasCode(code, message, 'SERVICE_FAILED')) return 'The GitHub Issues service failed to start.';
  if (hasCode(code, message, 'NO_DIRECTORY')) return 'Open a project folder first.';
  // The host stops waiting before a slow commit hook ends; the command itself keeps running.
  if (hasCode(code, message, 'HOST_TIMEOUT')) return 'OpenChamber stopped waiting for the service. The command may still finish: check Git before retrying.';

  return message;
}

function getSessionErrorMessage(error: unknown) {
  const code = getHostErrorCode(error);
  const message = getErrorMessage(error);

  if (hasCode(code, message, 'NO_SESSION')) return 'Open a session first, or use Implement in a new session.';
  if (hasCode(code, message, 'SESSION_BUSY')) return 'The session is busy. Wait for it to finish.';
  if (hasCode(code, message, 'NOT_GRANTED')) return 'Approve the extension permissions in Settings → Extensions.';

  return message;
}

function isBlockedError(error: unknown) {
  const code = getHostErrorCode(error);
  const message = getErrorMessage(error);
  return ['NO_SERVICE', 'NOT_GRANTED', 'SERVICE_FAILED'].some((name) => hasCode(code, message, name));
}

function hasCode(code: string, message: string, name: string) {
  return code === name || message.includes(name);
}

function getHostErrorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(body: string) {
  try {
    return JSON.parse(body || '{}') as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

function muted(text: string) {
  const node = document.createElement('div');
  node.className = 'gi-muted';
  node.textContent = text;
  return node;
}

function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { background: transparent; }
    body { margin: 0; font-family: var(--oc-font, ui-sans-serif, system-ui, sans-serif); color: var(--oc-fg, inherit); }

    #app { display: flex; flex-direction: column; gap: 0.55rem; padding: 0.65rem; }

    .gi-card {
      background: var(--oc-elevated, var(--oc-bg, rgba(127, 127, 127, 0.08)));
      border: 1px solid var(--oc-border, rgba(127, 127, 127, 0.22));
      border-radius: var(--oc-radius, 0.65rem);
      min-width: 0;
    }

    .gi-heading {
      color: var(--oc-muted);
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 0.06em;
      margin: 0 0 0.35rem;
      text-transform: uppercase;
    }

    .gi-toolbar { display: flex; flex-direction: column; gap: 0.4rem; }
    .gi-toolbar-row { align-items: center; display: flex; gap: 0.4rem; }
    .gi-toolbar-row > span, .gi-form-actions span, .gi-issue-actions span { display: inline-flex; }
    .gi-push { margin-left: auto; }
    .gi-form-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 0.4rem; }

    .gi-composer { display: flex; flex-direction: column; gap: 0.45rem; padding: 0.55rem; }
    .gi-composer[hidden], .gi-status[hidden], .gi-muted[hidden] { display: none; }

    .gi-file-list {
      border: 1px solid var(--oc-border, rgba(127, 127, 127, 0.22));
      border-radius: var(--oc-radius, 0.65rem);
      font-family: var(--oc-mono, ui-monospace, monospace);
      font-size: 0.74rem;
      list-style: none;
      margin: 0;
      max-height: 9rem;
      overflow: auto;
      padding: 0.35rem 0.45rem;
    }
    .gi-file-list li { white-space: pre; }
    .gi-file-status { color: var(--oc-muted); display: inline-block; margin-right: 0.5rem; white-space: pre; }
    .gi-footer { color: var(--oc-muted); font-family: var(--oc-mono, ui-monospace, monospace); font-size: 0.76rem; }

    .gi-list { display: flex; flex-direction: column; gap: 0.35rem; }
    .gi-issue { display: flex; gap: 0.5rem; padding: 0.45rem 0.5rem; transition: border-color 120ms ease; }
    .gi-issue:hover { border-color: var(--oc-hover, var(--oc-border)); }
    .gi-issue-active { border-color: var(--oc-primary); }
    .gi-number { color: var(--oc-muted); font-family: var(--oc-mono, ui-monospace, monospace); font-size: 0.76rem; line-height: 1.35; }
    .gi-issue-main { display: flex; flex: 1 1 auto; flex-direction: column; gap: 0.25rem; min-width: 0; }
    .gi-issue-title { color: var(--oc-fg); cursor: pointer; font-size: 0.82rem; line-height: 1.3; word-break: break-word; }
    .gi-issue-title:hover { color: var(--oc-primary, inherit); }
    .gi-issue-title:focus-visible { outline: 2px solid var(--oc-focus, var(--oc-primary)); outline-offset: 1px; }
    .gi-meta { align-items: center; color: var(--oc-muted); display: flex; flex-wrap: wrap; font-size: 0.72rem; gap: 0.3rem; }
    .gi-issue-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 0.3rem; }

    .gi-status { display: flex; flex-direction: column; gap: 0.3rem; }
    .gi-muted { color: var(--oc-muted); font-size: 0.78rem; }
  `;
  document.head.append(style);
}

boot();
