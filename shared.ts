// shared.ts — the reply shape every surface returns and the small constants they share. No HTTP
// server code lives here; app.ts owns the socket and these helpers keep the four surfaces uniform.

/** One HTTP reply: a status, an optional content type and the exact body bytes. */
export interface Reply {
  status: number;
  contentType?: string;
  headers?: Record<string, string>;
  body: Buffer;
}

/** The login the bearer token owns (wire.ts's Scenario.viewer.login, fixed by the seeded scenario). */
export const VIEWER_LOGIN = 'adaiversen';

/** A JSON reply; the body is serialized once and carried as bytes. */
export function jsonReply(status: number, value: unknown, headers: Record<string, string> = {}): Reply {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    headers,
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

/** A standard error reply: `{ "message": <text> }`. */
export function errorReply(status: number, message: string): Reply {
  return jsonReply(status, { message });
}

export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function b64decode(text: string): string {
  return Buffer.from(text, 'base64').toString('utf8');
}
