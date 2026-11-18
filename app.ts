// app.ts — the forge's HTTP server. It routes the four surfaces the suite drives on the entry's base
// URL and answers them all from the one in-memory store: git smart HTTP at /{owner}/{repo}.git,
// REST v3 under /api/v3, GraphQL v4 at /api/graphql and MCP at /mcp, plus the env's /healthz boot
// probe. Auth, the X-GitHub-Request-Id header and the JSON 404 fallback are settled here so every
// surface behaves as the wire contract states.
//
// main.ts imports this module and nothing else; this file owns the request lifecycle and delegates
// each surface to its own module (rest.ts, graphql.ts, mcp.ts, githttp.ts).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitResponse } from './githttp.ts';
import { getRepo } from './store.ts';
import type { Reply } from './shared.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** One request id per reply, from a counter (deterministic across replays, never a clock). */
let requestSeq = 0;

/** The bearer token every authenticated surface checks; the env sets it once per trial. */
function authToken(): string {
  return (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();
}

/** Whether the request presents the trial's bearer token. */
function authenticated(req: IncomingMessage): boolean {
  const token = authToken();
  if (token === '') return false;
  const header = req.headers.authorization;
  return typeof header === 'string' && header === `Bearer ${token}`;
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Record<string, string>): void {
  res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': `req-${requestSeq}`, 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendBytes(res, status, JSON_TYPE, Buffer.from(JSON.stringify(body), 'utf8'), headers);
}

function sendReply(res: ServerResponse, reply: Reply): void {
  sendBytes(res, reply.status, reply.contentType ?? JSON_TYPE, reply.body, reply.headers ?? {});
}

function sendGit(res: ServerResponse, reply: GitResponse): void {
  sendBytes(res, reply.status, reply.contentType, reply.body, {});
}

/** Read a request body whole (a push packfile may be large; nothing here streams it). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A 401 with the surface's own error body. */
function sendUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

/** A JSON 404, the only "not found" shape any surface may answer. */
function sendNotFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

/** The pathname of a request URL, or '/' when it does not parse (a request must never throw the server). */
function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Whether a path is a git smart-HTTP route; returns owner/repo/remainder when it is. */
function gitRoute(path: string): { owner: string; repo: string; remainder: string } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length < 2) return null;
  const name = segments[1];
  if (!name.endsWith('.git')) return null;
  return { owner: segments[0], repo: name.slice(0, -'.git'.length), remainder: segments.slice(2).join('/') };
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    requestSeq += 1;
    void handle(req, res).catch((err: unknown) => {
      sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathnameOf(req);
  const method = req.method ?? 'GET';
  const query = new URL(req.url ?? '/', 'http://entry').searchParams;

  // The env's boot probe: 200 {"ok":true}, twice.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authenticated(req)) {
      sendUnauthorized(res);
      return;
    }
    const restPath = path.slice('/api/v3'.length);
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    const reply = handleRest(method, restPath, query, body);
    if (reply === null) {
      sendNotFound(res);
      return;
    }
    sendReply(res, reply);
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (!authenticated(req)) {
      sendUnauthorized(res);
      return;
    }
    const body = await readBody(req);
    sendReply(res, handleGraphql(body.toString('utf8')));
    return;
  }

  // MCP (JSON-RPC 2.0 over Streamable HTTP).
  if (path === '/mcp') {
    if (!authenticated(req)) {
      sendUnauthorized(res);
      return;
    }
    const body = await readBody(req);
    sendReply(res, handleMcp(body.toString('utf8')));
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/info/refs and the service POSTs.
  const git = gitRoute(path);
  if (git !== null) {
    const repo = getRepo(git.owner, git.repo);
    const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? req.headers['git-protocol'] : null;
    if (git.remainder === 'info/refs' && method === 'GET') {
      const service = query.get('service') ?? '';
      sendGit(res, handleInfoRefs(repo, service, gitProtocol));
      return;
    }
    if (git.remainder === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      sendGit(res, handleUploadPack(repo, body, gitProtocol));
      return;
    }
    if (git.remainder === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      sendGit(res, handleReceivePack(repo, body));
      return;
    }
    sendNotFound(res);
    return;
  }

  sendNotFound(res);
}
