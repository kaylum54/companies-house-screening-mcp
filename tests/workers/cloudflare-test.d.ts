// Types for the `cloudflare:test` module, which only exists inside the
// workerd pool and therefore has no runtime counterpart Node can resolve.
//
// Referenced rather than hand-written: these are the declarations the pool
// itself ships, so they cannot drift from the module the tests import. They in
// turn lean on `@cloudflare/workers-types`, which this project deliberately
// does not install — the portable core is typed against the web platform and
// `src/cloudflare/types.ts` declares the handful of Workers shapes it needs.
// `skipLibCheck` absorbs the difference, leaving `env` and `SELF` resolvable
// and loosely typed, which is all this suite asks of them.
/// <reference types="@cloudflare/vitest-pool-workers/types" />
