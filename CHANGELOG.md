# Changelog

## 0.1.0 (2026-10-26)

- Initial release.
- CLI: `cacheport set <key> <value> [--expire-seconds n]` stores a
  value; `cacheport get <key>` prints it (or `(nil)`); `cacheport
  delete <key> [key...]` removes keys and prints how many went;
  `cacheport list [pattern]` prints matching key names; `cacheport
  mcp [redis-url]` starts the stdio MCP server. The target can also
  come from `REDIS_URL` or the `CACHEPORT_` environment spellings.
- MCP server with four tools: `set` (required `key` and `value`,
  optional numeric `expireSeconds`), `get` (required `key`), `delete`
  (required `key`, a string or an array of strings), and `list`
  (optional `pattern`).
- Hand-rolled RESP codec: commands go out as RESP arrays of bulk
  strings and replies (simple strings, integers, bulk strings,
  arrays, nil) are decoded byte-exactly. No Redis driver is bundled;
  the default executor speaks RESP over a `node:net` socket, running
  `AUTH` / `SELECT` first when the target URL carries them.
