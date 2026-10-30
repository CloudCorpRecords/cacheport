# cacheport — Build Report

MCP Rebuild 100. Clean-room rebuild of the reference "redis" MCP
server (modelcontextprotocol reference TS server), built from the
public tool spec in `harness/fixtures/redis-tools-original.json`
only. Local build only — nothing pushed or published.

Identity: repo `cacheport`, npm `@reneturcios/cacheport`,
MCP name `io.github.CloudCorpRecords/cacheport`, version `0.1.0`.

## Files created (19/19 per TEMPLATE.md checklist)

- `package.json` — bin `cacheport: dist/cli.js`, `mcpName` set,
  scripts build=`tsc` / dev=`tsx src/cli.ts` / test=`tsx --test test/*.test.ts`
- `server.json` — description "Key-value cache over Redis: set, get,
  delete and list keys." = **59 chars** (≤100 ✓); npm entry carries
  `version: 0.1.0`; OCI entry `ghcr.io/cloudcorprecords/cacheport:0.1.0`
  carries **no** `version` field (verified programmatically)
- `Dockerfile` — node:20-alpine two-stage, ENTRYPOINT `node /app/dist/cli.js`,
  CMD `mcp`, label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/cacheport"`
- `tsconfig.json` (byte-identical to pgport's / shipcheck's),
  `.gitignore`, `LICENSE` (MIT, Copyright (c) 2026 Rene Turcios),
  `README.md` (fresh text), `CHANGELOG.md` (single 0.1.0 entry, 2026-10-26)
- `src/index.ts`, `src/cli.ts` (`mcp [redis-url]`,
  `set <key> <value> [--expire-seconds n]`, `get <key>`,
  `delete <key> [key...]`, `list [pattern]`, `--version`;
  exit 2 usage / 1 cache error), `src/mcp.ts`, `src/types.ts`,
  `src/cache.ts` (core logic, `VERSION = "0.1.0"`)
- `test/cache.test.ts`
- `.github/workflows/{ci,publish,publish-container,registry-publish}.yml`
  (adapted from pgport; image name and smoke-test server name changed
  to cacheport)

## Implementation notes

- Four MCP tools, exactly as spec'd, with the spec's descriptions:
  `set` (required `key`/`value`, optional numeric `expireSeconds`),
  `get` (required `key`), `delete` (required `key` whose schema is
  `anyOf` string / array-of-strings), and `list` (optional `pattern`,
  `required: []`). No per-property descriptions, no extra keys.
- **Low-level Server API, with reason:** `src/mcp.ts` registers the
  tools via `Server` from `@modelcontextprotocol/sdk/server/index.js`
  with explicit inputSchema literals, not McpServer+zod — the
  high-level path injects `$schema` / `additionalProperties` and caps
  parity at 50% (standing rule from Wave 1). Zod still validates every
  `tools/call` argument set internally (including the delete union).
- Core class `CachePort` takes an injectable `RedisExecutor`
  (`send(command, args)` returning a decoded RESP value). All four
  operations, reply-shape checks, and error propagation are tested
  against a fake in-memory executor with no network and no live Redis.
- RESP codec, implemented genuinely in `src/cache.ts`:
  `encodeCommand` emits a RESP array of bulk strings with byte-accurate
  lengths; `tryParseResp` / `parseResp` decode simple strings, errors
  (thrown with the server's message), integers, bulk strings (nil →
  null), and nested arrays, and report an incomplete buffer instead of
  guessing — the streaming case the socket executor relies on.
- Default executor (`SocketRedisExecutor`): no Redis driver is
  bundled. Each `send` opens a `node:net` socket to the target, runs
  `AUTH` / `SELECT` first on the same connection when the target URL
  carries a password or a non-zero db index, writes the command, and
  accumulates bytes until the codec decodes one complete reply (10s
  timeout). Connection refusal surfaces as
  `Could not connect to Redis at <host>:<port>: ECONNREFUSED`.
- Target resolution: explicit `redis://` URL argument, then
  `REDIS_URL`, then `CACHEPORT_REDIS_URL`, then split host/port
  variables (`REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` or the
  `CACHEPORT_` spellings), defaulting to localhost:6379. No connection
  is opened at startup — the server answers `tools/list` with nothing
  behind it, and only a tool call touches the socket.
- `set` sends fractional expiries floored as `EX <seconds>` and
  refuses a non-positive expiry before anything is sent.

## Verification (exact outputs)

### 1. Build
```
$ ./node_modules/.bin/tsc ; echo exit=$?
tsc exit=0
```
`dist/` produced (cli.js with `#!/usr/bin/env node` shebang, cache.js,
mcp.js, index.js, types.js, plus .d.ts/.js.map), `dist/cli.js` present.

