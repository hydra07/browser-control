# BrowserControl

BrowserControl is a Go CLI for controlling an owned Chrome browser through the Chrome DevTools Protocol (CDP). Commands are short-lived: each invocation connects, performs one operation, and exits. Chrome keeps its profile and login state between invocations.

The default command path uses direct CDP and does not require the extension or a background bridge. The repository also retains a **legacy Chrome extension adapter** for commands and Flow v2 workflows that have not moved to the direct driver.

## Install

Download the archive for your OS and architecture from [GitHub Releases](https://github.com/hydra07/browser-control/releases), extract it, and place `browsercontrol` (or `browsercontrol.exe` on Windows) on your `PATH`.

Each release contains CLI archives and checksums. It also includes the extension ZIP for the legacy adapter; you do not need that ZIP for the direct commands below.

## Build from source

Requires Go matching [`cli/go.mod`](cli/go.mod). To build from the repository root:

```sh
cd cli
go test ./...
go build -o browsercontrol .
```

On Windows, use `go build -o browsercontrol.exe .`. Run `browsercontrol --help` for the current command list.

## Quick start

```sh
browsercontrol open https://example.com
browsercontrol snapshot
browsercontrol click <id-from-snapshot>
browsercontrol fill <field-id-from-snapshot> "text"
browsercontrol wait "expected result"
browsercontrol read
browsercontrol screenshot
browsercontrol tabs
```

Start, inspect, or stop a dedicated browser profile explicitly:

```sh
browsercontrol browser start --profile agent --session-id work
browsercontrol browser status --profile agent --session-id work
browsercontrol browser stop --profile agent --session-id work
```

Use `--headless` or `--executable <path>` with `browser start` or `open` when needed. The CLI launches or reuses a BrowserControl-owned Chrome profile; it does not attach to an arbitrary Chrome debugging port or your existing everyday Chrome. Existing-browser attachment remains out of scope until its endpoint and consent checks are complete.

### Observe, act, verify

- Use IDs returned by `snapshot`. They identify physical nodes in the current document; after navigation or DOM replacement, take a fresh snapshot.
- `click`, `type`, `fill`, `press` and `scroll` report input dispatch/acknowledgement, not proof of a business outcome. Verify separately with `snapshot`, `read` or `wait`.
- `--snap` appends a fresh observation after supported actions.
- `--json` returns structured JSON; compact text is the default.
- Exit codes: `0` success, `1` command failure, `2` usage error.

The direct collector currently covers the main document and open shadow roots, not child-frame traversal or the complete vNext semantic/resume/Flow protocol. Arbitrary JavaScript evaluation is not exposed in the direct command path. See [Direct agent commands](docs/DIRECT_AGENT.md) for targeting rules, safety checks, uncertain outcomes and limitations.

## Sessions and local state

Use `--session-id <id>` to select a session. The environment variable `BROWSERCONTROL_SESSION_ID` can supply the default session ID, and `BROWSERCONTROL_HOME` overrides the local state root.

Browser profiles live under `~/.browsercontrol/profiles/`; session state lives under `~/.browsercontrol/sessions/`. The CLI validates browser ownership before stopping a process and preserves the profile. If an action's outcome becomes uncertain after dispatch, BrowserControl does not replay it automatically; inspect the state and follow the recovery instructions in the direct-agent guide.

## Legacy extension adapter

Use `browsercontrol extension <command>` (alias: `ext`) only for functionality that still depends on the Chrome extension and bridge. It requires an explicitly started foreground bridge; commands do not start one automatically.

Setup, pairing, command coverage and known limitations are documented in [Legacy extension adapter](docs/LEGACY_EXTENSION.md). The older Flow v2 contract is in [Legacy workflows](docs/WORKFLOWS.md). The separate `browsercontrol cdp` command is a legacy/debug path, not the default direct driver.

## Developer tools

Fixture collection and offline rendering benchmarks are available under `dev`:

```sh
browsercontrol dev dump-fixture --help
browsercontrol dev bench-render --help
```

The fixture collector supports synthetic pages and explicit public/private collection modes. Review all output before sharing it; anonymous browsing does not guarantee that a URL contains no private data. Private captures belong in ignored local storage, not version control.

- [Fixture corpus and regeneration](fixtures/README.md)
- [Data classification and fixture policy](docs/PRIVACY.md)
- [Renderer benchmark methodology](bench/README.md)
- [Chrome E2E test harness](cli/e2e/README.md)
- [Repository and agent development notes](AGENTS.md)

## Development checks

From the repository root:

```sh
cd cli
gofmt -w .
go vet ./...
go test -race -count=1 ./...
go build .
```

When changing the extension or shared TypeScript package, also run from the repository root:

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun x biome check app/extension packages
bun run build
```

CI runs the Go checks across Linux, macOS and Windows, a dedicated Chrome E2E job, and extension checks/build.

## Releases

Releases are triggered by pushing a `vX.Y.Z` tag. The tag must match the version in `app/extension/package.json`, because the release also packages the legacy extension. To bump it, run `bun run version:bump -- patch` from `app/extension/`, commit the version change, then create and push the tag. The release workflow builds CLI archives for supported OS/architecture combinations and attaches checksums; it does not publish to the Chrome Web Store.
