// rest.ts — GitHub REST v3 under /api/v3. Repositories, branches, commits, contents, labels, issues,
// comments and pull requests over the same in-memory store every other surface shares. Auth and the
// X-GitHub-Request-Id header are app.ts's; this module only routes, validates and mutates.

import {
  buildCommit,
  buildTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTree,
} from './git.ts';
import {
  createRepo,
  deleteRepo,
  getRepo,
  headOid,
  lookupObject,
  nextCommentId,
  nextIssueNumber,
  nextPullNumber,
  putObject,
  reposForOwner,
  FIXED_TIME,
  type Repo,
  type Pull,
} from './store.ts';
import { VIEWER_LOGIN, b64decode, b64encode, errorReply, jsonReply, type Reply } from './shared.ts';

const SHA40 = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: repo.id },
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed' };
}

function issueJson(repo: Repo, issue: { number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[] }): Record<string, unknown> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body };
}

function pullJson(repo: Repo, pull: { number: number; title: string; body: string; head: string; base: string; state: 'open' | 'closed'; merged: boolean; mergeCommitSha: string | null }): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? ZERO_HEAD;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? ZERO_HEAD;
  const out: Record<string, unknown> = {
    id: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: headSha },
    base: { ref: pull.base, sha: baseSha },
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
  };
  if (pull.merged) out.merged_at = FIXED_TIME;
  return out;
}

const ZERO_HEAD = '0'.repeat(40);

// ---------------------------------------------------------------------------------------------
// git tree helpers (the contents endpoints build commits over these)
// ---------------------------------------------------------------------------------------------

export function treeEntries(repo: Repo, treeOid: string): Array<{ mode: string; name: string; oid: string }> {
  const object = lookupObject(repo, treeOid);
  if (object && object.type === 'tree') return parseTree(object.data);
  return [];
}

function writeTree(repo: Repo, entries: Array<{ mode: string; name: string; oid: string }>): string {
  const data = buildTree(entries);
  const oid = hashObject('tree', data);
  putObject(repo, oid, { type: 'tree', data });
  return oid;
}

/** The current tree of a branch, or the empty tree when the branch does not exist yet. */
function branchTree(repo: Repo, branch: string): string {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip) {
    const commit = lookupObject(repo, tip);
    if (commit && commit.type === 'commit') return parseCommit(commit.data).tree;
  }
  return writeTree(repo, []);
}

/** Insert or replace `blobOid` at `segments` below `treeOid`, building intermediate trees. */
function setPath(repo: Repo, treeOid: string, segments: string[], blobOid: string): string {
  const entries = treeEntries(repo, treeOid);
  const head = segments[0];
  const rest = segments.slice(1);
  const index = entries.findIndex((entry) => entry.name === head);
  if (rest.length === 0) {
    if (index >= 0) entries[index] = { mode: '100644', name: head, oid: blobOid };
    else entries.push({ mode: '100644', name: head, oid: blobOid });
  } else {
    let subtreeOid = index >= 0 && entries[index].mode === '40000' ? entries[index].oid : writeTree(repo, []);
    const next = setPath(repo, subtreeOid, rest, blobOid);
    if (index >= 0) entries[index] = { mode: '40000', name: head, oid: next };
    else entries.push({ mode: '40000', name: head, oid: next });
  }
  return writeTree(repo, entries);
}

/** Remove the entry at `segments`; returns the new tree id or null when the path is absent. */
function deletePath(repo: Repo, treeOid: string, segments: string[]): string | null {
  const entries = treeEntries(repo, treeOid);
  const head = segments[0];
  const rest = segments.slice(1);
  const index = entries.findIndex((entry) => entry.name === head);
  if (index < 0) return null;
  if (rest.length === 0) {
    entries.splice(index, 1);
    return writeTree(repo, entries);
  }
  if (entries[index].mode !== '40000') return null;
  const next = deletePath(repo, entries[index].oid, rest);
  if (next === null) return null;
  entries[index] = { mode: '40000', name: head, oid: next };
  return writeTree(repo, entries);
}

