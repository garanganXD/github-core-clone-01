// graphql.ts — a small, schema-driven GraphQL executor behind POST /api/graphql. It parses the
// documents the suite sends (queries, mutations, aliases, variables, inline fragments, list/object
// arguments, introspection) and resolves them against the same in-memory store as REST and git.
// Unknown fields surface as a 200 with an `errors` array; unknown repositories answer null.

import { Issue, Pull, Repo, allRepos, getRepo, nextCommentId, nextIssueNumber } from './store.ts';
import { changedPaths, createPull, isAncestorOf, mergePullRepo } from './rest.ts';
import { Reply, VIEWER_LOGIN, errorReply, jsonReply } from './shared.ts';

// ---------------------------------------------------------------------------------------------
// global (Relay) ids: base64 of `Type:repoId[:number]`, opaque and stable across reads
// ---------------------------------------------------------------------------------------------

function gid(type: string, repoId: number, number?: number): string {
  const payload = number === undefined ? `${type}:${repoId}` : `${type}:${repoId}:${number}`;
  return Buffer.from(payload, 'utf8').toString('base64');
}

function decodeGid(id: unknown): { type: string; repoId: number; number?: number } | null {
  if (typeof id !== 'string' || id === '') return null;
  let payload: string;
  try {
    payload = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = payload.split(':');
  if (parts.length < 2) return null;
  const repoId = Number(parts[1]);
  if (!Number.isInteger(repoId) || repoId <= 0) return null;
  const number = parts.length >= 3 ? Number(parts[2]) : undefined;
  return { type: parts[0], repoId, number };
}

function repoById(id: number): Repo | undefined {
  return allRepos().find((repo) => repo.id === id);
}

// ---------------------------------------------------------------------------------------------
// schema surface (for __type introspection)
// ---------------------------------------------------------------------------------------------

const SCHEMA: Record<string, { fields?: string[]; enumValues?: string[] }> = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body'] },
  PullRequest: { fields: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'] },
  Repository: {
    fields: [
      'id',
      'databaseId',
      'name',
      'nameWithOwner',
      'owner',
      'defaultBranchRef',
      'viewerPermission',
      'hasIssuesEnabled',
      'issue',
      'issues',
      'pullRequests',
      'pullRequest',
    ],
  },
  SearchType: { enumValues: ['ISSUE', 'REPOSITORY', 'DISCUSSION', 'CODE', 'COMMIT', 'USER', 'PACKAGE'] },
};

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:$!@=|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      let value = '';
      while (i < n && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < n) {
          const esc = source[i + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else value += esc;
          i += 2;
          continue;
        }
        value += source[i];
        i += 1;
      }
      i += 1; // closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let value = ch;
      i += 1;
      while (i < n && ((source[i] >= '0' && source[i] <= '9') || source[i] === '.' || source[i] === 'e' || source[i] === 'E' || source[i] === '+' || source[i] === '-')) {
        value += source[i];
        i += 1;
      }
      if (value.includes('.') || value.includes('e') || value.includes('E')) tokens.push({ kind: 'float', value: Number.parseFloat(value) });
      else tokens.push({ kind: 'int', value: Number.parseInt(value, 10) });
      continue;
    }
    if (ch === '_' || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
      let value = '';
      while (i < n && (source[i] === '_' || (source[i] >= 'A' && source[i] <= 'Z') || (source[i] >= 'a' && source[i] <= 'z') || (source[i] >= '0' && source[i] <= '9'))) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    i += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type Value = { __var: string } | { __obj: Record<string, Value> } | number | string | boolean | null | Value[];
interface Argument {
  name: string;
  value: Value;
}
interface Selection {
  kind: 'field' | 'inlineFragment';
  alias?: string;
  name?: string;
  arguments?: Argument[];
  selectionSet?: Selection[];
  typeCondition?: string;
}
interface Operation {
  type: 'query' | 'mutation';
  selectionSet: Selection[];
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (!token) throw new Error('unexpected end of document');
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.next();
      if (token.kind !== 'name' || (token.value !== 'query' && token.value !== 'mutation')) {
        throw new Error(`unexpected token ${token.kind === 'name' ? token.value : token.kind}`);
      }
      const type = token.value as 'query' | 'mutation';
      const next = this.peek();
      if (next && next.kind === 'name') this.next(); // operation name
      if (this.atPunct('(')) this.skipParenthesized();
      const selectionSet = this.parseSelectionSet();
      operations.push({ type, selectionSet });
    }
    return operations;
  }

  private skipParenthesized(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (true) {
      const token = this.peek();
      if (!token) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        break;
      }
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek()!;
    if (token.kind === 'spread') {
      this.next();
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected fragment name');
      if (name.value === 'on') {
        const typeName = this.next();
        if (typeName.kind !== 'name') throw new Error('expected type condition');
        const selectionSet = this.parseSelectionSet();
        return { kind: 'inlineFragment', typeCondition: typeName.value, selectionSet };
      }
      throw new Error('named fragments are not supported');
    }
    return this.parseField();
  }

  private parseField(): Selection {
    const first = this.next();
    if (first.kind !== 'name') throw new Error('expected field name');
    let name = first.value;
    let alias: string | undefined;
    if (this.atPunct(':')) {
      this.next();
      const target = this.next();
      if (target.kind !== 'name') throw new Error('expected field name after alias');
      alias = name;
      name = target.value;
    }
    let args: Argument[] = [];
    if (this.atPunct('(')) args = this.parseArguments();
    let selectionSet: Selection[] | undefined;
    if (this.atPunct('{')) selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, arguments: args, selectionSet };
  }

  private parseArguments(): Argument[] {
    this.expectPunct('(');
    const args: Argument[] = [];
    while (true) {
      const token = this.peek();
      if (!token) throw new Error('unterminated arguments');
      if (token.kind === 'punct' && token.value === ')') {
        this.next();
        break;
      }
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected argument name');
      this.expectPunct(':');
      args.push({ name: name.value, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected variable name');
      return { __var: name.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const list: Value[] = [];
      while (true) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ']') {
          this.next();
          break;
        }
        list.push(this.parseValue());
      }
      return list;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, Value> = {};
      while (true) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === '}') {
          this.next();
          break;
        }
        const key = this.next();
        if (key.kind !== 'name') throw new Error('expected object field name');
        this.expectPunct(':');
        obj[key.value] = this.parseValue();
      }
      return { __obj: obj };
    }
    if (token.kind === 'int') return token.value;
    if (token.kind === 'float') return token.value;
    if (token.kind === 'string') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // enum
    }
    throw new Error('unexpected token in value');
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface Node {
  __type: string;
  [key: string]: unknown;
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, variables));
  if (value !== null && typeof value === 'object') {
    if ('__var' in value) return variables[(value as { __var: string }).__var];
    if ('__obj' in value) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries((value as { __obj: Record<string, Value> }).__obj)) out[key] = resolveValue(entry, variables);
      return out;
    }
  }
  return value;
}

