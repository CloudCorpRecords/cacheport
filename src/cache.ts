/**
 * cacheport core: RESP wire encoding and decoding, a socket executor
 * that speaks RESP to a real Redis server, target parsing from a URL
 * or the environment, and the four cache operations (set, get, delete,
 * list) layered over an injectable executor.
 *
 * No Redis client library is bundled. RESP (the REdis Serialization
 * Protocol) is small enough to implement directly: a command is an
 * array of bulk strings, and a reply is one of a simple string, an
 * error, an integer, a bulk string, or an array of those. The codec
 * below encodes and decodes exactly that, and the unit tests drive it
 * byte for byte.
 *
 * The socket executor opens one connection per command batch. When the
 * target carries a password or a database index, AUTH / SELECT run on
 * the same connection before the caller's command. A server error
 * reply surfaces as a thrown Error carrying the server's message —
 * cacheport never invents a value.
 */
import { createConnection } from "node:net";
import type { RedisExecutor, RedisTarget, RespValue } from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_PATTERN = "*";

// ---------------------------------------------------------------------------
// Target parsing
// ---------------------------------------------------------------------------

/**
 * Parse a redis:// (or rediss://) URL into a target. The database index
 * comes from the path (/2 means db 2) and the password from userinfo.
 */
export function parseRedisUrl(raw: string): RedisTarget {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    throw new Error("Invalid Redis URL: '' (expected a redis:// URL)");
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Invalid Redis URL: '${raw}' (could not be parsed as a URL)`);
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error(`Invalid Redis URL: '${raw}' (scheme must be redis:// or rediss://)`);
  }
  const host = url.hostname;
  if (!host) {
    throw new Error(`Invalid Redis URL: '${raw}' (missing host)`);
  }
  let port = 6379;
  if (url.port) {
    port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid Redis URL: '${raw}' (invalid port '${url.port}')`);
    }
  }
  const target: RedisTarget = { host, port };
  if (url.password) target.password = decodeURIComponent(url.password);
  const dbText = url.pathname.replace(/^\//, "");
  if (dbText) {
    const db = Number(dbText);
    if (!Number.isInteger(db) || db < 0) {
      throw new Error(`Invalid Redis URL: '${raw}' (invalid database index '${dbText}')`);
    }
    target.db = db;
  }
  return target;
}

/**
 * Resolve the target the default executor should use. An explicit URL
 * wins; otherwise REDIS_URL, then CACHEPORT_REDIS_URL, then the split
 * host/port variables (REDIS_HOST / REDIS_PORT or the CACHEPORT_
 * spellings), and finally localhost:6379.
 */
export function resolveRedisTarget(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): RedisTarget {
  const fromArg = explicit?.trim();
  if (fromArg) return parseRedisUrl(fromArg);
  const fromRedisUrl = env.REDIS_URL?.trim();
  if (fromRedisUrl) return parseRedisUrl(fromRedisUrl);
  const fromCacheportUrl = env.CACHEPORT_REDIS_URL?.trim();
  if (fromCacheportUrl) return parseRedisUrl(fromCacheportUrl);
  const host =
    env.REDIS_HOST?.trim() || env.CACHEPORT_HOST?.trim() || "localhost";
  const portRaw = env.REDIS_PORT?.trim() || env.CACHEPORT_PORT?.trim();
  let port = 6379;
  if (portRaw) {
    port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid Redis port: '${portRaw}'`);
    }
  }
  const target: RedisTarget = { host, port };
  const password = env.REDIS_PASSWORD?.trim() || env.CACHEPORT_PASSWORD?.trim();
  if (password) target.password = password;
  return target;
}

// ---------------------------------------------------------------------------
// RESP codec
// ---------------------------------------------------------------------------

const CRLF = "\r\n";

