// shared.ts — the reply envelope and the few constants every HTTP surface returns, kept uniform
// across REST, GraphQL, MCP and git. No socket or routing lives here: app.ts owns the listener;
// these helpers only shape the bytes each surface answers with.

/** The content type carried by every JSON reply. */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** One HTTP reply: a status code, an optional content type, extra headers and the exact body bytes. */
export interface Reply {
  status: number;
  contentType?: string;
  headers?: Record<string, string>;
  body: Buffer;
}

/** The login the bearer token belongs to (fixed by the seeded scenario's viewer). */
export const VIEWER_LOGIN = 'adaiversen';

/** A JSON reply: the value is serialized once here and carried as bytes. */
export function jsonReply(status: number, value: unknown, headers: Record<string, string> = {}): Reply {
  return {
    status,
    contentType: JSON_CONTENT_TYPE,
    headers,
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

/** A standard error reply: `{ "message": <text> }`. */
export function errorReply(status: number, message: string): Reply {
  return jsonReply(status, { message });
}

/** UTF-8 text encoded as base64. */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Base64 decoded back to UTF-8 text. */
export function b64decode(text: string): string {
  return Buffer.from(text, 'base64').toString('utf8');
}
