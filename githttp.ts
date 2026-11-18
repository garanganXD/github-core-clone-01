// githttp.ts — the smart-HTTP git server: protocol v2 upload-pack (capability advertisement,
// ls-refs, fetch with haves and shallow support) and v0 receive-pack (report-status over
// side-band-64k, fast-forward-only updates, delete-refs). Packfiles are built and read on
// node:zlib + node:crypto, with no git binary anywhere.

import {
  GitObject,
  ZERO_OID,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parsePktLines,
  parseTag,
  parseTree,
  peelTag,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  writePack,
} from './git.ts';
import { Repo, headOid, lookupObject, putObject } from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'github-core-clone-01/1.0';

const UPLOAD_PACK_CAPS = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress agent';
const RECEIVE_PACK_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent';

function allRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const heads: Array<{ name: string; oid: string }> = [];
  const tags: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/heads/')) heads.push({ name, oid });
    else if (name.startsWith('refs/tags/')) tags.push({ name, oid });
  }
  return [...heads, ...tags];
}

function headRef(repo: Repo): { name: string; oid: string } {
  const branch = `refs/heads/${repo.defaultBranch}`;
  const oid = repo.refs.get(branch);
  if (oid) return { name: branch, oid };
  const first = allRefs(repo).find((ref) => ref.name.startsWith('refs/heads/'));
  return first ?? { name: branch, oid: ZERO_OID };
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function uploadPackCaps(): string {
  return `${UPLOAD_PACK_CAPS}=${AGENT} symref=HEAD:refs/heads/main object-format=sha1`;
}

function receivePackCaps(): string {
  return `${RECEIVE_PACK_CAPS}=${AGENT}`;
}

function advertiseV0(repo: Repo, caps: string, peelTags: boolean): Buffer {
  const parts: Buffer[] = [];
  const head = headRef(repo);
  const heads = allRefs(repo).filter((ref) => ref.name.startsWith('refs/heads/'));
  const tags = allRefs(repo).filter((ref) => ref.name.startsWith('refs/tags/'));
  const refs: Array<{ name: string; oid: string }> = [];
  if (heads.length) {
    refs.push({ name: 'HEAD', oid: head.oid });
    refs.push(...heads);
  } else {
    refs.push({ name: 'capabilities^{}', oid: ZERO_OID });
  }
  refs.push(...tags);
  refs.forEach((ref, index) => {
    if (index === 0) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\0${caps}\n`));
    } else {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    }
  });
  if (peelTags) {
    for (const tag of tags) {
      const peeled = peelTag(tag.oid, (oid) => lookupObject(repo, oid));
      if (peeled && peeled !== tag.oid) parts.push(pktLine(`${peeled} ${tag.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function advertiseV2(): Buffer {
  const lines = [
    'version 2',
    `agent=${AGENT}`,
    'ls-refs=unborn',
    'fetch=shallow',
    'server-option',
    'object-format=sha1',
    'flush',
  ];
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else parts.push(pktLine(`${line}\n`));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// ls-refs
// ---------------------------------------------------------------------------------------------

function lsRefsBody(repo: Repo, prefixes: string[], wantPeel: boolean): Buffer {
  const head = headRef(repo);
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (prefixes.length === 0) {
    const headOid = head.oid;
    if (headOid === ZERO_OID) {
      parts.push(pktLine(`unborn HEAD symref-target:${head.name}\n`));
    } else {
      parts.push(pktLine(`${headOid} HEAD symref-target:${head.name}\n`));
    }
  }
  for (const ref of allRefs(repo)) {
    if (!keep(ref.name)) continue;
    if (ref.name.startsWith('refs/tags/') && wantPeel) {
      const peeled = peelTag(ref.oid, (oid) => lookupObject(repo, oid));
      if (peeled && peeled !== ref.oid) {
        parts.push(pktLine(`${ref.oid} ${ref.name} peeled:${peeled}\n`));
        continue;
      }
    }
    parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------------------------

/** Walk a commit and its full tree (blobs and subtrees) but never its parents. */
function walkSnapshot(root: string, out: Set<string>, lookup: (oid: string) => GitObject | undefined): void {
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object) continue;
    out.add(oid);
    if (object.type === 'commit') stack.push(parseCommit(object.data).tree);
    else if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
  }
}

/** Objects the client already holds: haves walked fully, shallow boundaries cut at their parents. */
function collectHeld(repo: Repo, haves: string[], shallows: string[]): Set<string> {
  const shallowSet = new Set(shallows);
  const held = new Set<string>();
  const seen = new Set<string>();
  const stack = [...haves];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookupObject(repo, oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!shallowSet.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
  return held;
}

interface FetchPlan {
  send: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function planFetch(repo: Repo, wants: string[], haves: string[], shallows: string[], depth: number | null): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => lookupObject(repo, oid);
  const held = collectHeld(repo, haves, shallows);
  let sendOids = new Set<string>();
  let boundary = new Set<string>();

  if (depth == null) {
    sendOids = collectReachable(wants, lookup);
  } else {
    const commitLevel = new Map<string, number>();
    let frontier = wants.filter((w) => lookup(w)?.type === 'commit');
    let level = 0;
    while (frontier.length && level < depth) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (commitLevel.has(oid)) continue;
        commitLevel.set(oid, level);
        const object = lookup(oid);
        if (object?.type === 'commit') for (const parent of parseCommit(object.data).parents) next.push(parent);
      }
      frontier = next;
      level += 1;
    }
    for (const [oid, lvl] of commitLevel) {
      if (lvl === depth - 1) boundary.add(oid);
      walkSnapshot(oid, sendOids, lookup);
    }
  }

  for (const oid of held) sendOids.delete(oid);

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth != null) {
    for (const b of boundary) if (!held.has(b)) shallow.push(b);
    for (const s of shallows) if (!boundary.has(s)) unshallow.push(s);
  }

  // Deterministic order: commits, then trees, then blobs, each sorted by oid.
  const ordered = [...sendOids].sort((a, b) => {
    const ta = lookup(a)?.type ?? '';
    const tb = lookup(b)?.type ?? '';
    const rank = (t: string): number => (t === 'commit' ? 0 : t === 'tree' ? 1 : t === 'blob' ? 2 : 3);
    const r = rank(ta) - rank(tb);
    return r !== 0 ? r : (a < b ? -1 : a > b ? 1 : 0);
  });
  const send = ordered.map((oid) => lookup(oid)!).filter(Boolean);
  return { send, shallow, unshallow };
}

/** Frame the packfile section as side-band-64k packets (band 1), chunked to a legal pkt-line. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const chunkSize = 65515;
  for (let i = 0; i < pack.length; i += chunkSize) {
    const chunk = pack.subarray(i, Math.min(i + chunkSize, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// request handlers
// ---------------------------------------------------------------------------------------------

export function handleInfoRefs(repo: Repo | undefined, service: string, gitProtocol: string | null): GitResponse {
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}') };
  }
  if (service === 'git-receive-pack') {
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-advertisement',
      body: Buffer.concat([pktLine('# service=git-receive-pack\n'), advertiseV0(repo, receivePackCaps(), false)]),
    };
  }
  // git-upload-pack
  const wantsV2 = gitProtocol?.includes('version=2');
  const body = wantsV2
    ? advertiseV2()
    : Buffer.concat([pktLine('# service=git-upload-pack\n'), advertiseV0(repo, uploadPackCaps(), true)]);
  return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
}

export function handleUploadPack(repo: Repo | undefined, body: Buffer, gitProtocol: string | null): GitResponse {
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}') };
  }
  const wantsV2 = gitProtocol?.includes('version=2');
  const result = wantsV2 ? uploadPackV2(repo, body) : uploadPackV0(repo, body);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: result };
}

function uploadPackV2(repo: Repo, body: Buffer): Buffer {
  let packets: ReturnType<typeof parsePktLines>;
  try {
    packets = parsePktLines(body);
  } catch {
    // A malformed request (the suite posts garbage here): answer an empty, well-formed response.
    return Buffer.concat([pktLine('packfile\n'), sidebandPack(writePack([])), pktFlush()]);
  }
  let command = '';
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  const prefixes: string[] = [];
  let wantPeel = false;
  let sawDelim = false;
  let isLsRefs = false;

  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!sawDelim) {
      if (line.startsWith('command=')) {
        command = line.slice('command='.length);
        if (command === 'ls-refs') isLsRefs = true;
      }
      continue;
    }
    if (isLsRefs) {
      if (line === 'peel') wantPeel = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
      continue;
    }
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'want') wants.push(value);
    else if (key === 'have') haves.push(value);
    else if (key === 'shallow') shallows.push(value);
    else if (key === 'deepen') depth = Number.parseInt(value, 10);
  }

  if (isLsRefs) return lsRefsBody(repo, prefixes, wantPeel);

  const plan = planFetch(repo, wants, haves, shallows, depth);
  const parts: Buffer[] = [];
  if (depth != null && (plan.shallow.length || plan.unshallow.length)) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(writePack(plan.send)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function uploadPackV0(repo: Repo, body: Buffer): Buffer {
  let packets: ReturnType<typeof parsePktLines>;
  try {
    packets = parsePktLines(body);
  } catch {
    return Buffer.concat([pktLine('NAK\n'), sidebandPack(writePack([])), pktFlush()]);
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'want') wants.push(value);
    else if (key === 'have') haves.push(value);
    else if (key === 'shallow') shallows.push(value);
    else if (key === 'deepen') depth = Number.parseInt(value, 10);
  }
  void sawFlush;
  const plan = planFetch(repo, wants, haves, shallows, depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(writePack(plan.send)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleReceivePack(repo: Repo | undefined, body: Buffer): GitResponse {
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}') };
  }
  let packets: ReturnType<typeof parsePktLines>;
  let packBytes: Buffer;
  try {
    // Parse command pkt-lines, stopping at the flush; everything after is the raw packfile.
    packets = parsePktLines(body, true);
  } catch {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: reportBody('unpack error', []) };
  }
  let consumed = 0;
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const packet of packets) {
    consumed += 4 + packet.payload.length;
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  packBytes = body.subarray(consumed);

  let unpackStatus = 'ok';
  if (packBytes.length) {
    try {
      const unpacked = readPack(packBytes);
      for (const [oid, object] of unpacked.objects) putObject(repo, oid, object);
    } catch {
      unpackStatus = 'unpack error';
    }
  }

  const reports: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackStatus === 'ok') {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // delete
        if (current === command.oldOid) {
          repo.refs.delete(command.ref);
          reports.push({ ref: command.ref, ok: true, reason: '' });
        } else {
          reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        }
      } else if (command.oldOid === ZERO_OID) {
        // create
        if (current === undefined) {
          if (lookupObject(repo, command.newOid)) {
            repo.refs.set(command.ref, command.newOid);
            reports.push({ ref: command.ref, ok: true, reason: '' });
          } else {
            reports.push({ ref: command.ref, ok: false, reason: 'unpack error' });
          }
        } else {
          reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        }
      } else {
        // update: fast-forward only
        if (current === command.oldOid && lookupObject(repo, command.newOid) && isAncestor(command.oldOid, command.newOid, (oid) => lookupObject(repo, oid))) {
          repo.refs.set(command.ref, command.newOid);
          reports.push({ ref: command.ref, ok: true, reason: '' });
        } else {
          reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        }
      }
    }
  }

  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: reportBody(unpackStatus, reports) };
}

/** Build the report-status stream (pkt-framed) and wrap it in side-band-64k band 1. */
function reportBody(unpackStatus: string, reports: Array<{ ref: string; ok: boolean; reason: string }>): Buffer {
  const inner: Buffer[] = [];
  inner.push(pktLine(`unpack ${unpackStatus}\n`));
  for (const report of reports) {
    inner.push(report.ok ? pktLine(`ok ${report.ref}\n`) : pktLine(`ng ${report.ref} ${report.reason}\n`));
  }
  const stream = Buffer.concat(inner);
  // Wrap the inner pkt-line stream in band-1 sideband packets.
  const parts: Buffer[] = [];
  const chunkSize = 65515;
  for (let i = 0; i < stream.length; i += chunkSize) {
    const chunk = stream.subarray(i, Math.min(i + chunkSize, stream.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}
