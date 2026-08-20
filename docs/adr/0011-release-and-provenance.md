# 11. Tag-driven releases, signed with provenance

- **Status:** accepted
- **Date:** 2026-08-20

## Context

This is a package people would install and point a language model at, with
their own API key, against a public register. The trust question is not
theoretical: "is the thing on npm the thing in this repository" is exactly
what a supply-chain attack makes false, and a consumer has no way to check by
reading.

Discovering, late, that the name `companies-house-mcp` was already taken by an
actively maintained v4.0.0 also made a naming decision necessary — see the
consequences below.

## Decision

**Releases are driven by a tag, not by a merge.** A release is a deliberate
act with a name, and a tag is the only artefact that later tells you which
commit a published version came from. The workflow refuses to publish when the
tag and `package.json` version disagree.

**npm publish carries provenance.** `--provenance` with `id-token: write`
means npm can attest that the tarball was built by this workflow, from this
commit. Without the OIDC permission the flag fails rather than quietly
publishing something unattested, which is the right failure direction.

**The container image is attested too**, via
`actions/attest-build-provenance`, pushed to the registry alongside the image.
Same argument: an image nobody can trace back to a commit is an image nobody
should run.

**`prepublishOnly` runs the whole verification** — typecheck, documentation
drift check, tests, build, and a release check — so a publish from a laptop
cannot skip what CI would have done.

**`release-check.ts` asserts things about the artefact that no unit test can.**
Every check is a way a package can be green in CI and broken on npm: a missing
shebang (npx fails with an exec format error), a missing `repository` field
(provenance is rejected at the last moment), tests or fixtures in the tarball,
and — the one that cannot be undone — a `.env` or `.npmrc` shipped inside it.

**The image runs as a non-root user, installs with `--ignore-scripts`, and has
no port.** It is a stdio server: it needs `-i`, must not be given `-t`, and
never needs root to read a public register.

## Consequences

Publishing requires a `repository` field that matches the GitHub repository.
Until one exists, `npm run release:check` reports "not ready to publish" and
prints the exact JSON to add. That is deliberate — the check is the reminder,
and it is better than a placeholder that ships wrong.

Source maps and declaration maps are not published. They point at `src/`,
which is not in the tarball, so they were half its size and pointed nowhere.
Dropping them took the package from 96 files and 336 KB to 50 files and
214 KB. Anyone debugging should be reading the repository.

**The name.** `companies-house-mcp` was taken, so this publishes as
`companies-house-screening-mcp`. The longer name is not a consolation prize: it
says what distinguishes this one, which is what somebody choosing between the
two actually needs to know. The README opens by naming the other package and
saying which to use when — a project that quietly implies it is the only one is
misleading its own users on the first line.
