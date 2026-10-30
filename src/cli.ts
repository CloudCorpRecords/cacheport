#!/usr/bin/env node
/**
 * cacheport CLI.
 *
 *   cacheport mcp [redis-url]
 *   cacheport set <key> <value> [--expire-seconds n]
 *   cacheport get <key>
 *   cacheport delete <key> [key...]
 *   cacheport list [pattern]
 *   cacheport --version
 *
 * Exit codes: 0 success, 1 cache/connection error, 2 usage error.
 * For `mcp`, the Redis URL may be omitted when REDIS_URL (or the
 * CACHEPORT_ env spellings) is set; the server still starts and lists
 * its tools without a live server, and only calls fail.
 */
import { createCachePort, VERSION } from "./cache.js";

function usage(): never {
  console.error(`Usage:
  cacheport mcp [redis-url]
  cacheport set <key> <value> [--expire-seconds n]
  cacheport get <key>
  cacheport delete <key> [key...]
  cacheport list [pattern]
  cacheport --version`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    await import("./mcp.js");
    return;
  }
  if (!cmd) usage();
  try {
    const port = createCachePort();
    if (cmd === "set") {
      const expireIdx = rest.indexOf("--expire-seconds");
      let expireSeconds: number | undefined;
      const positional = [...rest];
      if (expireIdx >= 0) {
        const raw = positional[expireIdx + 1];
        if (raw === undefined) usage();
        expireSeconds = Number(raw);
        positional.splice(expireIdx, 2);
      }
      const [key, value] = positional;
      if (!key || value === undefined) usage();
      const status = await port.set(key, value, expireSeconds);
      console.log(status);
    } else if (cmd === "get") {
      const [key] = rest;
      if (!key) usage();
      const value = await port.get(key);
      console.log(value === null ? "(nil)" : value);
    } else if (cmd === "delete") {
      if (rest.length === 0) usage();
      const removed = await port.delete(rest.length === 1 ? rest[0] : rest);
      console.log(String(removed));
    } else if (cmd === "list") {
      const keys = await port.list(rest[0]);
      for (const key of keys) console.log(key);
    } else {
      usage();
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