/** Read the entry at `segments` below `treeOid`. */
function readPath(repo: Repo, treeOid: string, segments: string[]): { type: 'blob' | 'tree'; oid: string } | null {
  let oid = treeOid;
  let mode = '40000';
  for (const segment of segments) {
    const object = lookupObject(repo, oid);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (!entry) return null;
    oid = entry.oid;
    mode = entry.mode;
  }
  const object = lookupObject(repo, oid);
  if (!object) return null;
  return { type: object.type === 'tree' ? 'tree' : 'blob', oid };
}

/** Commit a tree on a branch, returning the new commit id. */
function commitTree(repo: Repo, branch: string, treeOid: string, message: string): string {
  const parent = repo.refs.get(`refs/heads/${branch}`);
  const commit = buildCommit({ tree: treeOid, parents: parent ? [parent] : [], message });
  const oid = hashObject('commit', commit);
  putObject(repo, oid, { type: 'commit', data: commit });
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}

/** Commits reachable from a tip, newest first. */
function commitList(repo: Repo, tip: string): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookupObject(repo, oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message });
    for (const parent of commit.parents) stack.push(parent);
  }
  return out;
}

/** The files a head branch changes relative to its base (for the pulls files view). */
export function diffTrees(
  repo: Repo,
  baseOid: string,
  headOid: string,
  prefix: string,
  out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>,
): void {
  const baseEntries = treeEntries(repo, baseOid);
  const headEntries = treeEntries(repo, headOid);
  const baseNames = new Map(baseEntries.map((entry) => [entry.name, entry]));
  const headNames = new Map(headEntries.map((entry) => [entry.name, entry]));
  const names = new Set([...baseNames.keys(), ...headNames.keys()]);
  for (const name of [...names].sort()) {
    const base = baseNames.get(name);
    const head = headNames.get(name);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const baseIsDir = base?.mode === '40000';
    const headIsDir = head?.mode === '40000';
    if (baseIsDir && headIsDir) {
      diffTrees(repo, base!.oid, head!.oid, path, out);
      continue;
    }
    if (base === undefined) {
      const additions = blobLineCount(repo, head!.oid);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (head === undefined) {
      const deletions = blobLineCount(repo, base.oid);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (base.oid !== head.oid) {
      const oldLines = blobLines(repo, base.oid);
      const newLines = blobLines(repo, head.oid);
      const oldSet = new Set(oldLines);
      const additions = newLines.filter((line) => !oldSet.has(line)).length;
      const newSet = new Set(newLines);
      const deletions = oldLines.filter((line) => !newSet.has(line)).length;
      const safeAdditions = Math.max(1, additions);
      const safeDeletions = Math.max(1, deletions);
      out.push({ filename: path, status: 'modified', additions: safeAdditions, deletions: safeDeletions, changes: safeAdditions + safeDeletions });
    }
  }
}

function blobLines(repo: Repo, oid: string): string[] {
  const object = lookupObject(repo, oid);
  if (!object || object.type !== 'blob') return [];
  return object.data.toString('utf8').split('\n');
}

function blobLineCount(repo: Repo, oid: string): number {
  const lines = blobLines(repo, oid);
  return Math.max(1, lines.length);
}

// ---------------------------------------------------------------------------------------------
// route dispatch
// ---------------------------------------------------------------------------------------------

/** The changed file paths of `headTip` relative to `baseTip` (used by GraphQL's pullRequest.files). */
export function changedPaths(repo: Repo, baseTip: string, headTip: string): string[] {
  const baseCommit = lookupObject(repo, baseTip);
  const headCommit = lookupObject(repo, headTip);
  if (!baseCommit || baseCommit.type !== 'commit' || !headCommit || headCommit.type !== 'commit') return [];
  const files: Array<{ filename: string }> = [];
  diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree, '', files as Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>);
  return files.map((file) => file.filename);
}

export function handleRest(method: string, path: string, query: URLSearchParams, body: Buffer, baseUrl?: string): Reply | null {
  const segments = path === '' || path === '/' ? [] : path.split('/').filter((segment) => segment !== '');

  if (segments.length === 0) {
    if (method !== 'GET') return null;
    return jsonReply(200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    return jsonReply(200, { installed_version: 'github-core-clone-01/1.0.0' });
  }

  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    return jsonReply(200, { login: VIEWER_LOGIN, id: 1 });
  }

  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') return listRepos(query, baseUrl);
    if (method === 'POST') return createRepoRoute(body);
    return null;
  }

  if (segments[0] === 'repos') {
    if (segments.length < 2) return null;
    const owner = segments[1];
    const name = segments[2];
    const repo = getRepo(owner, name);

    if (segments.length === 3) {
      if (method === 'GET') return repo ? jsonReply(200, repoJson(repo)) : errorReply(404, 'Not Found');
      if (method === 'PATCH') return repo ? patchRepo(repo, body) : errorReply(404, 'Not Found');
      if (method === 'DELETE') {
        if (!repo) return errorReply(404, 'Not Found');
        deleteRepo(owner, name);
        return { status: 204, body: Buffer.alloc(0) };
      }
      return null;
    }

    if (!repo) {
      // Any deeper route on a missing repo is a 404 (or a 401 was already answered by app.ts).
      if (segments.length > 3) return errorReply(404, 'Not Found');
      return null;
    }

    const sub = segments[3];

    if (sub === 'contents') {
      const contentPath = segments.slice(4).join('/');
      return handleContents(repo, method, contentPath, query, body);
    }
    if (sub === 'labels' && segments.length === 4 && method === 'POST') {
      return createLabel(repo, body);
    }
    if (sub === 'issues') {
      return handleIssues(repo, method, segments.slice(4), query, body);
    }
    if (sub === 'pulls') {
      return handlePulls(repo, method, segments.slice(4), query, body);
    }
    if (sub === 'git' && segments[4] === 'refs') {
      if (method === 'POST' && segments.length === 5) return createRef(repo, body);
      if (method === 'GET' && segments[5] === 'heads' && segments.length === 7) return getRef(repo, segments[6]);
      return null;
    }
    if (sub === 'branches') {
      if (segments.length === 4 && method === 'GET') return listBranches(repo);
      if (segments.length === 5 && method === 'GET') return getBranch(repo, segments[4]);
      return null;
    }
    if (sub === 'commits' && segments.length === 4 && method === 'GET') {
      return listCommits(repo, query);
    }
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------------------------
// repos
// ---------------------------------------------------------------------------------------------

function listRepos(query: URLSearchParams, baseUrl?: string): Reply {
  const perPage = Number.parseInt(query.get('per_page') ?? '30', 10) || 30;
  const page = Number.parseInt(query.get('page') ?? '1', 10) || 1;
  const repos = reposForOwner(VIEWER_LOGIN);
  const start = (page - 1) * perPage;
  const slice = repos.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + slice.length < repos.length) {
    const suffix = query.has('per_page') ? `?page=${page + 1}&per_page=${perPage}` : `?page=${page + 1}`;
    const base = baseUrl ? `${baseUrl.replace(/\/$/, '')}/api/v3/user/repos${suffix}` : suffix;
    headers['Link'] = `<${base}>; rel="next"`;
  }
  return jsonReply(200, slice.map(repoJson), headers);
}

function createRepoRoute(body: Buffer): Reply {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return errorReply(400, 'Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return errorReply(400, 'Problems parsing JSON');
  }
  const name = typeof parsed.name === 'string' ? parsed.name : '';
  if (name === '') return errorReply(422, 'Repository name is required');
  const existing = getRepo(VIEWER_LOGIN, name);
  if (existing) return errorReply(422, 'Repository already exists');
  const description = typeof parsed.description === 'string' ? parsed.description : '';
  const isPrivate = parsed.private === true;
  const repo = createRepo(VIEWER_LOGIN, name, description, isPrivate);
  return jsonReply(201, repoJson(repo));
}

function patchRepo(repo: Repo, body: Buffer): Reply {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return errorReply(400, 'Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) return errorReply(400, 'Problems parsing JSON');
  if (typeof parsed.description === 'string') repo.description = parsed.description;
  if (typeof parsed.name === 'string' && parsed.name !== '') repo.name = parsed.name;
  return jsonReply(200, repoJson(repo));
}

// ---------------------------------------------------------------------------------------------
// branches, refs, commits
// ---------------------------------------------------------------------------------------------

function createRef(repo: Repo, body: Buffer): Reply {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return errorReply(400, 'Problems parsing JSON');
  }
  const ref = typeof parsed.ref === 'string' ? parsed.ref : '';
  const sha = typeof parsed.sha === 'string' ? parsed.sha : '';
  if (!ref.startsWith('refs/') || !SHA40.test(sha)) return errorReply(422, 'Invalid ref or sha');
  repo.refs.set(ref, sha);
  return jsonReply(201, { ref, object: { sha } });
}

function getRef(repo: Repo, branch: string): Reply {
  const ref = `refs/heads/${branch}`;
  const sha = repo.refs.get(ref);
  if (sha === undefined) return errorReply(404, 'Not Found');
  return jsonReply(200, { ref, object: { sha } });
}

function listBranches(repo: Repo): Reply {
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
  }
  return jsonReply(200, branches);
}

