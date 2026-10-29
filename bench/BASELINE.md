# R0-05 — Original bridge baseline

[baseline-9a1b4c6.json](baseline-9a1b4c6.json) measures the original extension engine from
`9a1b4c6df6a4785a66186dd49f62f3bd49fbbe90`. The current worktree supplies only the harness.
Original runtime/build inputs are checked byte for byte against Git; the only declared change is
the archived offscreen WebSocket port, from 8765 to 55861, to isolate the historical bridge.

The source archive, verified original inputs, endpoint patch, original executable, extension tree,
harness Go inputs/executable, Chrome executable and official ZIP have SHA256 provenance. Tree hashes
sort relative paths and hash UTF-8 `path + NUL + file SHA256 + newline` records. Harness inputs include
non-test Go files plus `go.mod`/`go.sum`; no clean-worktree claim is made for that instrumentation.
The original executable uses `-buildvcs=false` to avoid inheriting the parent's dirty VCS metadata.

No injected page core exists at the original commit. Its idle counterpart is explicitly named
`bridge-idle`; future page-core memory/idle, resume, checkpoints, recovery, flow conformance and
tokens per successful agent task remain unavailable. The original extension lacks a per-method CDP
counter, so no count is inferred. R0-S4 remains a separate current harness probe, not an original
bridge connect measurement. Hosted Linux CI remains unverified.

The local snapshot latency over 200 commands is p50 **88.582 ms**, p95 **135.601 ms**. Each 80-row text
view is 2,692 bytes / 886 o200k tokens. Renderer CDP CPU p50/p95, as percent of one logical core, is
0 / 0.222 for Chrome-only, 0.708 / 0.831 for bridge-idle, and 25.419 / 27.006 for bridge-query. These
are baseline observations subject to the CPU counter caveat below, not an optimization or task-success
result. The old daemon remains present during both bridge scenarios.

## Measurement contract

- Chrome for Testing 155.0.8059.84, Windows amd64, headless, owned profiles and ephemeral debugging
  ports. The [official metadata](https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json)
  identifies the distribution; the report pins actual version, download URL and hashes.
- One static loopback page: 100 inventory rows, 101 controls, no page JavaScript/external assets.
  Scenarios allow the same built-in component extensions, whose worker manifests are inventoried
  during setup. Only bridge scenarios load the archived BrowserControl extension.
