# BrowserControl

An on-demand Go CLI for browser automation through direct CDP. Each command connects to Chrome,
performs its work, saves durable state when needed, and exits. Chrome keeps its own profile and login state.

The repository is mid-migration from the legacy extension bridge to direct CDP.

## Install

Download the archive for your OS/arch from
[GitHub Releases](https://github.com/hydra07/browser-control/releases), extract it and put
`browsercontrol` (`browsercontrol.exe` on Windows) on your `PATH`. Check with `browsercontrol version`.
Each release also attaches the Chrome extension zip (only needed for the legacy `extension` adapter)
and `checksums.txt`.

Releases are cut by pushing a `vX.Y.Z` tag that matches `app/extension/package.json`'s version
(`bun run --cwd app/extension version:bump -- patch`, commit, then `git tag vX.Y.Z && git push --tags`).

## Build from source

```bash
cd cli
go build -o browsercontrol.exe .
```

Use `./browsercontrol` as the binary name on Linux/macOS. No extension, token or bridge is required
for the direct commands below.

On Windows, rebuild the actual `cli/browsercontrol.exe` used by your shell wrapper. An old binary
can still advertise/start an unprefixed `serve` process even after the source has migrated. The current
default CLI rejects `serve`/`server`/`bridge` with exit 2 and never starts a bridge automatically.

The basic agent loop uses the default commands directly. `open` starts or reuses an owned Chrome
profile automatically; use a node ID actually returned by your snapshot:

```bash
browsercontrol open https://example.com
browsercontrol snapshot
browsercontrol click <id-from-snapshot>
browsercontrol fill <field-id> "text"
browsercontrol wait "expected result"
browsercontrol screenshot
browsercontrol tabs
```

Each invocation exits after its work. `click`, `type`, `fill`, `press` and `scroll` acknowledge input;
use `snapshot`, `read` or `wait` to verify the page effect. `--snap` appends a fresh observation.
Node IDs survive separate CLI processes within one document, but old IDs are rejected after
navigation or physical DOM replacement. Snapshot covers the main document and open shadow roots;
iframe traversal and full vNext semantic/resume/Flow features remain separate work. See
[direct agent commands](docs/DIRECT_AGENT.md) for targeting, policy and unknown-action recovery.

```bash
browsercontrol browser start --profile agent --session-id work
browsercontrol browser status --session-id work
browsercontrol browser stop --session-id work
```

`start` launches installed Chrome with an ephemeral loopback debugging port and a dedicated profile
under `~/.browsercontrol/profiles/<name>`. Repeating it reuses a verified running browser.
Add `--executable <path>` to select an installed Chrome, or `--headless` for unattended execution.
The default profile is `agent`; a session remembers the profile selected by its successful start.

`stop` requires the session's saved browser binding and checks the browser ID, PID, OS process start
identity and exact live user-data-dir before issuing one shutdown request. It preserves the profile.
It refuses to close a process without matching ownership. A failed or uncertain shutdown is never replayed.

Session state is stored under `~/.browsercontrol/sessions/<id>/session.json`. Select a session with
`--session-id`, then `BROWSERCONTROL_SESSION_ID`, or use the default `go-cli`.
`BROWSERCONTROL_HOME` overrides the root directory. Session policy controls read/act/eval capabilities;
arbitrary eval is disabled by default in the new policy model. No general-purpose direct eval command
is exposed yet.

## Current migration status

`open`, `snapshot`, `click`, `type`, `fill`, `press`, `scroll`, `read`, `wait`, `tabs` and `screenshot`
now work directly, alongside `browser start/status/stop` and developer tools. Attach to the user's
existing Chrome remains gated on R0-S3/S6 endpoint and consent measurements. Commands outside this
implemented set fail explicitly and never contact the bridge.

`extension serve` remains the explicit legacy adapter's foreground bridge for its older advanced
commands and Flow v2 implementation. The basic agent loop above does not use it.

`--json` emits one JSON object per invocation, including errors. Compact text is the default.
Exit codes are 0 for success, 1 for command errors, and 2 for usage errors.

## Developer fixtures

From this worktree, use an already started agent session to collect sanitized DOM, accessibility and
frame observations. Built-in pages run locally, including a React admin, a long article, a virtualized
table, a live dashboard, forms, dialogs, nested frames and open/closed shadow roots.

```bash
browsercontrol dev dump-fixture fixture:react-admin --session-id work
browsercontrol dev dump-fixture https://example.com/ --session-id work --out data/fixtures/public/example.json
browsercontrol dev dump-fixture --help
```

Public collection navigates in a new anonymous browser context, then disposes it. It never reuses
the agent profile's cookies or storage. A URL must be HTTP(S), without userinfo, credential query
fields or fragments. Choosing public collection is a declaration to review the resulting content;
an anonymous page can still contain private data supplied by its URL.

To capture an authenticated page, open it in the owned agent profile, then explicitly read its exact
existing URL with `--allow-private`. This command does not navigate or close that page. Use
`--target <id>` if multiple pages match. Private output is confined to gitignored
`data/fixtures/private/`; it cannot be written to versioned fixture directories.

```bash
browsercontrol dev dump-fixture https://app.example.test/orders --allow-private --session-id work
```

Only a file path, classification and counts reach stdout. Defaults are 20,000 combined DOM/AX nodes,
32 frames, a 16 MiB transport message and a 30-second command deadline. Set `--max-nodes`,
`--max-frames` or `--timeout` to lower limits or use the bounded maxima described by help. Files are
sanitized before publication, written without overwriting an existing destination, and marked
`snapshot_at`: DOM and AX are sequential observations, not a settled atomic checkpoint. Truncation
and missing frame coverage are explicit. [Fixture documentation](fixtures/README.md) describes the
schema, corpus and reproduction commands.

## Renderer benchmark

Run the offline benchmark against the ten versioned capture fixtures, or select a capture/directory:

```bash
browsercontrol dev bench-render
browsercontrol dev bench-render fixtures/synthetic/captures/form.json --encoding cl100k_base
browsercontrol dev bench-render --runs 20 --warmup 3 --limit 80 --json > data/render.json
browsercontrol dev bench-render --help
```

This command needs no Chrome, extension or saved session. It replays the legacy flat AX projection
in Go and uses the same compact renderer/filtering as `extension snapshot`. Reports contain counts,
hashes and timings; page text and live handles stay out of stdout. The default BPE encoding is
`o200k_base`; `cl100k_base` is also available, with vocabularies embedded in the Go build.

Bytes and tokens cover exact UTF-8 output, including the final newline. JSON v1 separates projection,
agent rendering and JSON encoding, records p50/p95 and clock overhead, and identifies the fixture and
executable by SHA256. Windows uses QueryPerformanceCounter for the short measured stages. The full
schema, comparison rules and smoke report are described in [benchmark notes](bench/README.md).

The original bridge's isolated Chrome for Testing baseline, CPU/latency measurement limits and
Windows reproduction commands are in [baseline notes](bench/BASELINE.md). Output token counts do not
measure tokens per successful agent task.

The legacy projection and renderer clip text; `projectionTextTruncated` identifies collector text-run
clipping. These measurements do not establish task success, safe semantic identity, Chrome renderer
CPU or a complete token/performance baseline.

The existing extension adapter is isolated behind `browsercontrol extension <command>` (`ext` alias).
Its setup and older command/Flow v2 contract are documented separately in
[Legacy extension adapter](docs/LEGACY_EXTENSION.md) and [Legacy workflows](docs/WORKFLOWS.md).
The legacy `cdp` debug command still uses the previous Rod implementation and is not the vNext driver.

## Development

See [AGENTS.md](AGENTS.md) and [Chrome E2E instructions](cli/e2e/README.md).

Versioned fixtures follow [the data classification policy](docs/PRIVACY.md). Keep reviewed text under
`fixtures/synthetic/` or `fixtures/public/`; private captures stay in ignored local storage. After staging
fixture changes, run `go run ./cmd/check-fixtures -root ..` from `cli/`. CI checks the same index blobs
for private paths, storage/pixel captures and credential patterns without printing fixture contents.