function getBranch(repo: Repo, branch: string): Reply {
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) return errorReply(404, 'Not Found');
  return jsonReply(200, { name: branch, commit: { sha } });
}

function listCommits(repo: Repo, query: URLSearchParams): Reply {
  const ref = query.get('sha');
  const branch = ref ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return jsonReply(200, []);
  const commits = commitList(repo, tip);
  return jsonReply(200, commits.map((commit) => ({ sha: commit.sha, commit: { message: commit.message } })));
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function handleContents(repo: Repo, method: string, contentPath: string, query: URLSearchParams, body: Buffer): Reply | null {
  const segments = contentPath === '' ? [] : contentPath.split('/').filter((segment) => segment !== '');
  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${ref}`);
    if (tip === undefined) return errorReply(404, 'Not Found');
    const commit = lookupObject(repo, tip);
    if (!commit || commit.type !== 'commit') return errorReply(404, 'Not Found');
    const found = readPath(repo, parseCommit(commit.data).tree, segments);
    if (found === null) return errorReply(404, 'Not Found');
    if (found.type === 'tree') {
      const entries = treeEntries(repo, found.oid);
      const listing = entries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: contentPath === '' ? entry.name : `${contentPath}/${entry.name}`,
        sha: entry.oid,
      }));
      return jsonReply(200, listing);
    }
    const blob = lookupObject(repo, found.oid)!;
    const last = segments[segments.length - 1] ?? '';
    return jsonReply(200, {
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      sha: found.oid,
      size: blob.data.length,
      name: last,
      path: contentPath,
    });
  }

  if (method === 'PUT') {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return errorReply(400, 'Problems parsing JSON');
    }
    const message = typeof parsed.message === 'string' ? parsed.message : 'update';
    const contentB64 = typeof parsed.content === 'string' ? parsed.content : '';
    const branch = typeof parsed.branch === 'string' ? parsed.branch : repo.defaultBranch;
    const sha = typeof parsed.sha === 'string' ? parsed.sha : undefined;
    const tree = branchTree(repo, branch);
    const existing = readPath(repo, tree, segments);
    if (sha !== undefined) {
      if (existing === null || existing.oid !== sha) return errorReply(409, 'sha does not match the current file');
    }
    const blobData = Buffer.from(contentB64, 'base64');
    const blobOid = hashObject('blob', blobData);
    putObject(repo, blobOid, { type: 'blob', data: blobData });
    const newTree = setPath(repo, tree, segments, blobOid);
    const commitOid = commitTree(repo, branch, newTree, message);
    return jsonReply(sha !== undefined ? 200 : 201, {
      content: { sha: blobOid, encoding: 'base64' },
      commit: { sha: commitOid },
    });
  }

  if (method === 'DELETE') {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return errorReply(400, 'Problems parsing JSON');
    }
    const message = typeof parsed.message === 'string' ? parsed.message : 'delete';
    const branch = typeof parsed.branch === 'string' ? parsed.branch : repo.defaultBranch;
    const tree = branchTree(repo, branch);
    const newTree = deletePath(repo, tree, segments);
    if (newTree === null) return errorReply(404, 'Not Found');
    const commitOid = commitTree(repo, branch, newTree, message);
    return jsonReply(200, { commit: { sha: commitOid } });
  }

  return null;
}

// ---------------------------------------------------------------------------------------------
// labels and issues
// ---------------------------------------------------------------------------------------------

function createLabel(repo: Repo, body: Buffer): Reply {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return errorReply(400, 'Problems parsing JSON');
  }
  const name = typeof parsed.name === 'string' ? parsed.name : '';
  const color = typeof parsed.color === 'string' ? parsed.color : 'ededed';
  if (name === '') return errorReply(422, 'Label name is required');
  repo.labels.set(name, { name, color });
  return jsonReply(201, { name, color });
}

function handleIssues(repo: Repo, method: string, rest: string[], query: URLSearchParams, body: Buffer): Reply | null {
  if (rest.length === 0 && method === 'POST') return createIssueRoute(repo, body);
  if (rest.length === 0 && method === 'GET') return listIssues(repo, query);
  if (rest.length === 1 && method === 'GET') return getIssue(repo, rest[0]);
  if (rest.length === 1 && method === 'PATCH') return patchIssue(repo, rest[0], body);
  if (rest.length === 2 && rest[1] === 'comments' && method === 'POST') return createComment(repo, rest[0], body);
  if (rest.length === 2 && rest[1] === 'comments' && method === 'GET') return listComments(repo, rest[0]);
  return null;
}

function createIssueRoute(repo: Repo, body: Buffer): Reply {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return errorReply(400, 'Problems parsing JSON');
  }
  const title = typeof parsed.title === 'string' ? parsed.title : '';
  const issueBody = typeof parsed.body === 'string' ? parsed.body : '';
  const labels = Array.isArray(parsed.labels) ? parsed.labels.filter((label): label is string => typeof label === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return errorReply(422, `Label "${label}" does not exist`);
  }
  const number = nextIssueNumber(repo);
  repo.issues.set(number, { number, title, body: issueBody, state: 'open', labels, comments: [] });
  return jsonReply(201, issueJson(repo, { number, title, body: issueBody, state: 'open', labels }));
}

function listIssues(repo: Repo, query: URLSearchParams): Reply {
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  const issues = [...repo.issues.values()].filter((issue) => {
    if (state === 'open') return issue.state === 'open';
    if (state === 'closed') return issue.state === 'closed';
    return true;
  });
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  return jsonReply(200, issues.map((issue) => issueJson(repo, issue)));
}

function getIssue(repo: Repo, numberText: string): Reply {
  const number = Number.parseInt(numberText, 10);
  const issue = repo.issues.get(number);
  if (!issue) return errorReply(404, 'Not Found');
  return jsonReply(200, issueJson(repo, issue));
}

function patchIssue(repo: Repo, numberText: string, body: Buffer): Reply {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return errorReply(400, 'Problems parsing JSON');
  }
  const number = Number.parseInt(numberText, 10);
  const issue = repo.issues.get(number);
  if (!issue) return errorReply(404, 'Not Found');
  if (parsed.state === 'closed' || parsed.state === 'open') issue.state = parsed.state;
  if (typeof parsed.title === 'string') issue.title = parsed.title;
  if (typeof parsed.body === 'string') issue.body = parsed.body;
  return jsonReply(200, issueJson(repo, issue));
}

function createComment(repo: Repo, numberText: string, body: Buffer): Reply {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return errorReply(400, 'Problems parsing JSON');
  }
  const number = Number.parseInt(numberText, 10);
  const issue = repo.issues.get(number);
  if (!issue) return errorReply(404, 'Not Found');
  const commentBody = typeof parsed.body === 'string' ? parsed.body : '';
  const id = nextCommentId(repo);
  issue.comments.push({ id, body: commentBody });
  return jsonReply(201, { id, body: commentBody });
}

function listComments(repo: Repo, numberText: string): Reply {
  const number = Number.parseInt(numberText, 10);
  const issue = repo.issues.get(number);
  if (!issue) return errorReply(404, 'Not Found');
  return jsonReply(200, issue.comments.map(commentJson));
}

// ---------------------------------------------------------------------------------------------
// pulls
// ---------------------------------------------------------------------------------------------

function handlePulls(repo: Repo, method: string, rest: string[], query: URLSearchParams, body: Buffer): Reply | null {
  if (rest.length === 0 && method === 'POST') return createPullRoute(repo, body);
  if (rest.length === 0 && method === 'GET') return listPulls(repo, query);
  if (rest.length === 1 && method === 'GET') return getPull(repo, rest[0]);
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') return pullFiles(repo, rest[0]);
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') return mergePullRoute(repo, rest[0], body);
  return null;
}

function createPullRoute(repo: Repo, body: Buffer): Reply {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return errorReply(400, 'Problems parsing JSON');
  }
  const head = typeof parsed.head === 'string' ? parsed.head : '';
  const base = typeof parsed.base === 'string' ? parsed.base : '';
  const title = typeof parsed.title === 'string' ? parsed.title : '';
  const pullBody = typeof parsed.body === 'string' ? parsed.body : '';
  const pull = createPull(repo, head, base, title, pullBody);
  if (pull === null) return errorReply(422, 'Head or base branch not found');
  return jsonReply(201, pullJson(repo, pull));
}

/** Create an open pull request from `head` to `base`; null when either branch is missing. */
export function createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull | null {
  if (!repo.refs.has(`refs/heads/${head}`)) return null;
  if (!repo.refs.has(`refs/heads/${base}`)) return null;
  const number = nextPullNumber(repo);
  const pull: Pull = { number, title, body, head, base, state: 'open', merged: false, mergeCommitSha: null };
  repo.pulls.set(number, pull);
  return pull;
}

function listPulls(repo: Repo, query: URLSearchParams): Reply {
  const state = query.get('state') ?? 'open';
  const pulls = [...repo.pulls.values()].filter((pull) => {
    if (state === 'open') return pull.state === 'open';
    if (state === 'closed') return pull.state === 'closed';
    return true;
  });
  pulls.sort((a, b) => b.number - a.number);
  return jsonReply(200, pulls.map((pull) => pullJson(repo, pull)));
}

function getPull(repo: Repo, numberText: string): Reply {
  const number = Number.parseInt(numberText, 10);
  const pull = repo.pulls.get(number);
  if (!pull) return errorReply(404, 'Not Found');
  return jsonReply(200, pullJson(repo, pull));
}

function pullFiles(repo: Repo, numberText: string): Reply {
  const number = Number.parseInt(numberText, 10);
  const pull = repo.pulls.get(number);
  if (!pull) return errorReply(404, 'Not Found');
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const out: Array<Record<string, unknown>> = [];
  if (baseTip && headTip) {
    const baseCommit = lookupObject(repo, baseTip);
    const headCommit = lookupObject(repo, headTip);
    if (baseCommit?.type === 'commit' && headCommit?.type === 'commit') {
      diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree, '', out as Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>);
    }
  }
  return jsonReply(200, out);
}

function mergePullRoute(repo: Repo, numberText: string, body: Buffer): Reply {
  const number = Number.parseInt(numberText, 10);
  const merged = mergePullRepo(repo, number);
  if (merged === null) {
    if (!repo.pulls.has(number)) return errorReply(404, 'Not Found');
    return errorReply(405, 'Pull Request is not mergeable');
  }
  return jsonReply(200, merged);
}

/** Squash-merge a pull request onto its base branch; null when it does not exist or is not mergeable. */
export function mergePullRepo(repo: Repo, number: number): { sha: string; merged: true; message: string } | null {
  const pull = repo.pulls.get(number);
  if (!pull || pull.state !== 'open') return null;
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseTip || !headTip) return null;
  const headCommit = lookupObject(repo, headTip);
  if (!headCommit || headCommit.type !== 'commit') return null;
  // A conflict is a base tip that is not an ancestor of the head tip (the branches diverged).
  if (baseTip !== headTip && !isAncestorOf(repo, baseTip, headTip)) {
    return null;
  }
  // Squash merge: the head's tree becomes a commit on the base branch.
  const message = `Merge pull request #${number} from ${pull.head}`;
  const commit = buildCommit({ tree: parseCommit(headCommit.data).tree, parents: [baseTip], message });
  const mergeSha = hashObject('commit', commit);
  putObject(repo, mergeSha, { type: 'commit', data: commit });
  repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = mergeSha;
  return { sha: mergeSha, merged: true, message };
}

/** Whether `ancestor` is on the parent chain of `descendant` (object-store walk). */
export function isAncestorOf(repo: Repo, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookupObject(repo, oid);
    if (object && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
  }
  return false;
}
