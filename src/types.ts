/**
 * cacheport types.
 *
 * The core talks to Redis only through an injectable executor, so every
 * behaviour except the real socket can be tested with a fake executor
 * and no live server. A RESP value is what a Redis reply decodes to:
 * a simple string or bulk string becomes a string, an integer reply a
 * number, an array reply an array of values, and a nil reply null.
 */

export type RespValue = string | number | null | RespValue[];

/**
 * Anything that can send one Redis command (a command name plus its
 * string arguments) and resolve with the decoded reply. The default
 * implementation speaks RESP over a TCP socket; tests inject a fake.
 */
export interface RedisExecutor {
  send(command: string, args: string[]): Promise<RespValue>;
}

/** Connection pieces for a Redis server, parsed from a URL or env. */
export interface RedisTarget {
  host: string;
  /** TCP port; 6379 when nothing overrides it. */
  port: number;
  /** Password from URL userinfo, when present. */
  password?: string;
  /** Logical database index from the URL path, when present. */
  db?: number;
}
