# Chrome acceptance harness — R0-06

Run from the existing Go module (`cli/`). Tests launch only the explicitly configured Chrome binary,
in headless mode with a new temporary profile, disabled extensions, and an ephemeral debugging port.
The endpoint comes from that profile's `DevToolsActivePort`. All pages are embedded synthetic HTML
served on loopback; the harness never attaches to an existing Chrome or starts the extension bridge.

PowerShell:

```powershell
$env:BROWSERCONTROL_E2E_CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
go test -race -count=1 -v ./e2e/...
```

Linux/macOS:

```sh
BROWSERCONTROL_E2E_CHROME=/absolute/path/to/chrome go test -race -count=1 -v ./e2e/...
```

An unset binary skips browser tests during ordinary `go test ./...`. An explicit invalid path fails.
`BROWSERCONTROL_E2E_REQUIRED=1` makes missing configuration fail too; the dedicated Linux CI job sets
it and installs Chrome for Testing. Linux root execution needs `--no-sandbox`; other Linux test
environments can explicitly request it with `BROWSERCONTROL_E2E_NO_SANDBOX=1`.

The suite checks real AX target discovery, input dispatch and DOM effects, execution-context
invalidation on navigation, explicit Runtime exceptions, and disconnect/reconnect without navigation.
Cleanup asks the owned browser to close, waits for its process, and falls back to killing only that
owned process. Temporary profiles and fixture servers are cleaned up afterward.

`TestChromeIsolatedWorldReconnectProbe` logs a JSON `R0-S1` observation containing the Chrome version,
whether the document survived, and whether the named isolated world's sentinel/WeakMap was
rediscovered. Either world-lifetime result is a valid spike observation. This probe uses a small test
sentinel, not the future production page core; it does not settle S3/S6 consent behavior or the full
S1 architecture gate. No latency, CPU, or memory improvement is claimed by these tests.

`TestChromeIsolatedWorldAcrossProcesses` strengthens this with two independent executions of the
compiled test client. The parent disconnects, the writer client initializes and exits, and a fresh
reader client re-discovers the named world and WeakMap. Both clients wait for the prior target session
to detach. The internal `TestWorldProbeClient` entry point skips during ordinary test runs.

The local CDP helper is test-only infrastructure. It is not a second production driver or a change
to the current CLI's control path. Production protocol isolation belongs to R1-01.

`TestChromeCancelledKeyDownIsReleasedAndNotReplayed` uses the production driver through a loopback
fault proxy. It drops one acknowledgement after Chrome processes Shift keyDown, cancels the action,
then checks that keyUp arrived and the next typed `a` has no stuck Shift modifier. A missing response
remains an unknown outcome even when cleanup succeeds.

`TestChromeJournalRetainsIntentAcrossKilledInputProcess` kills owned child clients at J1–D, D–J2,
and after J2. It verifies the real fixture button's effect, surviving intent/outcome, released process
lock and refusal to replay while uncertain. It does not test power loss, Timeline/checkpoint commit
or compaction; those belong to R5-16/R5-17. Helpers skip outside their explicitly configured children.

`TestChromeCollectsTenSyntheticFixtures` exercises the R0-01 production collector against ten embedded
pages, including real React, nested frames and shadow DOM. It verifies DOM/AX coverage, sanitized file
publication and disposal of the created target/browser context. Browser background targets may change
independently, so cleanup checks the created target and context identities instead of a global count.
`TestChromePrivateFixtureRedactsSecretsAndPublicContextHasNoProfileCredentials` seeds a temporary owned
page with fake password/OTP values and a cookie, verifies private redaction and retained business data,
then proves anonymous collection does not reuse the cookie or navigate/close the private page.

The CLI package also has opt-in real-Chrome acceptance coverage for fixture output, read-only private
collection, anonymous-navigation permissions and cross-session tab-lease exclusion. Run
`go test -race -count=1 ./...` with the Chrome environment to include it; the Chrome CI job does this.
See [fixture corpus instructions](../../fixtures/README.md) for the versioned captures and regeneration.

`TestChromeActionAndResumeSequences` reproduces R0-02 ground truth: five two-step native action
sequences and seven resume scenarios. Each capture/action opens and closes its own CDP session.
Offline mutations wait on a loopback HTTP barrier released after all command connections close;
completion is acknowledged over HTTP before reconnect. Warm/cold cases verify intermediate observer
history or its absence. Restart closes only the owned profile, checks a fresh browser/process identity
and explicitly reopens the fixture URL. The corpus reader checks declared physical identity, content
and coverage without invoking the existing semantic engine. See the
[sequence contract](../../fixtures/synthetic/sequences/README.md) for limitations and reproduction.
