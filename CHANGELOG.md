# Changelog

## Unreleased

- `npm publish` now builds and runs the full test suite first through `prepublishOnly`, so a stale
  or missing local `dist/` can no longer be published.
- Desktop and paired profiles can be created again: application copies whose helper bundles carry
  parentheses in their names (`Claude Helper (GPU).app`) are inventoried and cleaned up. Selected
  locations still refuse those characters.
- `open-profile` and the Dock launcher no longer refuse every launch on macOS versions where
  `launchctl getenv` exits 0 for a name that is not set; only names with a value count.
- The launcher-managed update policy is written as `configLibrary/<id>.json`, the name Claude Desktop
  reads. A policy written by 1.0.0 is reported as changed; switch it with `desktop-updates`.

## 1.0.0

Initial release of ben-claude-multi for macOS and Node.js 20 or newer.

Desktop and paired flows are experimental; see README Status.

- Code, Desktop and paired profiles with UUID-based terminal and compiled Dock
  routes, explicit configuration selectors and subscription credential defaults.
- Pinned application verification, private staged copies, metadata tinting,
  conservative version comparisons and confirmed wrong-location process handling.
- Opt-in allowlisted setup import, guarded reference mapping, optional file-backed
  gh configuration, and explicitly selected extension/connector transfer.
- Confirmed rename/removal, kept data by default, retired-path consent, owned update
  policy and launcher repair that preserves unknown bundles and foreign policy.
- Descriptor-checked filesystem operations, identity leases, expected-image
  transactions, conflict-preserving recovery and no successful-operation backups.
- Sibling read rules, live-session notices, read-only health inventory, safe doctor
  repair plans, post-repair audit and local maintenance revision tracking.
- Secret-free account/Git/SSH diagnostics, compiled lock-bound packaging and
  offline production-install validation without runtime dependencies.

Configuration separation is not process confinement. Git/SSH, working repositories,
baseline data and some Claude caches/logs/preferences remain shared. Read permission
denials are enforced; Grep/Glob coverage is best-effort. Effective permission reload,
Dock behavior and external application authentication assumptions require separate
attended evidence for the installed versions. Unknown behavior stays visible rather
than being reported as verified isolation.
