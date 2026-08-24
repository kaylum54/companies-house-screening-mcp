# 14. The core carries no runtime dependencies

- **Status:** accepted
- **Date:** 2026-08-24

## Context

Supporting a hosted deployment (ADR 12) meant the same code had to run in
three places: Node over stdio, Node over HTTP, and Cloudflare Workers. Workers
have no filesystem, no `node:os` and no package.json to read at runtime.

The code did not survive that. `cache.ts` imported `node:fs/promises` for its
disk layer, `config.ts` called `homedir()` to pick a cache directory, and
`version.ts` used `node:module` to read the version off disk. Each is
reasonable for a local process and fatal for a Worker.

The dangerous part is *when* it fails. A stray `node:fs` import breaks the
Worker at deploy time, not at test time — the whole suite runs under Node and
notices nothing. This is exactly the class of mistake that gets found by a
user rather than by CI.

## Decision

**Node built-ins live under `src/node/`. Nothing else may import them.** The
filesystem cache, the cache-directory resolver, `.env` loading and the version
reader all moved there. `src/cloudflare/` is held to the same rule, because a
Worker cannot use them either.

**One audited exception: `node:crypto`'s `createHash`,** used for cache keys
and identity fingerprints. Cloudflare implements it under the `nodejs_compat`
flag, which `wrangler.toml` sets. It is listed by name in the test so that a
second exception has to be somebody's deliberate decision rather than a line
that slipped in.

**The durable half of the cache is a `CacheStore`.** `ResponseCache` keeps its
in-memory LRU and delegates persistence: `FileCacheStore` on Node,
`KvCacheStore` on Workers, nothing at all in tests. Stores are
failure-tolerant by contract — a broken cache may make the server slower, and
may never make it wrong or fail a request Companies House would have answered.

**`cacheDir` became optional configuration.** Only a runtime with a filesystem
has anywhere to point it, so resolving a platform default is the job of an
entry point that has one. `loadConfig` stays portable.

**The rule is enforced, not remembered.** `tests/runtime-portability.test.ts`
sweeps `src/`, and fails on any `node:` import outside `src/node/` that is not
the audited exception.

## Consequences

The guard found `version.ts` importing `node:module` on its first run. That is
the argument for having written it: the violation was already there, already
committed, and invisible to a suite running under Node.

`ResponseCache` takes a store rather than a directory, which is a breaking
change to an exported type. Tests construct `FileCacheStore` explicitly, which
is more honest about what they are exercising.

The Workers types are declared structurally in `src/cloudflare/types.ts`
rather than by depending on `@cloudflare/workers-types`. That package installs
a global environment — its `fetch`, `Request` and `Response` replace the Node
ones project-wide — and this repository typechecks Node entry points, Node
tests and Worker code in a single pass. The cost is a small surface that must
be kept true to the platform; the benefit is that one `npm run typecheck`
still covers everything.

The rule constrains future work. Anything wanting a Node built-in in the core
has to either move to `src/node/` or grow an adapter. That friction is the
point: it is what stops the Worker build breaking again.
