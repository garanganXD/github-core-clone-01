// store.ts — the forge's in-memory data model: repositories, refs, loose git objects, issues, labels,
// pull requests and comments. Every surface (REST, git, GraphQL, MCP) reads and mutates this one
// model, so an object written through one surface reads back through the others with the same ids.

import type { GitObject } from './git.ts';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>; // "refs/heads/main" -> oid
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: nextRepoId++,
    owner,
    name,
    description,
    private: isPrivate,
    defaultBranch: 'main',
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    issueSeq: 0,
    pullSeq: 0,
    commentSeq: 0,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

export function allRepos(): Repo[] {
  return [...repos.values()];
}

export function reposForOwner(owner: string): Repo[] {
  return [...repos.values()].filter((repo) => repo.owner === owner);
}

/** The object id a ref points at, or undefined when the ref is absent. */
export function refTarget(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function headOid(repo: Repo, branch?: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch ?? repo.defaultBranch}`);
}

export function putObject(repo: Repo, oid: string, object: GitObject): void {
  if (!repo.objects.has(oid)) repo.objects.set(oid, object);
}

export function lookupObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Hand out the next id in a per-repo monotonic sequence. */
function nextInSequence(repo: Repo, field: 'issueSeq' | 'pullSeq' | 'commentSeq'): number {
  repo[field] += 1;
  return repo[field];
}

export function nextIssueNumber(repo: Repo): number {
  return nextInSequence(repo, 'issueSeq');
}

export function nextPullNumber(repo: Repo): number {
  return nextInSequence(repo, 'pullSeq');
}

export function nextCommentId(repo: Repo): number {
  return nextInSequence(repo, 'commentSeq');
}

// Fixed timestamps keep every response reproducible across runs; nothing in the state carries a clock.
export const FIXED_TIME = '2025-06-01T12:00:00Z';