function unknownField(field: string, type: string): string {
  return `Cannot query field "${field}" on type "${type}".`;
}

function nodeType(value: unknown): string {
  if (value !== null && typeof value === 'object' && typeof (value as Node).__type === 'string') return (value as Node).__type;
  return 'Object';
}

function typeMatches(condition: string, value: unknown): boolean {
  return value !== null && typeof value === 'object' && (value as Node).__type === condition;
}

function issueNode(repo: Repo, issue: Issue): Node {
  return { __type: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): Node {
  return { __type: 'PullRequest', repo, pull };
}

function mergeableOf(repo: Repo, pull: Pull): string {
  if (pull.merged) return 'MERGEABLE';
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  return isAncestorOf(repo, baseTip, headTip) ? 'MERGEABLE' : 'CONFLICTING';
}

function __typeNode(name: unknown): Node | null {
  if (typeof name !== 'string') return null;
  const meta = SCHEMA[name];
  if (!meta) return null;
  return { __type: '__Type', typeName: name, fields: meta.fields ?? [], enumValues: meta.enumValues ?? [] };
}

function resolveField(
  typeName: string,
  parent: Node | null,
  fieldName: string,
  args: Argument[],
  variables: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const argValues: Record<string, unknown> = {};
  for (const argument of args) argValues[argument.name] = resolveValue(argument.value, variables);
  const err = (message: string) => ({ ok: false as const, error: message });
  const ok = (value: unknown) => ({ ok: true as const, value });

  if (typeName === 'Query') {
    switch (fieldName) {
      case 'viewer':
        return ok({ __type: 'Viewer', login: VIEWER_LOGIN });
      case 'repository': {
        const owner = argValues.owner;
        const name = argValues.name;
        const repo = typeof owner === 'string' && typeof name === 'string' ? getRepo(owner, name) : undefined;
        return ok(repo ? { __type: 'Repository', repo } : null);
      }
      case 'node': {
        const decoded = decodeGid(argValues.id);
        if (decoded && decoded.type === 'Repository') {
          const repo = repoById(decoded.repoId);
          return ok(repo ? { __type: 'Repository', repo } : null);
        }
        return ok(null);
      }
      case '__type':
        return ok(__typeNode(argValues.name));
      default:
        return err(unknownField(fieldName, 'Query'));
    }
  }

  if (typeName === 'Mutation') {
    switch (fieldName) {
      case 'createIssue': {
        const input = argValues.input;
        const repositoryId = input && typeof input === 'object' ? (input as Record<string, unknown>).repositoryId : undefined;
        const decoded = decodeGid(repositoryId);
        const repo = decoded && decoded.type === 'Repository' ? repoById(decoded.repoId) : undefined;
        if (!repo) return err('createIssue: unknown repository');
        const number = nextIssueNumber(repo);
        const title = (input as Record<string, unknown>)?.title;
        const body = (input as Record<string, unknown>)?.body;
        const issue: Issue = { number, title: typeof title === 'string' ? title : '', body: typeof body === 'string' ? body : '', state: 'open', labels: [], comments: [] };
        repo.issues.set(number, issue);
        return ok({ __type: 'CreateIssuePayload', repo, issue });
      }
      case 'closeIssue': {
        const input = argValues.input as Record<string, unknown> | undefined;
        const decoded = decodeGid(input?.issueId);
        const repo = decoded && decoded.type === 'Issue' ? repoById(decoded.repoId) : undefined;
        const issue = repo && decoded?.number !== undefined ? repo.issues.get(decoded.number) : undefined;
        if (!repo || !issue) return err('closeIssue: unknown issue');
        issue.state = 'closed';
        return ok({ __type: 'CloseIssuePayload', repo, issue });
      }
      case 'createPullRequest': {
        const input = argValues.input as Record<string, unknown> | undefined;
        const decoded = decodeGid(input?.repositoryId);
        const repo = decoded && decoded.type === 'Repository' ? repoById(decoded.repoId) : undefined;
        if (!repo) return err('createPullRequest: unknown repository');
        const headRefName = input?.headRefName;
        const baseRefName = input?.baseRefName;
        const title = input?.title;
        const body = input?.body;
        const pull = createPull(repo, typeof headRefName === 'string' ? headRefName : '', typeof baseRefName === 'string' ? baseRefName : '', typeof title === 'string' ? title : '', typeof body === 'string' ? body : '');
        if (!pull) return err('createPullRequest: head or base branch not found');
        return ok({ __type: 'CreatePullRequestPayload', repo, pull });
      }
      case 'mergePullRequest': {
        const input = argValues.input as Record<string, unknown> | undefined;
        const decoded = decodeGid(input?.pullRequestId);
        const repo = decoded && decoded.type === 'PullRequest' ? repoById(decoded.repoId) : undefined;
        if (!repo || decoded?.number === undefined) return err('mergePullRequest: unknown pull request');
        const merged = mergePullRepo(repo, decoded.number);
        if (!merged) return err('mergePullRequest: pull request is not mergeable');
        const pull = repo.pulls.get(decoded.number);
        return ok({ __type: 'MergePullRequestPayload', repo, pull });
      }
      case 'addComment': {
        const input = argValues.input as Record<string, unknown> | undefined;
        const decoded = decodeGid(input?.subjectId);
        const repo = decoded && decoded.type === 'Issue' ? repoById(decoded.repoId) : undefined;
        const issue = repo && decoded?.number !== undefined ? repo.issues.get(decoded.number) : undefined;
        if (!repo || !issue) return err('addComment: unknown issue');
        const id = nextCommentId(repo);
        const body = input?.body;
        issue.comments.push({ id, body: typeof body === 'string' ? body : '' });
        const node: Node = { __type: 'IssueComment', repo, number: decoded!.number, id, body: typeof body === 'string' ? body : '' };
        return ok({ __type: 'AddCommentPayload', node });
      }
      default:
        return err(unknownField(fieldName, 'Mutation'));
    }
  }

  if (typeName === 'Viewer') {
    if (fieldName === 'login') return ok(parent?.login);
    return err(unknownField(fieldName, 'Viewer'));
  }

  if (typeName === 'User') {
    if (fieldName === 'login') return ok(parent?.login);
    return err(unknownField(fieldName, 'User'));
  }

  if (typeName === '__Type') {
    if (fieldName === 'fields') return ok((parent?.fields as string[]).map((name) => ({ __type: '__Field', name })));
    if (fieldName === 'enumValues') return ok((parent?.enumValues as string[]).map((name) => ({ __type: '__EnumValue', name })));
    return err(unknownField(fieldName, '__Type'));
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (fieldName === 'name') return ok(parent?.name);
    return err(unknownField(fieldName, typeName));
  }

  if (typeName === 'Ref') {
    if (fieldName === 'name') return ok(parent?.name);
    return err(unknownField(fieldName, 'Ref'));
  }

  if (typeName === 'Repository') {
    const repo = parent!.repo as Repo;
    switch (fieldName) {
      case 'id':
        return ok(gid('Repository', repo.id));
      case 'databaseId':
        return ok(repo.id);
      case 'name':
        return ok(repo.name);
      case 'nameWithOwner':
        return ok(`${repo.owner}/${repo.name}`);
      case 'owner':
        return ok({ __type: 'User', login: repo.owner });
      case 'defaultBranchRef':
        return ok(repo.refs.get(`refs/heads/${repo.defaultBranch}`) ? { __type: 'Ref', name: repo.defaultBranch } : null);
      case 'viewerPermission':
        return ok('ADMIN');
      case 'hasIssuesEnabled':
        return ok(true);
      case 'issue': {
        const number = argValues.number;
        const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
        return ok(issue ? issueNode(repo, issue) : null);
      }
      case 'issues': {
        const first = typeof argValues.first === 'number' && argValues.first > 0 ? argValues.first : undefined;
        const states = Array.isArray(argValues.states) ? (argValues.states as string[]) : undefined;
        const after = typeof argValues.after === 'string' && argValues.after !== '' ? argValues.after : null;
        let issues = [...repo.issues.values()];
        if (states && states.length > 0) {
          issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        issues.sort((a, b) => b.number - a.number);
        if (after !== null) {
          const cursor = Number(after);
          if (Number.isFinite(cursor)) issues = issues.filter((issue) => issue.number < cursor);
        }
        const total = issues.length;
        const sliced = first === undefined ? issues : issues.slice(0, first);
        return ok({
          __type: 'IssueConnection',
          nodes: sliced.map((issue) => issueNode(repo, issue)),
          hasNextPage: sliced.length < total,
          endCursor: sliced.length > 0 ? String(sliced[sliced.length - 1].number) : null,
        });
      }
      case 'pullRequests': {
        const first = typeof argValues.first === 'number' && argValues.first > 0 ? argValues.first : undefined;
        const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
        const sliced = first === undefined ? pulls : pulls.slice(0, first);
        return ok({ __type: 'PullRequestConnection', nodes: sliced.map((pull) => pullNode(repo, pull)) });
      }
      case 'pullRequest': {
        const number = argValues.number;
        const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
        return ok(pull ? pullNode(repo, pull) : null);
      }
      default:
        return err(unknownField(fieldName, 'Repository'));
    }
  }

  if (typeName === 'Issue') {
    const repo = parent!.repo as Repo;
    const issue = parent!.issue as Issue;
    switch (fieldName) {
      case 'id':
        return ok(gid('Issue', repo.id, issue.number));
      case 'number':
        return ok(issue.number);
      case 'title':
        return ok(issue.title);
      case 'state':
        return ok(issue.state === 'open' ? 'OPEN' : 'CLOSED');
      case 'body':
        return ok(issue.body);
      default:
        return err(unknownField(fieldName, 'Issue'));
    }
  }

  if (typeName === 'IssueConnection') {
    if (fieldName === 'nodes') return ok(parent?.nodes);
    if (fieldName === 'pageInfo') return ok({ __type: 'PageInfo', hasNextPage: parent?.hasNextPage, endCursor: parent?.endCursor });
    return err(unknownField(fieldName, 'IssueConnection'));
  }

  if (typeName === 'PageInfo') {
    if (fieldName === 'hasNextPage') return ok(parent?.hasNextPage);
    if (fieldName === 'endCursor') return ok(parent?.endCursor);
    return err(unknownField(fieldName, 'PageInfo'));
  }

  if (typeName === 'PullRequest') {
    const repo = parent!.repo as Repo;
    const pull = parent!.pull as Pull;
    switch (fieldName) {
      case 'id':
        return ok(gid('PullRequest', repo.id, pull.number));
      case 'number':
        return ok(pull.number);
      case 'state':
        return ok(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED');
      case 'merged':
        return ok(pull.merged);
      case 'headRefName':
        return ok(pull.head);
      case 'baseRefName':
        return ok(pull.base);
      case 'mergeable':
        return ok(mergeableOf(repo, pull));
      case 'files': {
        const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
        const headTip = repo.refs.get(`refs/heads/${pull.head}`);
        const paths = baseTip && headTip ? changedPaths(repo, baseTip, headTip) : [];
        return ok({ __type: 'PullRequestFileConnection', nodes: paths.map((path) => ({ __type: 'PullRequestChangedFile', path })) });
      }
      default:
        return err(unknownField(fieldName, 'PullRequest'));
    }
  }

  if (typeName === 'PullRequestConnection') {
    if (fieldName === 'nodes') return ok(parent?.nodes);
    return err(unknownField(fieldName, 'PullRequestConnection'));
  }

  if (typeName === 'PullRequestFileConnection') {
    if (fieldName === 'nodes') return ok(parent?.nodes);
    return err(unknownField(fieldName, 'PullRequestFileConnection'));
  }

  if (typeName === 'PullRequestChangedFile') {
    if (fieldName === 'path') return ok(parent?.path);
    return err(unknownField(fieldName, 'PullRequestChangedFile'));
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (fieldName === 'issue') return ok(issueNode(parent!.repo as Repo, parent!.issue as Issue));
    return err(unknownField(fieldName, typeName));
  }

  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (fieldName === 'pullRequest') return ok(pullNode(parent!.repo as Repo, parent!.pull as Pull));
    return err(unknownField(fieldName, typeName));
  }

  if (typeName === 'AddCommentPayload') {
    if (fieldName === 'commentEdge') return ok({ __type: 'IssueCommentEdge', node: parent?.node });
    return err(unknownField(fieldName, 'AddCommentPayload'));
  }

  if (typeName === 'IssueCommentEdge') {
    if (fieldName === 'node') return ok(parent?.node);
    return err(unknownField(fieldName, 'IssueCommentEdge'));
  }

  if (typeName === 'IssueComment') {
    if (fieldName === 'id') return ok(gid('IssueComment', (parent!.repo as Repo).id, parent!.number as number));
    if (fieldName === 'body') return ok(parent?.body);
    return err(unknownField(fieldName, 'IssueComment'));
  }

  return err(unknownField(fieldName, typeName));
}

function executeSelectionSet(selections: Selection[], typeName: string, parent: Node | null, variables: Record<string, unknown>, errors: Array<{ message: string }>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (typeMatches(selection.typeCondition!, parent)) {
        Object.assign(result, executeSelectionSet(selection.selectionSet!, typeName, parent, variables, errors));
      }
      continue;
    }
    const key = selection.alias ?? selection.name!;
    const resolved = resolveField(typeName, parent, selection.name!, selection.arguments ?? [], variables);
    if (!resolved.ok) {
      errors.push({ message: resolved.error });
      result[key] = null;
      continue;
    }
    const value = resolved.value;
    if (!selection.selectionSet) {
      result[key] = value;
      continue;
    }
    if (value === null || value === undefined) {
      result[key] = null;
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => executeSelectionSet(selection.selectionSet!, nodeType(item), item as Node, variables, errors));
    } else {
      result[key] = executeSelectionSet(selection.selectionSet!, nodeType(value), value as Node, variables, errors);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

function executeOne(operation: unknown): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  if (operation === null || typeof operation !== 'object' || typeof (operation as Record<string, unknown>).query !== 'string') {
    return { data: null, errors: [{ message: 'a GraphQL request needs a query string' }] };
  }
  const query = (operation as Record<string, unknown>).query as string;
  const variables = (operation as Record<string, unknown>).variables;
  const variablesRecord = variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {};
  try {
    const parser = new Parser(tokenize(query));
    const operations = parser.parseDocument();
    if (operations.length === 0) return { data: null, errors: [{ message: 'no operation in document' }] };
    const errors: Array<{ message: string }> = [];
    const data = executeSelectionSet(operations[0].selectionSet, operations[0].type === 'mutation' ? 'Mutation' : 'Query', null, variablesRecord, errors);
    return { data, errors };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

export function handleGraphql(bodyText: string): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return errorReply(400, 'Problems parsing JSON');
  }
  if (Array.isArray(parsed)) {
    return jsonReply(200, parsed.map(executeOne));
  }
  return jsonReply(200, executeOne(parsed));
}
