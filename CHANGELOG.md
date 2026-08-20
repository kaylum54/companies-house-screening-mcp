# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- HTTP client for the Companies House public data API with basic-auth key
  handling, per-request timeouts and jittered retry on 429 and 5xx.
- Sliding-window rate limiter sized to the documented 600 requests per five
  minutes, with a configurable safety margin and optional tightening from the
  undocumented `X-Ratelimit-*` response headers.
- Two-layer response cache (memory and disk) with per-resource TTLs and
  conditional revalidation where the API returns an HTTP `ETag`.
- Typed error model. Every failure carries a stable code, a plain-language
  message and a next-step hint rather than surfacing a stack trace.
- Company number normalisation, including zero-padding of short numeric input.
- Structured stderr logger. Nothing is ever written to stdout, which the stdio
  transport owns.