/** Encode one command (name plus arguments) as a RESP array of bulk strings. */
export function encodeCommand(command: string, args: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length + 1}${CRLF}`, "utf8")];
  for (const piece of [command, ...args]) {
    const body = Buffer.from(piece, "utf8");
    parts.push(Buffer.from(`$${body.length}${CRLF}`, "utf8"), body, Buffer.from(CRLF, "utf8"));
  }
  return Buffer.concat(parts);
}

/** Read one CRLF-terminated line starting at offset. Null when incomplete. */
function readLine(buf: Buffer, offset: number): { line: string; next: number } | null {
  const end = buf.indexOf(CRLF, offset);
  if (end === -1) return null;
  return { line: buf.toString("utf8", offset, end), next: end + 2 };
}

/**
 * Try to decode one RESP value starting at offset. Returns the value and
 * the offset just past it, or null when the buffer does not yet hold the
 * whole value (the streaming case). A server error reply throws.
 */
export function tryParseResp(
  buf: Buffer,
  offset = 0,
): { value: RespValue; next: number } | null {
  if (offset >= buf.length) return null;
  const type = String.fromCharCode(buf[offset]);
  if (type === "+" || type === "-" || type === ":") {
    const head = readLine(buf, offset + 1);
    if (!head) return null;
    if (type === "+") return { value: head.line, next: head.next };
    if (type === "-") throw new Error(`Redis error: ${head.line}`);
    const num = Number(head.line);
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid RESP integer reply: '${head.line}'`);
    }
    return { value: num, next: head.next };
  }
  if (type === "$") {
    const head = readLine(buf, offset + 1);
    if (!head) return null;
    const len = Number(head.line);
    if (!Number.isInteger(len) || len < -1) {
      throw new Error(`Invalid RESP bulk string length: '${head.line}'`);
    }
    if (len === -1) return { value: null, next: head.next };
    const start = head.next;
    if (buf.length < start + len + 2) return null;
    return { value: buf.toString("utf8", start, start + len), next: start + len + 2 };
  }
  if (type === "*") {
    const head = readLine(buf, offset + 1);
    if (!head) return null;
    const count = Number(head.line);
    if (!Number.isInteger(count) || count < -1) {
      throw new Error(`Invalid RESP array length: '${head.line}'`);
    }
    if (count === -1) return { value: null, next: head.next };
    const items: RespValue[] = [];
    let cursor = head.next;
    for (let i = 0; i < count; i++) {
      const item = tryParseResp(buf, cursor);
      if (!item) return null;
      items.push(item.value);
      cursor = item.next;
    }
    return { value: items, next: cursor };
  }
  throw new Error(`Invalid RESP reply: unknown type byte '${type}'`);
}

/** Decode a buffer that must hold exactly one complete RESP value. */
export function parseResp(buf: Buffer): RespValue {
  const parsed = tryParseResp(buf, 0);
  if (!parsed) throw new Error("Incomplete RESP reply");
  return parsed.value;
}

// ---------------------------------------------------------------------------
// Socket executor
// ---------------------------------------------------------------------------

/**
 * Default executor: speaks RESP over a node:net socket. One connection
 * is opened per send() call; AUTH and SELECT, when the target calls for
 * them, run first on that same connection. Replies are accumulated until
 * the codec can decode a complete value, with a hard timeout so a silent
 * server fails instead of hanging the caller.
 */
