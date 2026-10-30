# cacheport

cacheport is a small, honest front end for a Redis cache. It stores a
value under a key (optionally with an expiry), reads it back, deletes
one key or several at once, and lists the keys that match a glob
pattern. That is the whole job, and it does it by speaking Redis's own
wire protocol, RESP, over a plain TCP socket — there is no client
library bundled and nothing between you and the server's actual
replies.

When Redis is not there, cacheport says so. The MCP server starts and
lists its tools with no server behind it at all; only an actual
operation touches the socket, and a refused connection or a server
error comes back as an error, never as a made-up value.

## Install

```bash
npx @reneturcios/cacheport get mykey
```

Or run the container image:

```bash
docker run -i ghcr.io/cloudcorprecords/cacheport
```

The container defaults to the MCP server (see below). Pass CLI
arguments to use it as a CLI instead.

## CLI

```bash
# Store a value, with and without an expiry
cacheport set greeting "hello world"
cacheport set session abc123 --expire-seconds 3600

# Read it back (prints (nil) when the key is gone)
cacheport get greeting

# Delete one key, or several in one call; prints how many were removed
cacheport delete greeting
cacheport delete session old-session temp-key

# List keys; the pattern is a Redis glob and defaults to *
cacheport list
cacheport list "user:*"

# Start the MCP server (Redis URL optional, see below)
cacheport mcp redis://localhost:6379

cacheport --version
```

Exit codes: `0` on success, `1` when the cache or the connection
fails (the error says which), `2` for usage errors.

The target is a normal Redis URL: `redis://` or `rediss://`, with a
host, an optional port (default 6379), an optional password in the
userinfo, and an optional database index as the path (`/2` selects
db 2). Commands and `mcp` alike can take the target from the
environment instead: `REDIS_URL` first, then `CACHEPORT_REDIS_URL`,
then the split variables `REDIS_HOST` / `REDIS_PORT` /
`REDIS_PASSWORD` (or their `CACHEPORT_` spellings). With none of
those set, cacheport talks to `localhost:6379`.

## How it talks to Redis

Each operation opens a connection, writes the command as a RESP array
of bulk strings, and decodes the reply — a simple string for `SET`, a
bulk string (or nil) for `GET`, an integer for `DEL`, an array for
`KEYS`. When the target carries a password or a non-zero database
index, `AUTH` and `SELECT` run first on the same connection. Server
error replies surface with the server's own message attached.

An expiry passed to `set` is sent as `EX <seconds>`; fractional
seconds are floored, and a non-positive expiry is refused before
anything is sent.

## MCP server

One bin serves both faces. The `mcp` subcommand starts a stdio MCP
server:

```bash
npx -y @reneturcios/cacheport mcp redis://localhost:6379
```

MCP client configuration:

```json
{
  "mcpServers": {
    "cacheport": {
      "command": "npx",
      "args": ["-y", "@reneturcios/cacheport", "mcp"],
      "env": { "REDIS_URL": "redis://localhost:6379" }
    }
  }
}
```

### Tools

| Tool | Input | What it returns |
| --- | --- | --- |
| `set` | `key` (string, required), `value` (string, required), `expireSeconds` (number, optional) | The server status reply, normally `OK`. |
| `get` | `key` (string, required) | The stored string, or `null` when the key does not exist. |
| `delete` | `key` (string or array of strings, required) | How many keys were actually removed. |
| `list` | `pattern` (string, optional, default `*`) | The key names matching the glob pattern. |

Connection failures and server errors come back as tool errors with
the underlying message — never as invented values.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # node test runner over test/*.test.ts, no network, no live Redis
npm run dev     # run the CLI from source via tsx
```

The core logic sits behind an injectable executor interface, which is
what the test suite drives: the RESP encoder and decoder, URL
parsing, and all four operations are covered against a fake in-memory
executor.

## License

MIT — see `LICENSE`.
