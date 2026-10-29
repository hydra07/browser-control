# Data classification and fixture policy

R0-09 defines the vNext I7 boundary and enforces the versioned-fixture gate. This is not a claim
that the current legacy adapter or future collectors already implement every boundary below.

## Classes and boundaries

| Class | Examples | Collection/query | Persistence and export |
| --- | --- | --- | --- |
| Secret | Password/passphrase, authentication token, API key, website session credential, OTP/PIN, card number, CVV/CVC, authorization/cookie header, private key | Omit the value or replace it with `[REDACTED]` at the earliest collection boundary; never use it as semantic identity | No plain value or hash; user policy and `--allow-private` cannot disable this rule |
| Business data | Email, person's name, address, order ID | Retain for semantic queries, such as finding a customer row by email | R4-19 applies per-origin `plain`, `hash` or `mask`; intended defaults are checkpoint `hash`, external report `mask` |
| Structural/operational | Role, enabled state, document epoch, tool-generated action/session correlation ID | Keep the minimum needed for deterministic control and recovery | Bounded metadata; never persist command-local CDP object/context handles |

Website session credentials are secrets; a BrowserControl-generated correlation ID is operational
metadata. Classification depends on the source, not a blanket rule deleting every ID, number or
email. A password field's label remains queryable, while its value must not leave the collection
boundary. Empty/unset values and the exact marker `[REDACTED]` are safe; changing a secret's key
name or encoding it does not authorize collection.

The Go `internal/privacy` helper classifies known field names, normalizing case and separators.
It sanitizes fixture source URLs by removing userinfo, secret query parameters (including encoded
names), and fragments. It preserves business query parameters. Malformed URLs fail without echoing
their contents. R0-01 now wires it into the direct-CDP fixture adapter. The legacy extension and
future page-core/checkpoint/report paths still require their own integration.

## Collector contract

R0-01 sanitizes AX values and a semantic projection of DOM data inside the Go adapter before any
file/log output. It excludes raw string tables, AX source internals and script/style/comment text.
Protected field values and credentials found in URLs are also scrubbed from reflected text. The
bounded file gate runs before publication; arbitrary CDP error messages are not printed by the collector.
Page-core DOM collection must apply the same classification before returning
data. This includes protected/password fields, autocomplete credentials/card/OTP values, sensitive
headers, labelled credentials in visible text and recognized token formats. Raw AX/DOM string tables
and encoded/obfuscated content require source-aware handling; renaming a dump as public is insufficient.

Never dump cookies, localStorage, sessionStorage, IndexedDB or a browser storage-state export into
fixtures. Do not persist a raw protocol transcript or arbitrary error string that may carry input
text. `dev dump-fixture --allow-private` authorizes local capture of business data from an existing
authenticated page in the owned agent profile. It still redacts secrets and restricts output to
gitignored `data/fixtures/private/`. Default public collection uses a disposable anonymous context
and does not reuse profile cookies/storage. Classification still requires review of the resulting text.

Per-origin policy in `~/.browsercontrol/policy.toml` is the R4-19 deliverable, not a working setting
introduced here. Live business values remain available for query while checkpoint/report projections
apply policy. Do not document these configuration defaults as enforced until that integration passes.

## Fixture gate

Versioned data belongs under `fixtures/synthetic/` or `fixtures/public/`. Fixtures must be reviewed
synthetic/public data; synthetic credential test cases use masked values in versioned fixtures.
Negative scanner vectors are constructed inside test-owned temporary Git repositories.

The gate:

- Reads Git index blobs, not working-tree file contents. It catches staged secrets even if an
  unstaged edit replaces them with masked text; untracked private captures are not read.
- Rejects private/local directory components, unclassified fixture paths, symlinks/submodules,
  browser-storage filenames/fields, binary captures, HAR and unsupported formats. Initially only
  UTF-8 JSON, HTML, SVG, Markdown and text are versioned; raster assets remain local even if synthetic.
- Rejects non-masked sensitive JSON fields, protected/credential control values, sensitive URL
  parameters/userinfo/fragments and defined text patterns: labelled credential assignments, token-like
  Bearer values, decodable Basic credentials, JWTs, common API/GitHub/AWS key formats and private-key headers.
- Checks decoded JSON strings, HTML entities, input/textarea values, duplicate JSON keys, trailing
  JSON and ambiguous credential controls. This is a bounded structural/pattern backstop, not a browser
  parser or proof against deliberate obfuscation. Human fixture review and R0-10 remain necessary.
- Never rewrites fixture data. Reports only a quoted path, optional line and static violation code;
  recognized secret-bearing filenames are hidden. It does not print matches, values or Git blob data.
- Refuses oversized input: 16 MiB per blob, 256 MiB per scan, 10,000 files, 4 MiB index listing,
  200,000 JSON values and depth 128. Reports are capped at 100 findings. The developer command has a
  30-second deadline; budget failure is a failed check, not partial success.

From the repository root:

```sh
cd cli
go run ./cmd/check-fixtures -root ..
```

Run after staging fixture changes. The checker executable exits 0 for a clean index, 1 for unsafe
data or an unreadable index, and 2 for command syntax errors (`go run` wraps nonzero exits). CI runs
it in the Go job on Linux/macOS/Windows.
Ignoring a directory is only convenience: a force-added private fixture still fails the index check.
This gate covers `fixtures/`, not all repository history or every legacy test-data directory. Do not
print a failed fixture to diagnose it; inspect the reported location locally and stage a corrected file.

## Pixels and generated artifacts

Real-page screenshots/video stay local by default under ignored artifact storage. A future report
must mask sensitive field/text regions, mark `contains_unredacted_pixels` when coverage is uncertain,
and require explicit sharing/export intent. A text scanner cannot establish that pixels are redacted;
images are therefore not permitted in versioned fixtures by this gate. Artifact quotas/retention and
the pixel masking/export implementation belong to R5-09 and R7-06.

## Verification scope

R0-09 tests positive business fixtures, credential formats, protected controls, encoded names/strings,
private force-adds, staged/working-tree divergence, index symlinks, bounds, diagnostic non-disclosure
and checker exit codes. R0-01 adds real-Chrome fixture-file redaction, public-context cookie isolation
and retained business data, plus CLI permission/tab-lease coverage. R0-10 still must prove that secrets
do not reach all runtime logs, checkpoints or Timeline, and R4-19/R7-06 must verify policy and pixels. Passing this gate
does not imply those later tasks are complete.
