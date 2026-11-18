// mcp.ts — Model Context Protocol (Streamable HTTP) behind POST /mcp. JSON-RPC 2.0 over plain JSON
// bodies (the 2026-07-28 revision's `server/discover` handshake, `tools/list` and `tools/call`), resolving
// against the same in-memory store as REST, GraphQL and git so every surface reads the same objects.

import { Repo, createRepo, getRepo, nextIssueNumber, nextPullNumber } from './store.ts';
import { createPull, mergePullRepo } from './rest.ts';
import { Reply, VIEWER_LOGIN, jsonReply } from './shared.ts';

const SERVER_INFO = { name: 'github-core-clone-01', version: '1.0.0' };

// ---------------------------------------------------------------------------------------------
// the six tools
// ---------------------------------------------------------------------------------------------

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string }>; required: string[] };
}

const TOOLS: readonly ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a repository on the forge.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from one branch into another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------------------------------------
// tool execution
// ---------------------------------------------------------------------------------------------

interface ToolOutcome {
  isError: boolean;
  text: string;
  structured?: Record<string, unknown>;
}

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner },
  };
}

function issueObject(repo: Repo, issue: { number: number; title: string; body: string; state: 'open' | 'closed' }): Record<string, unknown> {
  return { number: issue.number, title: issue.title, body: issue.body, state: issue.state };
}

function runTool(name: string, args: Record<string, unknown>): ToolOutcome {
  const fail = (message: string): ToolOutcome => ({ isError: true, text: message });
  const asString = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      if (repoName === undefined) return fail('create_repo requires a name');
      const owner = asString(args.owner) ?? VIEWER_LOGIN;
      if (getRepo(owner, repoName) !== undefined) return fail(`repository ${owner}/${repoName} already exists`);
      const description = asString(args.description) ?? '';
      const repo = createRepo(owner, repoName, description, args.private === true);
      const structured = repoObject(repo);
      return { isError: false, text: JSON.stringify(structured), structured };
    }
    case 'get_repo': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      if (owner === undefined || repoName === undefined) return fail('get_repo requires owner and repo');
      const repo = getRepo(owner, repoName);
      if (repo === undefined) return fail(`repository ${owner}/${repoName} not found`);
      const structured = repoObject(repo);
      return { isError: false, text: JSON.stringify(structured), structured };
    }
    case 'create_issue': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const title = asString(args.title);
      if (owner === undefined || repoName === undefined || title === undefined) return fail('create_issue requires owner, repo and title');
      const repo = getRepo(owner, repoName);
      if (repo === undefined) return fail(`repository ${owner}/${repoName} not found`);
      const number = nextIssueNumber(repo);
      const body = asString(args.body) ?? '';
      repo.issues.set(number, { number, title, body, state: 'open', labels: [], comments: [] });
      const structured = { number, title, body, state: 'open' };
      return { isError: false, text: JSON.stringify(structured), structured };
    }
    case 'list_issues': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      if (owner === undefined || repoName === undefined) return fail('list_issues requires owner and repo');
      const repo = getRepo(owner, repoName);
      if (repo === undefined) return fail(`repository ${owner}/${repoName} not found`);
      const state = asString(args.state);
      const issues = [...repo.issues.values()]
        .filter((issue) => state === undefined || state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number)
        .map((issue) => issueObject(repo, issue));
      const structured = { issues };
      return { isError: false, text: JSON.stringify(structured), structured };
    }
    case 'create_pull_request': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const title = asString(args.title);
      const head = asString(args.head);
      const base = asString(args.base);
      if (owner === undefined || repoName === undefined || title === undefined || head === undefined || base === undefined) {
        return fail('create_pull_request requires owner, repo, title, head and base');
      }
      const repo = getRepo(owner, repoName);
      if (repo === undefined) return fail(`repository ${owner}/${repoName} not found`);
      const pull = createPull(repo, head, base, title, asString(args.body) ?? '');
      if (pull === null) return fail(`head or base branch not found`);
      const structured = { number: pull.number, title: pull.title, head: pull.head, base: pull.base, state: 'open' };
      return { isError: false, text: JSON.stringify(structured), structured };
    }
    case 'merge_pull_request': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const number = typeof args.pull_number === 'number' && Number.isInteger(args.pull_number) ? args.pull_number : undefined;
      if (owner === undefined || repoName === undefined || number === undefined) return fail('merge_pull_request requires owner, repo and pull_number');
      const repo = getRepo(owner, repoName);
      if (repo === undefined) return fail(`repository ${owner}/${repoName} not found`);
      const merged = mergePullRepo(repo, number);
      if (merged === null) return fail(`pull request #${number} is not mergeable`);
      const structured = { number, merged: true };
      return { isError: false, text: JSON.stringify(structured), structured };
    }
    default:
      return fail(`unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export function handleMcp(bodyText: string): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return jsonReply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return jsonReply(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const record = parsed as Record<string, unknown>;
  const id = record.id;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = record.params !== null && typeof record.params === 'object' && !Array.isArray(record.params) ? (record.params as Record<string, unknown>) : {};

  if (method === 'server/discover') {
    return jsonReply(200, {
      jsonrpc: '2.0',
      id,
      result: {
        resultType: 'discover',
        protocolVersion: '2026-07-28',
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      },
    });
  }

  if (method === 'tools/list') {
    return jsonReply(200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      return jsonReply(200, { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    }
    const outcome = runTool(name, args);
    if (outcome.isError) {
      return jsonReply(200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: outcome.text }], isError: true } });
    }
    return jsonReply(200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: outcome.text }], structuredContent: outcome.structured } });
  }

  return jsonReply(200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}
