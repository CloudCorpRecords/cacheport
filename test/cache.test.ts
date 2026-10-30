import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CachePort,
  encodeCommand,
  parseRedisUrl,
  parseResp,
  tryParseResp,
} from "../src/cache.js";
import type { RedisExecutor, RespValue } from "../src/types.js";

/** In-memory fake executor: a tiny key-value store behind send(). */
function fakeExecutor(): RedisExecutor & {
  calls: Array<{ command: string; args: string[] }>;
  store: Map<string, string>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const store = new Map<string, string>();
  return {
    calls,
    store,
    async send(command: string, args: string[]): Promise<RespValue> {
      calls.push({ command, args });
      if (command === "SET") {
        store.set(args[0], args[1]);
        return "OK";
      }
      if (command === "GET") {
        return store.has(args[0]) ? (store.get(args[0]) as string) : null;
      }
      if (command === "DEL") {
        let removed = 0;
        for (const key of args) if (store.delete(key)) removed += 1;
        return removed;
      }
      if (command === "KEYS") {
        const pattern = args[0] ?? "*";
        const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
        return [...store.keys()].filter((k) => k.startsWith(prefix));
      }
      throw new Error(`fake executor: unknown command ${command}`);
    },
  };
}

describe("encodeCommand", () => {
  it("encodes a command as a RESP array of bulk strings", () => {
    const buf = encodeCommand("GET", ["mykey"]);
    assert.equal(buf.toString("utf8"), "*2\r\n$3\r\nGET\r\n$5\r\nmykey\r\n");
  });

  it("counts bytes, not characters, for multibyte arguments", () => {
    const buf = encodeCommand("SET", ["k", "héllo"]);
    // "héllo" is 6 bytes in UTF-8 (é takes two).
    assert.equal(buf.toString("utf8"), "*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$6\r\nhéllo\r\n");
  });
});

describe("RESP decoding", () => {
  it("decodes simple strings, integers, and bulk strings", () => {
    assert.equal(parseResp(Buffer.from("+OK\r\n")), "OK");
    assert.equal(parseResp(Buffer.from(":42\r\n")), 42);
    assert.equal(parseResp(Buffer.from("$5\r\nhello\r\n")), "hello");
    assert.equal(parseResp(Buffer.from("$0\r\n\r\n")), "");
  });

  it("decodes nil bulk strings and nil arrays as null", () => {
    assert.equal(parseResp(Buffer.from("$-1\r\n")), null);
    assert.equal(parseResp(Buffer.from("*-1\r\n")), null);
  });

  it("decodes nested arrays", () => {
    assert.deepEqual(parseResp(Buffer.from("*2\r\n$1\r\na\r\n:7\r\n")), ["a", 7]);
    assert.deepEqual(parseResp(Buffer.from("*0\r\n")), []);
  });

  it("surfaces a server error reply as a thrown error", () => {
    assert.throws(() => parseResp(Buffer.from("-ERR unknown command\r\n")), /Redis error: ERR unknown command/);
  });

  it("reports an incomplete buffer instead of guessing", () => {
    assert.equal(tryParseResp(Buffer.from("$5\r\nhel")), null);
    assert.throws(() => parseResp(Buffer.from("$5\r\nhel")), /Incomplete RESP reply/);
  });
});

describe("parseRedisUrl", () => {
  it("parses host, port, password, and database index", () => {
    const target = parseRedisUrl("redis://:s3cret@cache.example.com:6380/2");
    assert.equal(target.host, "cache.example.com");
    assert.equal(target.port, 6380);
    assert.equal(target.password, "s3cret");
    assert.equal(target.db, 2);
  });

  it("applies the default port and no password/db", () => {
    const target = parseRedisUrl("redis://localhost");
    assert.deepEqual(target, { host: "localhost", port: 6379 });
  });

  it("rejects malformed URLs", () => {
    for (const bad of ["", "not a url", "http://localhost/0", "redis://", "redis://localhost/notadb"]) {
      assert.throws(() => parseRedisUrl(bad), /Invalid Redis URL/, bad);
    }
  });
});

describe("CachePort operations over a fake executor", () => {
  it("set without expiry sends a plain SET and returns OK", async () => {
    const executor = fakeExecutor();
    const port = new CachePort(executor);
    assert.equal(await port.set("greeting", "hello"), "OK");
    assert.deepEqual(executor.calls, [{ command: "SET", args: ["greeting", "hello"] }]);
  });

  it("set with expireSeconds appends EX with whole seconds", async () => {
    const executor = fakeExecutor();
    const port = new CachePort(executor);
    await port.set("session", "abc", 90.9);
    assert.deepEqual(executor.calls, [
      { command: "SET", args: ["session", "abc", "EX", "90"] },
    ]);
  });

  it("set rejects a non-positive expiry before sending", async () => {
    const executor = fakeExecutor();
    const port = new CachePort(executor);
    await assert.rejects(() => port.set("k", "v", 0), /positive number/);
    await assert.rejects(() => port.set("k", "v", -5), /positive number/);
    assert.deepEqual(executor.calls, []);
  });

  it("get returns the stored value and null for a missing key", async () => {
    const executor = fakeExecutor();
    const port = new CachePort(executor);
    await port.set("a", "1");
    assert.equal(await port.get("a"), "1");
    assert.equal(await port.get("missing"), null);
  });

  it("delete accepts one key or many and returns the removed count", async () => {
    const executor = fakeExecutor();
    const port = new CachePort(executor);
    await port.set("a", "1");
    await port.set("b", "2");
    await port.set("c", "3");
    assert.equal(await port.delete("a"), 1);
    assert.deepEqual(executor.calls.at(-1), { command: "DEL", args: ["a"] });
    assert.equal(await port.delete(["b", "c", "gone"]), 2);
    assert.deepEqual(executor.calls.at(-1), { command: "DEL", args: ["b", "c", "gone"] });
  });

  it("delete rejects an empty key list", async () => {
    const port = new CachePort(fakeExecutor());
    await assert.rejects(() => port.delete([]), /at least one key/);
  });

  it("list defaults to * and passes an explicit pattern through", async () => {
    const executor = fakeExecutor();
    const port = new CachePort(executor);
    await port.set("user:1", "x");
    await port.set("user:2", "y");
    await port.set("other", "z");
    assert.deepEqual((await port.list()).sort(), ["other", "user:1", "user:2"]);
    assert.deepEqual(executor.calls.at(-1), { command: "KEYS", args: ["*"] });
    assert.deepEqual((await port.list("user:*")).sort(), ["user:1", "user:2"]);
  });

  it("propagates executor errors instead of inventing values", async () => {
    const failing: RedisExecutor = {
      async send() {
        throw new Error("Could not connect to Redis at localhost:6379: connect ECONNREFUSED");
      },
    };
    const port = new CachePort(failing);
    await assert.rejects(() => port.get("a"), /ECONNREFUSED/);
    await assert.rejects(() => port.set("a", "1"), /ECONNREFUSED/);
  });

  it("rejects a reply of the wrong shape", async () => {
    const weird: RedisExecutor = {
      async send() {
        return 123;
      },
    };
    const port = new CachePort(weird);
    await assert.rejects(() => port.get("a"), /Unexpected reply to GET/);
  });
});