export class SocketRedisExecutor implements RedisExecutor {
  constructor(
    private readonly target: RedisTarget,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(command: string, args: string[]): Promise<RespValue> {
    const script: Array<{ command: string; args: string[] }> = [];
    if (this.target.password) {
      script.push({ command: "AUTH", args: [this.target.password] });
    }
    if (this.target.db !== undefined && this.target.db !== 0) {
      script.push({ command: "SELECT", args: [String(this.target.db)] });
    }
    script.push({ command, args });

    return new Promise<RespValue>((resolve, reject) => {
      const socket = createConnection({
        host: this.target.host,
        port: this.target.port,
      });
      let buffer = Buffer.alloc(0);
      let step = 0;
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };
      socket.setTimeout(this.timeoutMs, () => {
        fail(
          new Error(
            `Redis connection to ${this.target.host}:${this.target.port} timed out after ${this.timeoutMs}ms`,
          ),
        );
      });
      socket.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") {
          const detail = err.message || err.code;
          fail(
            new Error(
              `Could not connect to Redis at ${this.target.host}:${this.target.port}: ${detail}`,
            ),
          );
          return;
        }
        fail(err instanceof Error ? err : new Error(String(err)));
      });
      socket.on("connect", () => {
        const first = script[0];
        socket.write(encodeCommand(first.command, first.args));
      });
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        try {
          for (;;) {
            const parsed = tryParseResp(buffer, 0);
            if (!parsed) return; // wait for the rest of this reply
            buffer = buffer.subarray(parsed.next);
            step += 1;
            if (step < script.length) {
              const nextCmd = script[step];
              socket.write(encodeCommand(nextCmd.command, nextCmd.args));
              continue;
            }
            if (settled) return;
            settled = true;
            socket.end();
            resolve(parsed.value);
            return;
          }
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      });
      socket.on("close", () => {
        if (!settled) {
          fail(
            new Error(
              `Redis connection to ${this.target.host}:${this.target.port} closed before a reply arrived`,
            ),
          );
        }
      });
    });
  }
}

export function createSocketExecutor(target: RedisTarget): RedisExecutor {
  return new SocketRedisExecutor(target);
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

function requireKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("key must be a non-empty string");
  }
  return key;
}

/**
 * The four cache operations over an injectable executor. Replies are
 * checked for the shape the command contract promises, so a confused
 * server produces a clear error rather than a silently wrong value.
 */
export class CachePort {
  constructor(private readonly executor: RedisExecutor) {}

  /** SET key value [EX expireSeconds]; resolves with the server status. */
  async set(key: string, value: string, expireSeconds?: number): Promise<string> {
    requireKey(key);
    if (typeof value !== "string") {
      throw new Error("value must be a string");
    }
    const args: string[] = [key, value];
    if (expireSeconds !== undefined) {
      if (
        typeof expireSeconds !== "number" ||
        !Number.isFinite(expireSeconds) ||
        expireSeconds <= 0
      ) {
        throw new Error("expireSeconds must be a positive number of seconds");
      }
      args.push("EX", String(Math.floor(expireSeconds)));
    }
    const reply = await this.executor.send("SET", args);
    if (typeof reply !== "string") {
      throw new Error(`Unexpected reply to SET: ${JSON.stringify(reply)}`);
    }
    return reply;
  }

  /** GET key; resolves with the stored string, or null when missing. */
  async get(key: string): Promise<string | null> {
    requireKey(key);
    const reply = await this.executor.send("GET", [key]);
    if (reply !== null && typeof reply !== "string") {
      throw new Error(`Unexpected reply to GET: ${JSON.stringify(reply)}`);
    }
    return reply as string | null;
  }

  /** DEL one or more keys; resolves with how many keys were removed. */
  async delete(key: string | string[]): Promise<number> {
    const keys = (Array.isArray(key) ? key : [key]).map(requireKey);
    if (keys.length === 0) {
      throw new Error("key must name at least one key to delete");
    }
    const reply = await this.executor.send("DEL", keys);
    if (typeof reply !== "number") {
      throw new Error(`Unexpected reply to DEL: ${JSON.stringify(reply)}`);
    }
    return reply;
  }

  /** KEYS pattern (default *); resolves with the matching key names. */
  async list(pattern?: string): Promise<string[]> {
    const effective =
      typeof pattern === "string" && pattern.length > 0 ? pattern : DEFAULT_PATTERN;
    const reply = await this.executor.send("KEYS", [effective]);
    if (!Array.isArray(reply)) {
      throw new Error(`Unexpected reply to KEYS: ${JSON.stringify(reply)}`);
    }
    return reply.map((item) => {
      if (typeof item !== "string") {
        throw new Error(`Unexpected key in KEYS reply: ${JSON.stringify(item)}`);
      }
      return item;
    });
  }
}

/** Wire a CachePort from an optional explicit Redis URL or the env. */
export function createCachePort(explicitUrl?: string): CachePort {
  const target = resolveRedisTarget(explicitUrl);
  return new CachePort(createSocketExecutor(target));
}