- A short page-session trace maps the exact main frame URL and frame ID to renderer PID.
  Browser-target tracing can emit empty frame metadata;
  [Chromium's handler](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/devtools/protocol/tracing_handler.cc)
  associates it with a page's WebContents. Protocol processing stays inside `driver/cdp`.
- Tracing stops and the setup page session detaches before sampling. Every sample verifies one
  matching page, attachment state, renderer membership in `SystemInfo.getProcessInfo`, and Windows
  executable path, browser parent PID and stable process creation time. PID reuse, page replacement,
  counter rollback or attachment drift rejects a sample.
- Ten sequential windows per scenario, with a fresh profile per scenario, rather than per window.
  Bridge setup runs three snapshot warmups and settles for one second. Idle windows last two seconds.
  Each query window runs 20 independent original CLI processes with
  `snapshot --limit 80 --tab <fixture> --no-autostart`: 200 measured successful commands overall.
- One root browser socket is measurement infrastructure. Inventory/attachment checks are outside
  the CPU interval; two process-info reads bracket it. Monitoring overhead is not subtracted.
  Host counts cover the owned bridge after transient CLI children exit, excluding the runner.
  Warm attachment is measured before the old three-minute lease expires; no cold-idle observer/cache
  or ten-minute memory measurement is claimed.
- CDP CPU is cumulative seconds; percent is `delta / wall seconds * 100` of one logical core.
  QPC supplies monotonic wall intervals. Windows process times retain raw 100 ns units and a separate
  OS bracket window. Raw process-cycle counts are retained without conversion to seconds.
- CDP and `GetProcessTimes` deltas disagree materially on this host's short bursts. PID verification
  does not establish agreement between CPU counters. Chromium has used a
  [cycle-based Windows CPU implementation](https://chromium.googlesource.com/chromium/src/+/refs/tags/137.0.7122.1/base/process/process_metrics_win.cc),
  but that reference alone does not establish the cause/calibration for this binary and host.
  Investigate before setting CPU budgets; these readings do not demonstrate an overhead reduction.
- Command time spans process launch through successful wait with stdout drained, including launch,
  IPC, rendering and pipe handling. It does not split time to the first CDP response. Exact text bytes,
  hash and ordinary-text `o200k_base` counts are computed after the CPU interval. Raw page output,
  auth tokens, profile paths, execution contexts and remote objects are not published.
- Nearest-rank p50/p95 summaries are checked against raw samples. With ten CPU samples, p95 is the
  maximum. Zero idle deltas are below that counter's observed resolution, not proof of zero overhead.
  Sequential fixed ordering is not a significance test.

## Reproduce on Windows

Live OS cross-checking currently supports Windows only; offline report validation runs on all
platforms. Ordinary tests never download or start a browser. Use a new output path: the runner refuses
to overwrite reports or take over occupied bridge ports. From the repository root:

```powershell
$benchRoot = Join-Path (Get-Location) 'data/r0-05-repro'
New-Item -ItemType Directory -Path $benchRoot -ErrorAction Stop
$benchSource = Join-Path $benchRoot 'source-9a1b4c6'
New-Item -ItemType Directory -Path $benchSource -ErrorAction Stop
$benchArchive = Join-Path $benchRoot 'source-9a1b4c6.tar'
git archive --format=tar -o $benchArchive 9a1b4c6df6a4785a66186dd49f62f3bd49fbbe90 cli app packages assets package.json bun.lock turbo.json biome.json .gitignore .gitattributes
tar -xf $benchArchive -C $benchSource
$benchEndpoint = Join-Path $benchSource 'app/extension/entrypoints/offscreen/main.ts'
$benchText = [IO.File]::ReadAllText($benchEndpoint)
if ($benchText.Split('ws://127.0.0.1:8765').Count -ne 2) { throw 'Unexpected endpoint count' }
[IO.File]::WriteAllText($benchEndpoint, $benchText.Replace('ws://127.0.0.1:8765', 'ws://127.0.0.1:55861'), [Text.UTF8Encoding]::new($false))
Push-Location $benchSource
bun install --frozen-lockfile
bun run build
Push-Location cli
go build -buildvcs=false -o ../../browsercontrol-9a1b4c6.exe .
Pop-Location
Pop-Location
```

Retain the official ZIP beside the extracted `chrome-win64` directory. Collected ZIP SHA256:
`507f2a031441d10c62b5e3d4e863f09ac1198a571c1419976cbd8387f639afde`; executable SHA256:
`a2ae305da79e701af793b667c1ca3d87383729040596264e52f51259d7966413`.

```powershell
$benchChromeRoot = Join-Path $benchRoot 'cft-155.0.8059.84'
New-Item -ItemType Directory -Path $benchChromeRoot -ErrorAction Stop
$benchZip = Join-Path $benchChromeRoot 'chrome-win64.zip'
Invoke-WebRequest 'https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.84/win64/chrome-win64.zip' -OutFile $benchZip
Get-FileHash $benchZip -Algorithm SHA256
tar -xf $benchZip -C $benchChromeRoot
Push-Location cli
go build -o ../data/r0-05-repro/bench-baseline.exe ./cmd/bench-baseline
Pop-Location
& (Join-Path $benchRoot 'bench-baseline.exe') -root . -chrome (Join-Path $benchChromeRoot 'chrome-win64/chrome.exe') -source $benchSource -bridge (Join-Path $benchRoot 'browsercontrol-9a1b4c6.exe') -extension (Join-Path $benchSource 'app/extension/.output/chrome-mv3') -archive $benchArchive -out (Join-Path $benchRoot 'baseline.json')
```

The runner uses its explicit loopback bridge port, a random child-only token and isolated
`BROWSERCONTROL_HOME`, and pins pairing to the benchmark extension's manifest/ID. It closes only the
Chrome/bridge processes it launched. Profiles remain under ignored `data/r0-05/run-*` for inspection;
the harness never recursively deletes browser data. The user's extension build/browser needs no reload.

The repository cleanup on 2026-10-16 removed the local `data/r0-05/` download, archived working copy,
profiles, executables and duplicate reports after measurement. The published JSON and verification
logs remain; use the commands above to recreate the isolated inputs before another live run.
