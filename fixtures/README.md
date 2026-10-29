# Versioned fixtures

Keep only reviewed UTF-8 text fixtures under `synthetic/` or `public/`. The directory is a data
classification declaration, not proof that a page is public or that a capture has been sanitized.
`synthetic/business-data.json` contains invented business data for query/privacy regressions.

Credential values must be absent, null, empty or the exact marker `[REDACTED]`. Keep public/synthetic
names, email addresses, addresses and order IDs so semantic query tests remain meaningful.
Remove sensitive URL query parameters, userinfo and fragments before persistence.

Do not commit browser cookies/storage, HAR, screenshots, recordings, binary archives or private
captures here. Real-page captures belong in ignored `data/fixtures/private/`; `private/` and `local/`
subdirectories are also ignored, and CI rejects them even if force-added.

From `cli/`, run `go run ./cmd/check-fixtures -root ..` after staging fixture changes. It checks the
Git index rather than the working copy and does not rewrite or print fixture contents. CI runs the
same command. New untracked fixtures are not checked until staged.

The guard detects defined credential patterns and structured sensitive values. It cannot certify
arbitrary obfuscated content or pixel redaction. Business-data persistence/export policy and broader
runtime artifact privacy remain separate vNext tasks; see [PRIVACY.md](../docs/PRIVACY.md).

## R0-01 capture corpus

`synthetic/captures/` contains ten real-Chrome DOM/AX/frame observations: React admin, long article,
virtualized table, realtime dashboard, dialog, form, three nested frames, open/closed shadow DOM,
duplicate controls and navigation. Inputs and business content are invented. The embedded source
pages live in `cli/internal/devtools/pages/`; they need no external resources or build step.
React 18.3.1 is vendored solely for the admin fixture with its MIT licenses and integrity manifest.
It does not restore React or Side Panel to the extension. The maintenance-only downloader is
`scripts/vendor-fixture-react.go`; run it from `cli/` to re-fetch the pinned official npm archives.
It verifies archive SHA-512 integrity, extracts named files only, and records their SHA-256 hashes.
Ordinary tests and capture commands never download React.

The JSON envelope is schema version 1: `classification`, `sourceURL`, `observation: "snapshot_at"`
and `snapshot`. The snapshot has an opaque observation `epoch`, browser version, frame hierarchy,
DOM documents and accessibility trees. DOM `index`/`parent` retain original positions after omitted
nodes; numeric `handle` values join DOM to AX only within this fixture. These identifiers are offline
evidence, never execution handles to reuse against Chrome. Built-in origins normalize to
`http://fixture.test`; browser-generated IDs and the realtime sample are retained as captured.
These are input fixtures, not deterministic renderer goldens (R0-04).

The adapter reconstructs a whitelist of semantic fields instead of exporting the raw DOM string
table, AX source internals, scripts, styles or comments. It omits `__bc_` overlays and scrubs protected
control values, known credentials reflected elsewhere, credential URL fields, data URIs and token
patterns before data leaves the adapter. Names, emails, addresses and order IDs remain usable.
It never reads cookies/storage or captures screenshots. This is a bounded text-fixture collector,
not the complete R0-10 runtime privacy policy or the R4-19 business-data checkpoint/export policy.

From `cli/`, exercise current Chrome without changing the versioned captures:

```powershell
$env:BROWSERCONTROL_E2E_CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
go test -race -count=1 -v ./e2e -run '^TestChrome(CollectsTenSyntheticFixtures|PrivateFixture)'
```

The initial corpus was generated with `BROWSERCONTROL_FIXTURE_CREATE=1` and
`TestChromeCollectsTenSyntheticFixtures` on Chrome 155.0.8059.79. Creation refuses to overwrite existing
files. For reviewable updates, capture each `fixture:<name>` with `dev dump-fixture --out` to a fresh
local file, compare it to the versioned input, then replace only the intended reviewed fixture.
Ordinary Go tests validate all ten versioned captures without starting a browser; the opt-in Chrome
tests exercise collection, private redaction, anonymous credential isolation and context cleanup.

## R0-02 sequence corpus

[`synthetic/sequences/`](synthetic/sequences/README.md) adds five action sequences and seven resume
scenarios with independent physical-node witnesses, expected ref mappings, content changes and
observation provenance. Ordinary Go tests validate the versioned data; opt-in Chrome tests reproduce
the native actions, disconnected updates, real reload/navigation and owned browser restart.
The corpus is ground truth for later engine work. Production ref allocation, resume and Timeline
remain separate tasks.