Note on the build run: the first `tsc` attempts in this session failed
with `TS5033 ... EPERM: operation not permitted, write` and 0-byte
outputs — the VM's intermittent exec write guard (AGENTS.md, learned
2026-10-22). The guard was verified to be environment-wide at that
moment (pgport's own `tsc` failed identically, and any exec process
that had read from `node_modules` was refused writes), then cleared
on its own; the final `./node_modules/.bin/tsc` run for this build —
and the rebuild after a one-line error-message fix — both exited 0
with full-size outputs. No alternate emit path was used for the
shipped `dist/`.

### 2. Tests
```
$ ./node_modules/.bin/tsx --test test/*.test.ts
ℹ tests 19
ℹ pass 19
ℹ fail 0
```
Covers: RESP encoding (including UTF-8 byte lengths), RESP decoding
(simple/integer/bulk/nil/nested, server-error throw, incomplete
buffer), Redis URL parsing (full, defaults, 5 malformed shapes), and
the four operations over a fake executor (plain SET, EX flooring,
expiry rejected pre-send, get hit/miss, single + multi delete with
counts, empty-delete rejection, list default `*` and explicit
pattern, executor-error propagation, wrong-shape reply rejection).

### 3. MCP + CLI smoke (live, this VM)
```
initialize -> serverInfo: {"name":"cacheport","version":"0.1.0"}
tools/list -> exactly the four spec tools with spec-identical schemas
tools/call get {"key":"nope"} with NO Redis running ->
  isError: "Could not connect to Redis at localhost:6379: ECONNREFUSED"
CLI: --version -> 0.1.0 (exit 0); no args -> Usage (exit 2);
  unknown command -> Usage (exit 2)
```

### 4. Parity (harness)
```
$ python3 ~/workspace/mcp-rebuild-100/harness/parity.py \
    --original ~/workspace/mcp-rebuild-100/harness/fixtures/redis-tools-original.json \
    --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/cacheport/dist/cli.js mcp" \
    --out ~/workspace/mcp-rebuild-100/builds/cacheport/parity-out
verdict=PASS parity_pct=100.0 original_tools=4 rebuild_tools=4 missing=[] extra=[] schema_diffs=[]
(exit 0)
```
`parity-out/parity.json` on disk confirms: verdict PASS,
parity_pct 100.0, identical_tools 4.

## Lockfile status

`package-lock.json` was copied from pgport with identity fields
edited; clean lockfile regen required before publish. Edited fields
(verified on disk): top-level `name`, root package `name`, and root
package `bin` key pgport -> cacheport (dependencies are identical
ranges, so the tree is unchanged). Per the fleet lesson in
TEMPLATE.md §2 item 6, a lockfile must be generated clean (no
`node_modules` present) before first publish — **clean regeneration
is deferred to the publish wave**; do not publish from this lockfile
as-is. `node_modules` in this build dir is a `cp -a` copy of pgport's
(local build only, gitignored).

## Blockers / honest gaps

- **No live Redis in this VM:** no Redis server exists here, so the
  socket executor's happy path — a real SET/GET round trip against a
  real server — could not be exercised. The RESP codec is unit-tested
  byte for byte, the operations are fully covered with a fake
  executor, and the failure path (connection refused) is verified
  live above. Behaviour parity against a live Redis is NOT claimed.
- **Fixture is docs-derived:** the ground-truth fixture's `_source`
  notes it was written from the reference server's public tool spec,
  not hand-probed from a live original (which cannot launch here —
  SCOREBOARD Blocker 1). Parity claimed here is tool/schema parity
  only (4/4 tools, 100.0%).
- Container build not exercised locally (no Docker run in this wave);
  the publish-container workflow smoke-tests the image at publish time.
- mcpaudit / mcpvet / shipcheck pre-publish gate not run — that
  belongs to the publish wave, not claimed here.

## Publish remediation deviation (2026-10-27, publish train)

Under Rene's 2026-10-27 remediation decision (the Wave 2 pattern,
`publish/GATE-POLICY.md`), descriptions were added to every tool
parameter that lacked one, in the `src/mcp.ts` schema literals only —
parameter names, types, required lists and enums are unchanged.

- Descriptions added: 6 (set: key, value, expireSeconds; get: key;
  delete: key; list: pattern).
- Rebuild: `npm run build` (tsc) exit 0; `tsc --noEmit` exit 0; full
  test suite 19/19 pass (tests 19, pass 19, fail 0).
- Parity harness re-run, verbatim: **PARTIAL, parity_pct 50.0** — all
  6 schema diffs are description additions
  (`*.description: present in rebuild but not in original`; 0
  structural). Structural parity proven independently: strip-proof
  strip-both-equal: true — recursively stripping `description` keys
  from both the pre- and post-remediation tools/list makes them
  deep-equal; every pre-existing description is byte-identical in
  post (changed-descriptions: 0, removed-descriptions: 0), and the
  only additions are the 6 at inputSchema property paths above.
  Adjudication: the description-only diffs are the authorized
  remediation itself; structural parity is unchanged. Full record:
  `publish/parity-remediation/cacheport/parity.json`
  (tools-pre.json / tools-post.json, strip-proof.py /
  strip-proof.txt alongside).
