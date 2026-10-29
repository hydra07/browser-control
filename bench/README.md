# BrowserControl measurements

Reports describe their executable, browser, OS, workload and limitations. A dirty-worktree spike is
not a baseline of the source commit, and a test-harness handshake is not production page-core timing.

R0-05 now has an [original bridge baseline](baseline-9a1b4c6.json), with its measurement contract,
CPU counter caveat and isolated Windows reproduction in [BASELINE.md](BASELINE.md).

## R0-04 — Offline renderer benchmark

Build from `cli/`, then run from the repository root:

```powershell
go -C cli build -o ../data/build/browsercontrol-r0-04.exe .
./data/build/browsercontrol-r0-04.exe dev bench-render --json > data/render.json
./data/build/browsercontrol-r0-04.exe dev bench-render fixtures/synthetic/captures/form.json --limit 0 --encoding cl100k_base
```

The default input is `fixtures/synthetic/captures/`, discovered from this worktree. An explicit file
or directory works without worktree discovery. Directories are sorted and scanned non-recursively;
only capture JSON is accepted. Sequence files and private classifications are rejected. Privacy and
strict schema checks happen before timing. No browser, bridge, session store, Bun runtime, network or
model call participates in the command.

The two versioned pipeline identifiers describe different pieces:

- `legacy-flat-ax-go-v1`: an offline Go replay of the legacy extension's AX filtering, redundant-label
  suppression and bounded text-run merging, using neutral sanitized capture types. Each observed frame
  is measured separately, so repeated frame-local AX/backend IDs cannot merge across frames. It does
  not measure JavaScript collection or a future page core.
- `legacy-flat-cli-v1`: the actual Go compact snapshot formatter plus the shared `extension snapshot`
  output view, including grep, limit, omission text, quoting and text caps. Tests compare benchmark
  bytes/hashes with actual CLI stdout for both formats, including `<`, `>`, `&`, quotes, filtering and
  empty matches. JSON is the same visible snapshot envelope with rendered lines, not a full raw tree.

The tokenizer is pinned in `cli/go.mod` to
[tiktoken-go/tokenizer v0.8.1](https://github.com/tiktoken-go/tokenizer/tree/v0.8.1).
Its vocabularies initialize only when the benchmark requests them; ordinary browser commands do not
load them. Counts use real ordinary-text BPE with the selected `o200k_base` or `cl100k_base` vocabulary.
The public [OpenAI reference vector](https://github.com/openai/tiktoken/blob/main/tests/test_simple_public.py)
is checked, alongside multilingual round trips, count/encode agreement and literal special-token text.
There is no model alias guessing, special-token interpretation, chat/tool wrapper count or estimate
for another provider's tokenizer.

### JSON v1 and comparison rules

`schemaVersion`, `projection`, `renderer`, tokenizer identity and `config` identify the workload.
`filterSha256` identifies the exact grep string without echoing it. `environment` records Go/OS/arch,
CPU count, GOMAXPROCS, selected build/VCS settings, executable size and SHA256. A dirty VCS marker must
not be described as a clean source-commit baseline.

Each sorted `cases` row identifies a fixture hash and observed `frameIndex`, with input bytes, raw
DOM/AX counts, input truncation and missing-frame coverage. `projectedNodes` counts the collector's
output; `renderedNodes` counts rows after CLI text merging; `shownNodes` and `viewFiltered` describe
the requested view. `agent` and `json` each contain exact UTF-8 bytes, BPE tokens and output SHA256.
Both include the final stdout newline. HTML escaping is disabled exactly as in the real CLI.

Defaults are 20 measured runs after three warmups. `timings` reports sample count, min, nearest-rank
p50/p95 and max in nanoseconds:

| Stage | Included work |
| --- | --- |
| `projection` | Go flat AX replay and conversion to renderer inputs |
| `agentRender` | Actual compact formatter, grep/limit, text view/envelope allocation and stdout newline |
| `jsonEncode` | Encode that visible envelope, including its stdout newline |
| `pipeline` | All three stages together; it includes both output formats |

Fixture I/O/validation, executable hashing, tokenizer initialization/counting, output verification,
report encoding and stdout I/O are excluded from the timed intervals. Payload hashes and node counts
must agree across measured runs; nondeterminism fails the command. Timings naturally vary; comparing
counts requires identical fixture hashes, filter hash, limits, encoding and pipeline versions.

The initial Windows run exposed zero-duration samples with the available Go clock. Windows therefore
uses [QueryPerformanceCounter](https://learn.microsoft.com/en-us/windows/win32/api/profileapi/nf-profileapi-queryperformancecounter),
recording its frequency. Other platforms use Go's monotonic clock. `clockReadOverhead` measures 128
empty intervals; overhead is reported and is not subtracted from stage timings. Nanosecond units do
not imply nanosecond precision, and short-stage differences need repeated runs on the same host.

Resource bounds are 64 files, 16 MiB/file, 64 MiB/corpus, 100,000 combined DOM/AX nodes per capture,
250,000 per corpus, 256 observed frame trees and 1 MiB per rendered payload. Runs are bounded to
10–1,000, warmups to 0–100, and `--timeout` to at most 120 seconds. A failed run emits one normal CLI
error, never partial benchmark rows or page contents. Use `--json` and ordinary output redirection to
save metrics; `--out` remains exclusive to fixture capture.

### Local smoke report and limits

[render-smoke-windows.json](render-smoke-windows.json) records the current dirty Windows worktree,
20 runs/three warmups, the default 80-row view and `o200k_base`: ten capture fixtures, twelve observed
frame cases. Its exact output totals are:

| Format | Bytes across 12 outputs | Tokens across 12 outputs |
| --- | --- | --- |
| Agent text | 3,456 | 1,021 |
| Visible JSON envelope | 4,508 | 1,324 |

These are representation measurements of the same clipped view. They do not measure a successful
agent task or demonstrate an optimization. The long article in particular has 907 raw AX nodes but
only four projected rows: legacy text-run merging clips its text at 500 UTF-16 units, which is exposed
as `projectionTextTruncated:true`. The formatter also caps names at 160 runes, values at 80 and further
merged text at 300. `--limit 0` removes the row cap; it does not remove these legacy text caps.

The five R0-03 known identity failures remain, and production direct snapshot/actions, the R4-12
multi-model/task comparison and full renderer goldens remain separate tasks. The R0-05 original bridge
baseline is linked above. This smoke report is not `baseline-9a1b4c6.json`, Chrome renderer CPU, command startup latency,
zero idle overhead or evidence that low-capability agents can complete tasks reliably.

## R0-S4 — Connection spike

R0-S4, on an explicit local Chrome executable:

```powershell
cd cli
$env:BROWSERCONTROL_E2E_CHROME = '<Chrome executable>'
$env:BROWSERCONTROL_E2E_REQUIRED = '1'
$env:BROWSERCONTROL_E2E_BENCH = '1'
$env:BROWSERCONTROL_E2E_BENCH_OUT = Join-Path (Resolve-Path '../bench') 'connect-spike-windows.json'
go test -count=1 -run '^TestChromeConnectLatencySpike$' -v ./e2e
```

Run latency measurements without race instrumentation. Cold discovery means no cached target ID;
the browser and OS are already running. Warm target uses a known ID. Both open a new WebSocket from
a fresh process and run the same tiny named-world sentinel handshake. Ten samples per mode are
reported with nearest-rank p50/p95. No test enforces an unmeasured latency threshold.
