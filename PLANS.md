# BrowserControl Execution Plan

> Canonical implementation plan derived from the repository audit on 2026-09-14.
>
> This file is the execution-safe companion to the product direction in the
> repository README: every phase must be implementable, testable, and reversible.
>
> **Status: active. T0 through Phase 1 and the Phase 1.5 harness are implemented;
> Phase 2 semantic-state/migration code, semantic-ref action wiring, and the
> Phase 3 lifecycle/settle foundation are present with unit coverage. Phase 4
> now has bounded evidence persistence/query, opaque artifact metadata, raw-video
> and event-track separation, and capture flush safety. A manual real-Chrome AGY
> smoke session passed on 2026-09-14; the dedicated integration harness remains
> a separate repeatable gate. Phase 5 now has opt-in capability-profile
> enforcement and per-profile offline token baselines.**

---

## 1. Executive decision

The repository should be modernized in this order, with token economics active
as a Tier-0 constraint across every phase:

```text
T0 token economics, budgets, and no-regression gate
  ├─ Phase 0   freeze, characterize, and baseline
  ├─ Phase 0.5 unit/characterization test foundation
  ├─ Phase 1   security, privacy, and immediate correctness
  ├─ Phase 1.5 real-Chrome integration harness
  ├─ Phase 2   live semantic state and document-scoped refs
  ├─ Phase 3   unified actions and adaptive flows
  ├─ Phase 4   evidence and overlay foundation
  ├─ Phase 5   dedicated token optimization and performance gate
  ├─ Phase 6   optional Rust/native capability spike
  ├─ Phase 7A  BrowserControl self telemetry
  ├─ Phase 7B  web runtime telemetry / PerformanceGraph
  ├─ Phase 8A  page-runtime code intelligence
  ├─ Phase 8B  optional local workspace mapping
  ├─ Phase 9   sidepanel redesign
  └─ Phase 10  research features
```

Do not start with a Rust rewrite, a sidepanel rewrite, or local-repository code
intelligence. Those areas are downstream of contracts that do not exist yet.
Page-runtime code intelligence is a later approved track, but it must not be
collapsed into a local filesystem adapter.

### 1.1 What this plan promises

- Preserve the current control topology:
  `MCP → Bun daemon → WebSocket → MV3 extension → CDP → real Chrome tab`.
- Preserve the six-gateway MCP surface unless a compatibility review explicitly
  approves a breaking change.
- Make destructive or ambiguous browser actions fail closed.
- Make the daemon/extension channel authenticated before adding more remote
  execution features.
- Make persisted data intentionally redacted and bounded.
- Establish behavioral tests and measurements before large abstractions.
- Keep every phase independently reviewable and revertible.

### 1.2 What this plan does not promise

- It does not require Rust.
- It does not replace Bun as the daemon by default.
- It does not introduce Playwright, Puppeteer, Selenium, or a second browser
  into the runtime product. An optional CI test browser may be approved
  explicitly for Phase 1.5; otherwise integration remains local-only.
- It does not expose arbitrary local files or arbitrary executable commands.
- It does not remove CLI-agent chat immediately; its final disposition is made
  after the security boundary is defined.
- It does not make backend DOM ids stable. They remain internal, page-scoped
  implementation details.
- It does not use a runtime `eN` ref as a durable flow locator. Runtime refs and
  persisted flow target descriptors are separate concepts.

## 1.3 Tier-0 token economics

Token efficiency is an architectural constraint, not a late optimization phase.
Every phase and every behavior-changing PR must report its token impact or state
why it is not measurable yet.

The minimum accounting model is:

```text
tool schema tokens
+ instruction/system-prompt tokens
+ tool argument tokens
+ tool response tokens
+ snapshot/delta tokens
+ recovery/retry tokens
+ MCP roundtrips per task
```

Required rules:

- Phase 0 establishes fixed schema/instruction cost and task baselines.
- Phase 1 onward has a `NO TOKEN REGRESSION` gate for changed outputs,
  schemas, instructions, and retry behavior.
- A regression may be accepted only with a recorded reason and a compensating
  product/security/correctness benefit.
- Estimated tokens must identify their tokenizer or heuristic; `chars / 4` is
  not an exact provider-token count.
- Large payloads are returned by reference or progressive disclosure, not by
  silently expanding every default response.
- Capability profiles must reduce exposure by policy, not merely by prompt text.

Phase 5 is dedicated optimization and profile design. It is not the first time
token economics are measured.

Latest offline baseline after the Phase 2–4 contract additions (2026-09-14):
`tool schemas = 43,521 chars ≈ 10,880 tokens` and `instructions = 7,760 chars ≈
1,940 tokens`, using `chars / 4`. The Phase 4 evidence/profile descriptions add
1,565 schema chars (≈391 heuristic tokens) versus the previous 41,956-char
baseline; this is an explicit contract/progressive-disclosure cost deferred to
Phase 5 optimization, not an unexplained regression. Runtime response, delta,
recovery, and roundtrip costs still require the real-Chrome harness and must not
be inferred from this fixed-cost measurement.

---

## 2. Repository baseline

### 2.1 Current architecture

```text
MCP stdio
  ↓
app/server/src/daemon.ts
  ↓ loopback HTTP/WebSocket
app/extension/entrypoints/offscreen/
  ↓ chrome.runtime messaging
app/extension/entrypoints/background.ts
  ↓ chrome.debugger / CDP
Chrome tab owned by the user
```

Important current boundaries:

| Area                                      | Responsibility                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `app/server/src/daemon.ts`                | MCP server, HTTP/WebSocket bridge, command execution orchestration                                           |
| `app/server/src/modules/tools/`           | Six gateway schemas and gateway/action dispatch                                                              |
| `app/server/src/modules/callLog/`         | JSONL call logging and benchmark metadata                                                                    |
| `app/server/src/modules/dataStore/`       | SQLite sessions, docs blocks, flows, token analytics                                                         |
| `app/server/src/modules/cliAgent/`        | CLI-agent process discovery, spawn, streaming, abort                                                         |
| `app/extension/entrypoints/background.ts` | Chrome APIs, debugger attachment, command routing                                                            |
| `app/extension/entrypoints/offscreen/`    | Persistent WebSocket bridge and capture-side work                                                            |
| `app/extension/modules/snapshot/`         | Accessibility snapshot extraction and compact nodes                                                          |
| `app/extension/modules/flow/`             | Flow target resolution and sequential execution                                                              |
| `app/extension/modules/actions/`          | Real mouse, keyboard, scroll, drag behavior                                                                  |
| `app/extension/modules/network/`          | CDP network collection and request details                                                                   |
| `app/extension/modules/recorder/`         | Human interaction recording and tracker injection                                                            |
| `packages/shared/`                        | Dependency-light shared wire contract, including protocol types, runtime constants, and binary encode/decode |

### 2.2 Known baseline

- The last recorded clean baseline typechecked all four packages:
  - `@browsercontrol/server`
  - `@browsercontrol/benchmark`
  - `@browsercontrol/shared`
  - `@browsercontrol/extension`
- The current check is a typecheck, not a browser-control behavioral suite.
- The checkout did not contain a browser-control behavioral suite. Phase 0.5 now
  adds the initial `bun:test` geometry coverage; characterization and real-browser
  integration layers remain separate work.
- CodeGraph is an audit/development tool and must remain outside monorepo
  runtime dependencies.
- `data/`, `skills/`, and `.codegraph/` are ignored today. Phase 0 verifies
  that generated/private indexes remain untracked rather than adding them to
  the repository.

### 2.3 Audit evidence to preserve as regression targets

| Finding                                            | Current location                                  | Required outcome                       |
| -------------------------------------------------- | ------------------------------------------------- | -------------------------------------- |
| Daemon HTTP/WebSocket channel is not authenticated | `app/server/src/daemon.ts`                        | Authenticated requests and upgrades    |
| `/execute` accepts broad command input             | `app/server/src/daemon.ts`                        | Validated command registry and auth    |
| CLI agent accepts arbitrary custom command text    | `app/server/src/modules/cliAgent/index.ts`        | Safe executable/argument policy        |
| Tool args/results may be persisted in cleartext    | `app/server/src/modules/callLog/`, `dataStore/`   | Central redaction and retention policy |
| Recorder captures typed text                       | `app/extension/modules/recorder/trackerScript.ts` | Sensitive-input suppression/redaction  |
| Network headers/bodies may be retained             | `app/extension/modules/network/`                  | Header/body filtering by default       |
| Flow can pick first ambiguous candidate            | `app/extension/modules/flow/index.ts`             | Ambiguity must stop execution          |
| Replay can pick first ambiguous candidate          | `app/server/src/replay.ts`                        | Same fail-closed resolution policy     |
| Snapshot delta key is only role/name               | `app/extension/modules/flow/index.ts`             | Collision-safe revision/ref identity   |
| Binary protocol has unused opcodes                 | offscreen/background protocol paths               | Implement and test, or remove          |
| README/CLI surface may be stale                    | `README.md`, server package scripts               | Documentation and scripts agree        |

---

## 3. Non-negotiable engineering rules

1. **No broad refactor without a test or characterization fixture.**
2. **No network-facing feature without authentication and origin policy.**
3. **No persistence of user-controlled content without redaction policy.**
4. **No ambiguous browser action is executed automatically.**
5. **No backend DOM id is presented as a stable replay identity.**
6. **No new gateway is added to solve an internal implementation problem.**
7. **No production Rust component is added before a measured bottleneck or a
   demonstrated native/data capability boundary justifies it.** A disposable
   spike may be created only after the Phase 6 entry gate is reviewed.
8. **`packages/shared/` may contain dependency-light wire runtime code** such as
   protocol constants, codecs, and validation helpers, but it must not depend on
   application packages or acquire heavy/runtime-domain dependencies.
9. **No absolute machine-specific paths are written into tracked config/docs.**
10. **Every phase must leave the current MCP/extension topology runnable.**
11. **Do not use a shell parser to execute user-provided commands.**
12. **All limits are bounded:** request size, steps, waits, output, artifacts,
    concurrent jobs, and process lifetime.

---

## 4. Phase map and gates

| Phase | Name                                         | Depends on         | Gate                                                                |
| ----- | -------------------------------------------- | ------------------ | ------------------------------------------------------------------- |
| T0    | Token economics and budgets                  | None               | Every phase reports cost and avoids unexplained regression          |
| 0     | Freeze and characterize                      | None               | Behavioral and token baselines exist                                |
| 0.5   | Unit/characterization test foundation        | 0                  | Fast tests run locally and in CI                                    |
| 1     | Security, privacy, and routing correctness   | 0.5                | Unsafe paths fail tests                                             |
| 1.5   | Real-Chrome integration harness              | 0.5, 1             | Controlled extension/CDP smoke tests run                            |
| 2     | Live semantic state and document-scoped refs | 0.5, 1, 1.5        | State/ref/flow compatibility is covered                             |
| 3     | Action engine and adaptive flow behavior     | 2                  | Actions share resolution/risk/settle/event contracts                |
| 4     | Evidence and overlay foundation              | 1, 3               | Capture and visible action feedback are explicit, redacted, bounded |
| 5     | Token optimization and performance gate      | T0, 0.5, 3, 4      | Optimizations are measured against baseline                         |
| 6     | Optional Rust/native capability spike        | 5                  | Performance or native/data boundary justifies spike                 |
| 7A    | BrowserControl self telemetry                | 4, 5               | Product event schema and privacy policy are stable                  |
| 7B    | Web runtime telemetry / PerformanceGraph     | 1.5, 3, 4, 5       | CDP/performance traces are bounded and useful                       |
| 8A    | Page-runtime code intelligence               | 1.5, 2, 5          | Runtime source scope and graph contract are approved                |
| 8B    | Optional local workspace mapping             | 8A                 | Explicit opt-in and filesystem policy are approved                  |
| 9     | Sidepanel redesign                           | 2, 3, 4            | Backend contracts are stable                                        |
| 10    | Optional research features                   | All relevant gates | Separate review required                                            |

The first implementation slice should be **T0 → Phase 0 → Phase 0.5 → Phase 1**.
Phase 1.5 may start only after the auth/privacy policy is accepted. Phase 2 may
start only after the real-Chrome smoke path and migration contract are accepted.

---

# 5. Phase 0 — Freeze and characterize

## Objective

Record what currently works before changing behavior. This phase is intentionally
boring: it creates evidence for later decisions and prevents an architecture
proposal from becoming an unmeasured rewrite.

## Work items

### P0-01 — Inventory public and internal commands

Create a machine-readable inventory from the existing gateway/action enums,
schemas, handlers, and extension command routing.

Record for each command:

- gateway and action;
- internal extension command;
- input fields and defaults;
- output shape;
- whether it mutates browser state;
- whether it captures or persists data;
- whether it requires an attached debugger;
- current error behavior;
- current timeout and concurrency limits.

Likely files to inspect/update:

- `app/server/src/libs/gateways.ts`
- `app/server/src/modules/tools/schemas.ts`
- `app/server/src/modules/tools/handlers.ts`
- `app/extension/entrypoints/background.ts`
- `packages/shared/src/protocol.ts`

Do not create a second hand-maintained action list if the existing enums can be
used as the source of truth.

### P0-02 — Characterize flow and snapshot behavior

Add fixtures for:

- one exact role/name match;
- zero matches;
- two identical role/name matches;
- selector match followed by semantic fallback;
- navigation between flow steps;
- DOM mutation between steps;
- first-step snapshot delta;
- truncated snapshot;
- nested/duplicate accessibility nodes;
- stale backend DOM id.

The fixtures should exercise pure transformation and resolver decisions first.
Chrome-dependent execution can use a fake executor or a narrow adapter.

### P0-03 — Characterize protocol behavior

Add serialization/round-trip fixtures for:

- JSON command requests;
- JSON command responses;
- binary packet framing;
- unknown opcode handling;
- reconnect/disconnect behavior;
- capture-port acknowledgements;
- large-but-valid payloads;
- malformed payloads.

The test should assert bounded failure, not only successful parsing.

### P0-04 — Establish baseline measurements

Capture a small set of repeatable tasks:

1. inspect a page;
2. click a unique button;
3. type and submit a form;
4. run a three-step flow;
5. read selected content;
6. capture a screenshot;
7. run a multi-tab job.

Record the full token cost instead of only the current call-level estimate:

- serialized tool-schema tokens;
- instruction/system-prompt tokens;
- tool argument tokens;
- tool response tokens;
- number of MCP roundtrips;
- snapshot and delta tokens;
- recovery/retry tokens;
- elapsed time;
- retries, stale-ref, and ambiguity events;
- screenshot/artifact bytes;
- daemon memory sample where already available.

Measure fixed schema/instruction cost offline from the exact gateway definitions,
then record per-task cost separately. The existing benchmark data model can be
extended, but every value must identify whether it is an exact tokenizer result
or a heuristic estimate and which baseline it uses.

### P0-05 — Repository hygiene and toolchain baseline

Verify that `.codegraph/` remains ignored and generated indexes stay untracked.
Record the actual Bun version used by local development, `packageManager`,
`.mise.toml`, and CI; this checkout standardizes them on `bun@1.3.14`.

## Exit criteria

- Current command inventory is reviewed.
- At least one fixture exists for every current flow resolution outcome.
- Current protocol behavior is documented by tests.
- Baseline task measurements can be repeated from a clean session.
- Fixed schema, instruction, task, snapshot, and recovery costs are recorded.
- The baseline has an explicit `NO TOKEN REGRESSION` comparison method.
- No behavior change is introduced merely to create the baseline.

## Rollback

Delete only the new fixtures/measurement harness. Existing runtime code remains
unchanged.

---

# 6. Phase 0.5 — Test foundation

## Objective

Make tests a first-class workspace command before modifying security, protocol,
or persisted schemas.

## Proposed implementation

Use Bun's built-in test runner first. Do not add a test framework unless a
concrete missing capability is demonstrated. The initial
`app/server/src/modules/geometry/index.test.ts` suite is now part of the fast
foundation; characterization suites extend it rather than treating the
repository as test-free.

Add:

- root `test` script that runs workspace tests;
- package-level test scripts where needed;
- CI test job using the same pinned Bun version as `packageManager` and local
  development;
- update `.mise.toml` and CI together instead of using `latest`;
- coverage only if it is useful for the pure modules, not as a vanity target;
- deterministic fake clocks where timer behavior is tested;
- fake `Executor` implementations for server modules;
- Chrome API fakes only around small adapters, not as a fake browser.

Suggested test placement:

```text
app/server/src/**/*.test.ts
app/extension/modules/**/*.test.ts
packages/shared/src/**/*.test.ts
```

The fast unit/characterization suite must not launch a real browser. Browser
behavior also requires a separate integration tier; fakes alone are not enough
to validate MV3, Chrome APIs, CDP attachment, navigation, focus, frames, and
rerender behavior.

## Minimum fast suites

| Suite               | Scope                                                        |
| ------------------- | ------------------------------------------------------------ |
| `existing-geometry` | Preserve the current `bun:test` geometry coverage            |
| `shared-protocol`   | Runtime constants, serialization, binary framing, validation |
| `snapshot`          | Compact tree, region tree, truncation, collision cases       |
| `flow-resolution`   | Match count, ambiguity, stale target, fallback policy        |
| `flow-replay`       | Logged descriptor resolution and failure behavior            |
| `tools`             | Gateway/action validation and output limits                  |
| `redaction`         | Secrets, credentials, headers, bodies, screenshot metadata   |
| `daemon-routes`     | Auth, origin, request size, method/path behavior             |
| `cli-agent-policy`  | Allowed executable and argument behavior                     |
| `binary-protocol`   | Framing, unknown opcodes, malformed packets                  |

# 7. Phase 1.5 — Real-Chrome integration harness

Add a separate `bun run test:integration` command. This is a real-browser test
tier, not a second unit-test fake.

### Current implementation

`app/server/src/modules/integration/` now provides a disposable local fixture and
an orchestration harness. It talks to the daemon over authenticated HTTP, checks
invalid HTTP/WebSocket credentials, waits for the versioned extension pairing,
and exercises unique actions, navigation, stale-node rejection, ambiguity
fail-closed behavior, password recorder suppression, tab cleanup, and managed
daemon restart/reconnect. The harness uses Chrome's `/json/version` and
`/json/list` endpoints only for readiness/target checks; it does not become a
second CDP driver.

### Local branded-Chrome mode

Use a dedicated, pre-provisioned Chrome profile where the MV3 extension has been
installed manually once. The harness may launch or attach to that profile using
the supported remote-debugging setup for the installed Chrome version. It must
not assume that `--load-extension` can auto-load an unpacked extension in
branded Chrome; that path is unavailable in current Chrome releases.

This mode uses the user's official branded Chrome and does not require Chrome
for Testing, Chromium, Playwright, Puppeteer, Selenium, or another automation
browser. The setup must document profile location/configuration without
committing an absolute machine path.

### Optional CI browser mode

CI may run the same extension/CDP smoke suite only when the runner provides an
approved, provisioned test browser/profile. Chrome for Testing or Chromium is a
valid CI option if the project explicitly approves that test dependency. If the
project chooses not to use a second browser build, CI runs the fast suite and
integration remains a local branded-Chrome gate; CI must not claim coverage it
does not execute.

The initial smoke suite should cover:

- daemon authentication and extension WebSocket pairing;
- debugger attachment and detach cleanup;
- unique click/type/press-key action;
- navigation and focus handling;
- DOM rerender between snapshot and action;
- duplicate target ambiguity;
- iframe/frame identity where supported;
- recorder password-input suppression;
- screenshot/capture cleanup after disconnect.

Phase 3 cannot be considered complete without real-Chrome smoke coverage in at
least the documented local mode.

## Exit criteria

- `bun test` runs locally from the repository root.
- `bun run test:integration` has documented branded-Chrome profile prerequisites
  and fixture setup.
- The integration strategy explicitly states whether CI has an approved
  provisioned browser; no automatic extension-loading claim is made for branded
  Chrome.
- CI runs fast tests separately from typecheck/lint/build, with integration
  smoke tests scheduled only when its browser prerequisite exists.
- A failing characterization fixture fails the command with a useful message.
- Tests do not depend on a developer's absolute path, installed CLI agent, or
  currently open browser tab.

## Rollback

The test infrastructure is additive. Revert scripts/fixtures independently from
runtime changes.

---

# 8. Phase 1 — Security, privacy, and routing correctness

This is the highest-priority implementation phase.

## 8.1 Authentication contract

### Proposed design

Use a per-daemon bearer token supplied through a local-only configuration
mechanism, with an explicit pairing path for the extension.

Proposed token lifecycle:

1. On first daemon run, generate a 256-bit secret unless an explicit environment
   override is present.
2. Persist the generated secret in a local daemon configuration location owned by
   `configs/paths.ts`; never hardcode it in tracked files or ordinary logs.
3. On later daemon runs, load the same persisted secret. Do not generate a new
   secret merely because the process restarted.
4. The extension stores its paired token in `chrome.storage.local`.
5. HTTP requests send `Authorization: Bearer <token>`.
6. `rotate` explicitly writes a new secret, invalidates the old one, marks the
   extension unpaired, and requires explicit repair.
7. The browser WebSocket API cannot set arbitrary request headers. The offscreen
   client therefore connects normally but remains quarantined until it sends a
   versioned hello object as its first application message:

   ```ts
   {
     type: "hello",
     protocolVersion: 2,
     role: "extension",
     token: "...",
     clientVersion: "..."
   }
   ```

8. The daemon validates the hello within a bounded timeout, compares the token in
   constant time, validates protocol version/role, sends `hello_ack`, and only
   then assigns the socket as `extensionSocket` or accepts commands.
9. WebSocket `Origin` is validated as defense in depth; it is not treated as
   authentication because non-browser clients can forge it.
10. Replay/CLI tooling reads the token from the same local configuration contract.
11. Missing, invalid, or incompatible credentials are rejected before command or
    binary routing.
12. An explicitly named development-only insecure mode may exist temporarily,
    but it must emit a warning and never be the default.

The exact pairing UX is an open review decision. The implementation must not
silently fetch a token from an unauthenticated endpoint, because that would
make the pairing endpoint an authentication bypass.

## 8.1.1 WebSocket connection state machine

The offscreen bridge and daemon must model these states:

```text
DISCONNECTED
    ↓
CONNECTING
    ↓
AUTHENTICATING
    ↓ hello_ack
READY
```

Only `READY` may satisfy `isConnected()` and permit `sendJson()` or
`sendBinary()`. A socket in `OPEN` but not authenticated is not connected for
command purposes. Invalid hello, protocol mismatch, timeout, or close returns
the client to `DISCONNECTED` and schedules the existing bounded reconnect.

The daemon keeps an upgraded but unauthenticated socket quarantined and does not
replace an already-ready `extensionSocket` until the new socket reaches `READY`.

Likely files:

- `app/server/src/daemon.ts`
- `app/server/src/configs/server.ts`
- `app/server/src/configs/paths.ts`
- `app/extension/entrypoints/offscreen/main.ts`
- `app/extension/entrypoints/sidepanel/lib/api.ts`
- `app/extension/configs/settings.ts`
- `app/extension/entrypoints/sidepanel/components/SettingsTab.tsx`
- `app/server/src/replay.ts`

### Acceptance criteria

- Requests without a valid token receive a non-success response.
- Restarting the daemon reloads the same persisted secret; rotation invalidates
  the old secret and requires explicit extension repair.
- Unauthenticated WebSocket connections can never enter command or binary
  routing and are closed after a bounded authentication timeout.
- A socket is not considered connected until the versioned hello receives
  `hello_ack`.
- Token values never appear in normal logs, call logs, benchmark previews, or
  MCP tool output.
- Token comparison and error behavior do not disclose the expected token.
- Existing local development has a documented pairing path.
- A test proves that auth failure cannot reach `executeCommand`.

## 8.2 Origin and request policy

Implement a strict policy for:

- allowed HTTP methods;
- allowed paths;
- allowed extension origin(s);
- local CLI/replay origin behavior;
- maximum body size;
- maximum WebSocket frame size;
- timeout for incomplete requests;
- rate/queue limits where applicable.

Do not use wildcard CORS for authenticated control endpoints. CORS is not a
replacement for authentication; both policies must be explicit.

## 8.3 Endpoint authentication and capability matrix

The HTTP server currently combines sidepanel APIs, command execution, CLI-agent
support, and the read-only chat MCP endpoint. Each endpoint needs an explicit
caller, auth rule, and capability boundary:

| Endpoint       | Caller                     | Auth                      | Capability               |
| -------------- | -------------------------- | ------------------------- | ------------------------ |
| `/execute`     | sidepanel/internal tooling | required                  | command-specific         |
| `/flows/*`     | sidepanel                  | required                  | flow read/write/run      |
| `/metrics`     | sidepanel                  | required                  | metrics read             |
| `/cli-agent/*` | sidepanel                  | required                  | bounded CLI-agent query  |
| `/mcp`         | local CLI agent            | required                  | inspect-only MCP profile |
| `/status`      | health/UI                  | explicit decision         | health metadata only     |
| WebSocket      | extension                  | versioned hello handshake | extension bridge         |

Read-only does not mean public: `/mcp` can expose page content, selected text,
DOM, and accessibility information. It must be authenticated and separately
capability-gated. This implementation keeps `/status` in the required-auth set;
its response is still limited to connection state and version metadata.

The endpoint matrix is enforced before `executeCommand` or MCP tool handling.

## 8.4 Command registry and routing cleanup

Replace broad ad hoc `/execute` acceptance with a validated command registry.
The registry should define:

- command name;
- input parser/validator;
- required capability;
- mutating/read-only classification;
- maximum execution duration;
- whether it is callable by sidepanel, replay, job, or internal code.

Use existing enums where they represent a dispatch domain. Do not scatter new
string literals across switches.

Audit and remove duplicate/unreachable `/execute` branches in
`app/server/src/daemon.ts`. Preserve the existing internal `Executor` pattern
for jobs/crawl/tools; do not make modules import the daemon.

## 8.5 CLI-agent process policy

Current custom command text is not passed directly to a shell: the current
implementation tokenizes it and uses an argument-array spawn. That avoids a
literal shell-injection claim, but it still permits arbitrary executable/path
selection through an unauthenticated request. It must not remain a network-level
arbitrary command selector.

Proposed policy:

- public request selects a known agent id such as `claude` or `agy`;
- executable path is resolved by the server;
- arguments are constructed as an array, never passed through a shell;
- only documented flags are allowed;
- environment is a minimal allowlist;
- working directory is a configured safe directory;
- process lifetime, output size, and child-process count are bounded;
- abort kills the process tree as the current implementation intends;
- arbitrary `customCommand` is removed from the network request shape; the current
  UI setting is translated to an allowlisted `agentId` plus bounded `effort` before
  crossing the daemon boundary.

Likely file:

- `app/server/src/modules/cliAgent/index.ts`

The CLI chat feature may remain, but it must use this policy and must not be a
remote arbitrary-command execution endpoint.

## 8.6 Central redaction and retention

Create a server-side redaction module for persisted server data and a matching
extension-side policy for data captured before it crosses the boundary. Runtime
code must remain in the owning package; `packages/shared/` remains a
dependency-light shared wire contract rather than a general runtime utility
package.

Default redaction targets:

- `password`, `passcode`, `pin`;
- `token`, `secret`, `apiKey`, `accessToken`, `refreshToken`;
- `authorization`, `cookie`, `set-cookie`;
- hidden/password input values;
- network request bodies unless explicitly enabled;
- selected text and page content when a capture profile says not to retain it.

Redaction output must preserve enough metadata to debug the action without
preserving the secret. For example, keep field name and length class, not value.

Apply the policy before:

- JSONL call-log serialization;
- SQLite `args_json` insertion;
- recorder step persistence;
- network request storage;
- screenshot/video metadata storage;
- error previews.

Add retention controls for session logs and artifacts. Cleanup must be bounded
and must not delete active recording/session data.

Likely files:

- `app/server/src/modules/callLog/`
- `app/server/src/modules/dataStore/`
- `app/extension/modules/recorder/`
- `app/extension/modules/network/`
- `app/server/src/daemon.ts`
- `app/extension/modules/capture/`
- `app/extension/modules/screencast/`

## 8.7 Dead protocol surface

For every declared binary opcode:

- implement encode/decode and a real caller;
- add a round-trip and malformed-packet test;
- document compatibility; or
- remove the opcode before another client depends on it.

Do not add more binary opcodes until the existing framing and version behavior
are characterized.

## Phase 1 exit criteria

- Auth, origin, request size, and route tests pass.
- Arbitrary CLI command execution is no longer possible through a remote request.
- Cleartext secrets are absent from persisted logs and default network/recorder
  output in tests.
- Ambiguity behavior is changed to fail closed, with tests, even if the full
  semantic-ref design is deferred to Phase 2.
- Duplicate routing and dead protocol surface are resolved.
- `bun run check`, `bun test`, lint, and relevant build commands pass.

## Rollback

- Keep old and new auth behind a short-lived migration flag only if required;
  default behavior must move toward authenticated mode.
- Keep old persisted records readable.
- Redaction changes are additive to readers and can be disabled only in a local
  test fixture, never in the production default.
- Revert route/CLI changes independently from storage migrations.

---

# 9. Phase 2 — Live semantic state and document-scoped refs

## Objective

Replace accidental page-scoped identifiers and role/name collisions with an
explicit semantic state contract. Runtime refs should survive confident
same-document rerenders, while navigation/document replacement invalidates the
whole document scope.

## 9.1 Snapshot envelope

Introduce a versioned envelope around the current compact snapshot instead of
immediately deleting the existing compact fields.

Proposed shape:

```ts
type DocumentScope = {
  documentId: string; // BrowserControl-owned document epoch
  tabId: number;
  frameId: string;
  loaderId?: string; // observed CDP metadata, not the contract identity
};

interface SemanticSnapshot {
  schemaVersion: 2;
  revision: string; // semantic state version
  scope: DocumentScope;
  url?: string;
  title?: string;
  truncated?: boolean;
  nodes: SemanticNode[];
}

interface RuntimeTargetRef {
  ref: string;
  scope: DocumentScope;
  lastSeenRevision: string;
  confidence: number;
}

interface SemanticNode {
  ref: string;
  role?: string;
  name?: string;
  value?: string;
  parentRef?: string;
  children?: string[];
  internalBackendNodeId?: number;
}
```

The exact field names are subject to review. The invariants are not:

- revision is a semantic state version, not the ref namespace;
- `documentId` is a BrowserControl-owned document epoch and stable contract;
- `loaderId` is observed CDP metadata and may help detect replacement but is not
  itself the wire-level document identity;
- a runtime ref is scoped to a tab/frame/document lifetime;
- a ref may survive a same-document rerender when reconciliation is confident;
- navigation or confirmed document replacement invalidates the document-scoped refs;
- a ref is never silently rebound when reconciliation confidence is insufficient;
- backend DOM ids are internal and page-scoped;
- duplicate role/name nodes remain distinguishable;
- truncated state and identity uncertainty are explicit;
- model-facing output can omit internal ids.

`SemanticSnapshot`, `RuntimeTargetRef`, and their wire encodings belong in
`packages/shared/` only if both daemon and extension consume them. Runtime
reconciliation helpers stay in the owning extension module.

## 9.2 Runtime ref lifecycle and reconciliation

Implement a ref index owned by the live document/frame state, not by an individual
snapshot revision:

- assign compact refs such as `e1`, `e2`, ... within a document scope;
- map each ref to internal target metadata and its last-seen revision;
- reconcile a new snapshot against the previous state using semantic and
  structural evidence;
- update the internal backend-node mapping when reconciliation is sufficiently
  confident;
- preserve a ref across ordinary React/DOM rerenders when identity is proven;
- mark a ref stale/uncertain rather than silently rebinding it when identity is
  not proven;
- reject refs from another tab, frame, document, or loader scope;
- create a new BrowserControl `documentId` only when document replacement is
  confirmed, including relevant BFCache/frame lifecycle handling;
- invalidate all refs on a replaced document scope;
- retain frame identity for iframe targets;
- expose revision changes separately from ref invalidation.

The contract is **document-scoped stable-ish**, not globally stable. `e17` may
map to backend node 881 at revision 41, node 923 at revision 42, and node 941
at revision 43 if reconciliation proves that it is still the same semantic
control. A new loader/document invalidates the mapping.

## 9.3 Durable flow identity is separate from runtime refs

A runtime ref is useful for the current live document and for evidence/debugging;
it is not a durable flow locator. Persist a `FlowTargetDescriptor` instead:

```ts
interface TargetFingerprint {
  role?: string;
  name?: string;
  testId?: string;
  id?: string;
  href?: string;
  inputType?: string;
  inputName?: string;
  ancestors?: Array<{
    role?: string;
    name?: string;
  }>; // max 3
  nearby?: Array<{
    relation: "before" | "after" | "inside" | "label";
    role?: string;
    name?: string;
  }>; // max 4
  selectorHints?: string[]; // max 3
}

interface FlowTargetDescriptor extends TargetFingerprint {
  recordedRuntimeRef?: string;
  recordedRevision?: string;
}

interface FlowStepV2 {
  action: FlowAction;
  target?: FlowTargetDescriptor;
  expected?: ExpectedTransition;
  policy?: FlowStepPolicy;
}
```

`TargetFingerprint` is an allowlist, not an open attribute bag. It must not
capture arbitrary `data-*` attributes, values, page text, or credential-like
fields.

`recordedRuntimeRef` and `recordedRevision` are provenance/debug metadata only.
They must never be the durable identity used to replay a flow on a later page
load or browser session.

Extend the current `FlowStep` contract without making old flows unreadable:

- `schemaVersion` at the flow document level;
- a durable `target` descriptor for newly recorded steps;
- a separate `expected` transition and step policy;
- optional runtime ref/revision provenance only for evidence/debugging;
- existing `role`, `name`, `selector`, and action fields retained during
  migration;
- optional frame/document target metadata;
- explicit target resolution and drift policy.

Migration behavior:

1. Read v1 flows.
2. Build a descriptor from legacy role/name/selector fields where possible.
3. Resolve using the descriptor under the fail-closed ambiguity policy.
4. Write v2 only when the flow is explicitly saved or migrated.
5. Preserve an original backup or immutable source record.
6. Report migration failures instead of silently weakening selectors.

Likely files:

- `packages/shared/src/protocol.ts`
- `app/extension/modules/snapshot/types.ts`
- `app/extension/modules/snapshot/index.ts`
- `app/extension/modules/flow/types.ts`
- `app/extension/modules/flow/index.ts`
- `app/server/src/replay.ts`
- `app/server/src/modules/dataStore/`
- sidepanel flow API/components

## 9.4 Collision-safe delta

Replace the current `role::name` delta key with live-state identity:

- primary key: reconciled runtime ref within the same document scope;
- revision records state changes without creating a new ref namespace;
- fallback identity for unreconciled nodes: structural/semantic path with frame
  context and bounded parent context;
- if identity cannot be proven, report `changed/unknown` rather than claiming
  an exact add/remove;
- include confidence and identity uncertainty when a reconciliation is used.

The delta response must expose truncation, revision, and identity uncertainty
explicitly.

## 9.5 Phase 2 exit criteria

- Snapshot schema version and migration behavior are documented.
- Runtime refs are unique within a document/frame scope and survive only
  confident same-document reconciliation.
- Revision changes do not automatically invalidate refs; loader/document changes
  do.
- Durable flows persist `FlowTargetDescriptor`, not runtime ref as identity.
- Duplicate role/name nodes are independently addressable.
- Flow v1 can still be read.
- Flow/replay tests prove stale, ambiguous, and low-confidence targets fail safely.
- Snapshot delta tests cover collision, rerender reconciliation, and navigation.

## Rollback

Keep a v1 reader and an adapter from v2 snapshots to the current compact output
for one migration period. Do not rewrite existing flows in place without a
backup or version marker.

---

# 10. Phase 3 — Unified ActionEngine and settle behavior

## Objective

Make click/type/key/scroll/drag/flow execution share one lifecycle, while
preserving the real-CDP user interaction behavior already present.

## 10.1 Action lifecycle

Every mutating action should follow this sequence:

```text
validate input
  → resolve target/ref
  → check ambiguity and target risk
  → optional user confirmation policy
  → dispatch real CDP input
  → bounded settle
  → verify expected postcondition when requested
  → classify drift
  → emit ActionLifecycleEvent
  → produce compact result and optional delta
```

The action engine must not bypass existing visual cursor/ripple/highlight
behavior without an explicit fast/background policy.

## 10.1.1 Shared action event boundary

The ActionEngine emits one structured event stream. Overlay and evidence are
consumers, not independent action timelines.

```ts
type ActionLifecycleEvent =
  | {
      type: "action_started";
      actionId: string;
      ts: number;
      action: string;
      targetRef?: string;
      semanticTarget?: FlowTargetDescriptor;
      bounds?: { x: number; y: number; width: number; height: number };
      sensitive: boolean;
    }
  | {
      type: "action_finished";
      actionId: string;
      ts: number;
      action: string;
      durationMs: number;
      result: "succeeded" | "failed" | "blocked";
      targetRef?: string;
      drift?: "EXACT" | "SEMANTIC_REPAIR" | "TARGET_DRIFT" | "BEHAVIOR_DRIFT";
      sensitive: boolean;
    };
```

The engine emits two immutable events with the same `actionId`; it does not
mutate a started event. Overlay starts animation on `action_started`, while
EvidenceRecorder and telemetry correlate it with `action_finished`.

The event is redacted before persistence or model-facing output. It is consumed
by:

```text
ActionEngine
   ↓
ActionLifecycleEvent
   ├── OverlayRenderer
   ├── EvidenceRecorder
   └── Product/Web Telemetry
```

## 10.1.2 Adaptive flow and behavior drift

Flow execution must classify resolution and outcome rather than treating every
fallback as success:

```text
EXACT
SEMANTIC_REPAIR
TARGET_DRIFT
BEHAVIOR_DRIFT
```

Examples:

- exact target and expected transition: `EXACT`;
- same semantic control after a minor rerender: `SEMANTIC_REPAIR`;
- expected `Place order` but only a sufficiently different `Confirm purchase`
  candidate remains: `TARGET_DRIFT`;
- target matched but expected toast became a confirmation dialog:
  `BEHAVIOR_DRIFT`.

A drift result must include confidence, candidates/transition summary, and a
bounded recovery recommendation. It must not silently continue through a
low-confidence or behavior-changing result.

Potential implementation locations:

- `app/extension/modules/actions/`
- `app/extension/modules/flow/`
- `app/extension/modules/wait/`
- `app/extension/modules/overlay/`
- `app/extension/libs/cdp.ts`
- `app/server/src/modules/tools/handlers.ts`

Follow module boundaries: extension modules receive the target/executor they
need and do not import `daemon.ts`.

## 10.2 Settle engine

Create one bounded settle contract instead of adding independent sleeps at each
call site.

Possible signals:

- document loading state;
- DOM mutation quiet window;
- animation frame/paint completion;
- explicit selector/text condition;
- expected semantic state delta;
- pending network activity only when the operation explicitly requests it;
- timeout.

Modern pages can keep WebSockets, SSE, polling, analytics, or background
requests active indefinitely. `network_quiet` must not be a general prerequisite
for click/type settle and must never create a hidden multi-second delay after
every action.

The engine should return why it settled:

```text
load_complete | dom_quiet | network_quiet | condition_met | timeout
```

A timeout is observable and must not be reported as success unless the caller's
policy explicitly allows best-effort continuation.

Existing CDP round-trip delay behavior may be reused, but bare unbounded timers
must not become the default synchronization strategy.

## 10.3 Risk policy

Centralize target-risk checks and classify actual side effects rather than
requiring confirmation for every generic form submission:

- financial action;
- destructive action;
- external communication;
- account/security mutation;
- permission grant;
- irreversible side effect;
- sensitive credential submission when policy requires it.

`submit`, `send`, or a button label is a signal, not automatic proof of risk.
Infer risk from role/name, form/action semantics, surrounding context, known site
skill, and the requested transition. A search, filter, login, or preview submit
may be low risk; the policy must make that classification explicit.

A flow step may override only through an explicit, validated field. A warning
string alone is not an authorization mechanism.

## 10.4 Phase 3 exit criteria

- Standalone actions and flow actions use the same target/risk/settle rules.
- Ambiguous resolution never dispatches input.
- Settle results are bounded and observable.
- Flow failures identify step, reason, and resolution state without leaking
  sensitive values.
- Existing real input behavior remains covered by adapter tests/fixtures.
- Real-Chrome smoke tests cover rerender, navigation, focus, and frame behavior.
- Replay uses the same semantic resolver and durable descriptor contract as live
  flows.
- Flow results distinguish exact success, semantic repair, target drift, and
  behavior drift.

Current implementation notes:

- Standalone click/type/press-key and flow actions emit the same immutable
  `action_started`/`action_finished` lifecycle shape, including settle reason in
  action results and bounded failure events on blocked/failed actions.
- Replay re-resolves logged click/type/press-key targets by current role/name
  and strips stale runtime refs before dispatch; persisted v2 flows use bounded
  descriptors rather than `eN` identity.
- The deterministic suite covers ambiguity, rerender reconciliation, migration,
  risk blocking, drift classification, and settle failures. Real-Chrome
  rerender/navigation/focus/frame coverage remains pending until a provisioned
  Chrome debugging endpoint is available.

## Rollback

Keep the old action handlers behind an internal adapter until the new lifecycle
passes the characterization suite. Roll back the adapter, not the persisted
flow schema.

---

# 11. Phase 4 — Evidence and artifact model

## Objective

Make screenshots, videos, snapshots, and diagnostic artifacts explicit,
redacted, bounded, and addressable without flooding MCP output. Establish one
structured evidence timeline so overlay, flow drift, video, assertions, and
telemetry do not each invent separate event models.

## 11.1 Evidence event model

Define the shared evidence contract before adding more capture implementations:

```ts
interface AssertionEvent {
  id: string;
  timestamp: number;
  expression: string;
  result: "passed" | "failed" | "unknown";
  sensitive: boolean;
}

interface FailureEvent {
  id: string;
  timestamp: number;
  phase: "resolve" | "risk" | "action" | "settle" | "assert" | "capture";
  code: string;
  message: string;
}

interface ArtifactRef {
  id: string;
  kind: "screenshot" | "video" | "snapshot" | "trace" | "other";
  byteSize: number;
  redacted: boolean;
}

interface EvidenceRun {
  id: string;
  sessionId: string;
  flowId?: string;
  profile: "none" | "failure" | "step" | "flow" | "full";
  counts: {
    actions: number;
    assertions: number;
    failures: number;
    artifacts: number;
  };
  timelineRef: string;
  primaryFailureRef?: string;
}
```

`EvidenceRun` is a bounded model-facing index. It must not contain unbounded
arrays of events or artifact/network refs. Events are stored in append-only
rows/chunks addressed by `timelineRef`; callers query them explicitly, for
example:

```text
evidence x4 overview
evidence x4 events after=40 limit=20
evidence x4 failure
evidence x4 artifact <id>
```

`ActionLifecycleEvent` is emitted by Phase 3; Phase 4 connects it to overlay and
persistence.

## 11.2 Capture profiles

Define explicit profiles rather than implicit capture behavior:

| Profile   | Default use           | Data policy                                  |
| --------- | --------------------- | -------------------------------------------- |
| `none`    | ordinary read/action  | no artifact                                  |
| `failure` | failed action/flow    | failure context only, redacted               |
| `step`    | debugging one action  | one bounded artifact                         |
| `flow`    | flow execution        | per-step metadata, artifacts by reference    |
| `full`    | explicit user request | may include larger artifacts, still redacted |

The default should remain compact and should not inline image/video data unless
explicitly requested/configured.

## 11.3 Artifact registry

Store artifacts under an opaque id with metadata:

- artifact id;
- session id;
- capture profile;
- MIME type;
- byte size;
- creation time;
- redaction status;
- retention deadline;
- optional relation to action/flow step.

MCP output should return the artifact id and compact metadata. Absolute local
paths must not become part of the public model-facing contract by default.

## 11.4 Raw capture and derived evidence

Keep raw capture separate from event tracks and rendered annotations:

```text
raw capture
    +
event timeline
    ↓
optional evidence renderer
    ↓
annotated video or screenshots
```

The evidence index may reference:

```ts
interface CaptureSet {
  rawVideoRef?: string;
  rawScreenshotRef?: string;
  timelineRef: string;
  annotatedVideoRef?: string;
}
```

If a profile needs multiple screenshots, store them as bounded timeline/artifact
records rather than growing a model-facing array.

Raw video is the source artifact. Overlay is a live user-feedback consumer, not
the source of truth for video annotation. An annotation renderer may later blur
password regions, change visual style, or regenerate an annotated artifact
without recapturing the raw video. Overlay may be disabled during performance
capture while the event track remains available.

## 11.5 Capture safety

- enforce maximum dimensions, duration, frame count, and bytes;
- stop capture on disconnect or timeout;
- redact or omit sensitive overlays where possible;
- do not store video frames indefinitely in memory;
- ensure cleanup on service-worker/offscreen disconnect;
- distinguish a failed capture from a successful empty capture.

Likely files:

- `app/extension/modules/capture/`
- `app/extension/modules/screencast/`
- `app/extension/modules/overlay/`
- `app/server/src/daemon.ts`
- `app/server/src/modules/dataStore/`
- `app/server/src/modules/callLog/`
- `app/server/src/modules/tools/handlers.ts`

## 11.6 Overlay and Evidence Engine exit criteria

- Capture behavior is selected by a named profile.
- `EvidenceRun`, `ActionLifecycleEvent`, `AssertionEvent`, `FailureEvent`, and
  `ArtifactRef` have versioned contracts.
- Overlay consumes `ActionLifecycleEvent` values instead of maintaining a
  separate action timeline.
- Artifact output is bounded and referenced by id.
- Default output does not inline large images/video.
- Capture metadata and persisted content pass redaction tests.
- Disconnect, timeout, and cleanup paths are tested.

Current implementation notes:

- `browser_inspect({action:"evidence", evidenceAction:"overview"})` returns a
  bounded `EvidenceRun`; `events` and `failure` are explicit follow-up queries.
- The extension keeps a bounded redacted timeline in `chrome.storage.session`
  across service-worker suspension, with a 24-hour age limit and storage cap.
- `stop_recording` persists raw video and a separate redacted JSON event-track
  artifact under opaque ids. No absolute storage path is returned to MCP.
- The overlay now has a compact neutral cursor, reduced-motion handling,
  singleton status/transient badges, bounded labels, and explicit running,
  success, failure, blocked, and drift feedback sourced from the shared
  lifecycle events. It remains pointer-transparent and keeps native CDP
  highlighting independent from page CSS.
- The remaining Phase 4 gate is real-Chrome capture/evidence smoke validation;
  the deterministic Bun suite covers the contracts but cannot prove MV3/CDP
  runtime behavior.

## Rollback

Keep the existing screenshot/video command response adapter while introducing
artifact ids. Remove only after consumers have migrated to the reference shape.

---

# 12. Phase 5 — Token optimization and performance gate

## Objective

Optimize the already-measured token and runtime costs without trading away
correctness, security, or evidence quality. Phase 0 owns the baseline; this phase
owns deliberate reduction and capability-profile design.

## 12.0 No-regression gate

Every Phase 1–10 PR that changes a schema, instruction, output, retry path,
snapshot, delta, or artifact response must include a before/after comparison:

```text
NO TOKEN REGRESSION
```

or a documented exception containing:

- affected task(s);
- fixed and variable cost change;
- why the regression is necessary;
- expected correctness/security benefit;
- mitigation or follow-up optimization.

The gate covers fixed MCP schema/instruction tax as well as task-level payloads.

## 12.1 Measurements

Extend the existing benchmark data only where the fields are meaningful. Track
per task and per action:

- input/output characters;
- estimated tokens and tokenizer source;
- schema/instruction overhead;
- snapshot bytes and node count;
- delta bytes and node count;
- number of tool calls;
- retries and stale-ref events;
- ambiguity events;
- action latency;
- settle latency by reason;
- artifact bytes;
- daemon RSS/heap where available;
- extension cache/listener metrics where available.

Do not call a heuristic `token savings` without naming the baseline and
estimation method.

## 12.2 Capability profiles

After the Phase 0 baseline and Phase 3/4 contracts, define profiles without
increasing the number of MCP tools:

- `default`: safe, compact, progressive disclosure;
- `advanced`: explicit evaluation/dev actions and larger diagnostics;
- `evidence`: capture-heavy, opt-in;
- `bulk`: bounded multi-tab/job operations.

The profile must be validated server-side. A prompt/instruction hint alone is
not a capability boundary.

Resolve the `evaluate` placement during this phase. Options:

1. Keep it under `browser_act` and gate it as advanced.
2. Move it to `browser_dev` with a compatibility adapter.

Choose one, document migration, and add tests before changing schemas.

## 12.3 Query budgets

Set explicit defaults and hard maxima for:

- snapshot size;
- content extraction characters;
- docs blocks per call;
- flow steps;
- job/crawl pages and concurrency;
- screenshot dimensions;
- output text;
- artifact retention.

Every truncation must be represented in the result so the caller can request a
more detailed follow-up.

## Gate for the next phase

Rust or another data plane is justified by either:

1. a repeatable measured performance bottleneck that cannot be fixed within the
   current Bun architecture; or
2. a demonstrated native/data capability boundary where a separate component
   materially improves safety, tooling, isolation, or feasibility.

Examples of a capability boundary include trace processing, source-map indexing,
video encoding, image processing, zstd/compression, process inspection, and
large binary artifact streams. Capability alone is not enough: the spike must
show why a separate native boundary is preferable to a bounded Bun worker or
existing system tool.

The threshold, benchmark, or capability argument must be recorded before the
spike, not invented after the fact.

## Exit criteria

- At least five repeatable tasks have before/after measurements.
- Fixed schema/instruction cost is included in the comparison.
- Token savings are compared against a named baseline.
- Every changed output has a `NO TOKEN REGRESSION` result or documented exception.
- Capability profiles have server-side enforcement tests.
- Query budgets are visible in schemas and enforced in handlers/modules.
- A written decision says whether Rust is justified by performance, capability,
  both, or neither.

## 12.4 Current implementation slice

The first Phase 5 slice keeps the existing MCP behavior when
`BROWSERCONTROL_PROFILE` is unset, then enforces an explicit profile at the
server boundary when selected:

- `default` exposes safe interaction/inspection without evaluation, recording,
  or bulk actions;
- `advanced` adds evaluation and developer diagnostics;
- `evidence` adds recording, flow recording, and HAR export;
- `bulk` adds bounded crawl, search, and background-job actions.

The daemon filters the advertised action enum and rejects a known but disabled
action in the tool handler, so the boundary is not prompt-only. The offline
`tokens:baseline` command reports exact character counts plus `chars / 4`
heuristics for the full surface and each profile. Benchmark calculator
characterization tests now run as part of the workspace test task.

The opt-in `benchmark:runtime` command now drives the authenticated `/execute`
bridge through the paired extension and real Chrome. It creates one temporary
tab and measures five repeatable scenarios: semantic snapshot, batched safe
flow, visual capture, network observation, and stale-reference recovery. It
keeps raw responses out of the report, bounds response size and repetitions,
and closes only the temporary tab in `finally`.

Observed baseline on 2026-09-14 with the default `https://httpbin.org` page and
no capability profile:

| Runs | Task runs | Successful | Roundtrips | Runtime heuristic tokens | Duration  |
| ---- | --------- | ---------- | ---------- | ------------------------ | --------- |
| 1    | 5         | 5/5        | 14         | 14,314                   | 5,762 ms  |
| 2    | 10        | 10/10      | 28         | 28,234                   | 10,262 ms |

The selected fixed cost in both reports was `43,521` schema chars (≈10,880
heuristic tokens) plus `7,760` instruction chars (≈1,940 heuristic tokens).
The visual-capture response was the largest measured runtime payload at roughly
11k heuristic tokens in the repeat run; this is evidence for a progressive
visual-response optimization, not evidence that a Rust/native rewrite is yet
justified. The stale-reference scenario required two recovery calls per run
and verified rejection of the old document-scoped ref before inspecting a fresh
ref.

This is still not the Phase 5 exit gate: these are repeatable runtime baselines,
not a before/after optimization comparison. Remaining work is a named
before/after baseline with a `NO TOKEN REGRESSION` decision for changed outputs,
explicit query-budget coverage, a recorded `evaluate` placement decision, and
a written Rust-or-no-Rust decision.

## Rollback

Benchmark schema additions are backward-compatible. Profiles can default to the
existing behavior until enforcement is ready.

---

# 13. Phase 6 — Optional Rust/native spike

## Entry condition

This phase is **not automatic**. It starts only after Phase 5 identifies either
a measured bottleneck or a demonstrated native/data capability boundary, and the
team approves the boundary.

## Spike scope

The first spike must be narrow and disposable:

- one isolated hot path;
- no immediate SQLite ownership transfer;
- no replacement of the daemon;
- no protocol break;
- one IPC strategy measured against the Bun implementation;
- memory, startup, throughput, failure, and packaging measurements.

Candidates may include:

- binary framing/serialization;
- artifact/event ingestion;
- trace processing;
- source-map indexing;
- video encoding or image processing;
- zstd/compression;
- process inspection;
- large binary stream handling;
- a CPU-heavy analysis function;
- a bounded worker around a demonstrated hotspot.

Do not start with a general Rust data plane, immediate SQLite ownership transfer,
or a second source of truth. The first spike must remain disposable and preserve
a Bun-only fallback.

## Required decisions before production Rust

- process ownership and shutdown;
- IPC protocol and versioning;
- error propagation;
- Windows packaging and installation;
- database ownership and migration;
- crash recovery;
- CI toolchain pinning;
- developer setup cost;
- rollback to Bun-only mode.

## Exit criteria

The spike either:

- demonstrates a measurable win and produces a reviewed production boundary; or
- is deleted/documented as not justified.

A `Cargo.toml` by itself is not a successful outcome.

---

# 14. Phase 7A — BrowserControl self telemetry

## Objective

Build product telemetry on top of stable action, settle, evidence, security, and
token events. This is distinct from web-page performance telemetry.

## Proposed product event model

Each event should have:

- schema version;
- session id;
- action/flow id;
- timestamp and duration;
- source (`mcp`, `sidepanel`, `replay`, `job`, `crawl`);
- success/failure classification;
- redacted attributes;
- optional artifact/ref ids.

Avoid logging raw page content or raw network payloads as telemetry attributes.

## Initial product queries

- action latency by action type;
- settle reason distribution;
- ambiguity/stale-ref rate;
- exact/repair/drift rate;
- retry rate;
- token cost by gateway/action/task;
- schema/instruction fixed cost;
- artifact size by capture profile;
- job/crawl throughput;
- extension/daemon disconnect rate.

## Phase 7A exit criteria

- Product event schema is versioned.
- Telemetry uses the same redaction and retention policy.
- Queries can answer baseline questions without parsing arbitrary log text.
- Existing call-log consumers remain readable during migration.

---

# 15. Phase 7B — Web runtime telemetry / PerformanceGraph

## Objective

Provide evidence for debugging the page itself, not just BrowserControl's own
latency. Keep this bounded, opt-in where data is sensitive, and exportable for
comparison between baseline and candidate runs.

## Runtime signals

Collect only the signals required by the selected dev/performance query:

```text
Network request
  → initiator / stack
  → redirect / cache / service worker
  → protocol / connection / timing
  → JS task / callback
  → style / layout / paint
  → LCP / CLS / other PerformanceTimeline entries
```

Potential CDP sources:

- `Network` request timing, initiator, redirect, priority, cache, and protocol;
- `PerformanceTimeline` for LCP, CLS, and selected page metrics;
- `Tracing` for long tasks, JS, GC, style/layout/paint slices;
- `Profiler` for CPU samples;
- `Debugger` and script metadata for initiator/source correlation.

### Ownership boundary with Phase 8A

Phase 7B owns runtime location and stack evidence:

- `scriptId`;
- generated line/column;
- request/task relation;
- runtime timing and confidence.

Phase 8A owns source enrichment:

- script source retrieval;
- source maps;
- symbol parsing;
- call graph;
- compact `cN` code refs;
- original source location.

A shared lower-level script registry may be used, but only one implementation
owns script identity/source-map caching. Phase 7B can report:

```text
request r17 initiated by script=42 line=912
```

Phase 8A may enrich it later:

```text
script 42:912 → c8 fetchProducts() → ProductApi.ts:61
```

The implementation may stage these signals. It must not pretend that product
self-telemetry is a web PerformanceGraph.

## Graph model

Represent relationships as bounded event/span edges:

```text
request → initiator → script/function → task → render phase → user-visible metric
```

Each edge needs source, timestamp/range, confidence, and redaction status.
Unknown correlation must remain unknown instead of being invented.

Provide baseline/candidate comparison for:

- critical-path duration;
- long-task budget;
- network-to-render delay;
- LCP/CLS deltas;
- CPU and GC pressure;
- request count/bytes/timing.

HAR remains an import/export compatibility format. It is not the canonical model
for all runtime graph data.

## Phase 7B exit criteria

- At least one real fixture page produces a request-to-render/performance trace.
- Network, tracing, profiler, and performance data have bounded capture limits.
- Correlation confidence and missing data are explicit.
- Raw bodies, cookies, and authorization headers are excluded by default.
- Baseline/candidate comparison is reproducible and artifact-addressable.

---

# 16. Phase 8A — Page-runtime code intelligence

## Objective

Index code directly from the page that is running under BrowserControl. Local
filesystem access is not required for this phase and must not be smuggled into
it as an implementation shortcut.

## Runtime sources

Use the existing CDP/debugging boundary where supported:

- `Debugger.scriptParsed` script registry;
- script hashes and bounded `Debugger.getScriptSource` retrieval;
- `sourceMapURL` discovery and source-map resolution;
- first-party/third-party classification;
- `Profiler` coverage and CPU samples;
- network initiator stacks;
- `DOMDebugger` event-listener metadata;
- tracing/profile stack locations.

Build a temporary, session-scoped runtime index with compact code refs such as
`cN`. A code ref is runtime evidence, not a durable local source path.

Initial queries:

- which script/function initiated a network request;
- which handler/listener is associated with a target control;
- source location for an error or long task;
- loaded-script and source-map metadata;
- bounded runtime symbol/call relationships.

Required controls:

- first-party classification must be explicit and confidence-scored;
- script source and snippets have maximum size;
- third-party source is summarized or excluded by default;
- secrets and raw page data are redacted before model-facing output;
- the index is temporary and tied to a tab/frame/document/loader scope;
- no arbitrary filesystem access is exposed.

## 16.1 Runtime script index and content-hash cache

Use a two-stage index so reloads of the same build do not reparse unchanged code:

```text
Debugger.scriptParsed
   ↓
content-hash lookup
   ├─ HIT  → bind new scriptId to existing index
   └─ MISS → bounded getScriptSource
              → source-map resolution
              → parse/index
              → cache by content hash
```

Default capture policy:

- collect metadata for all scripts;
- fetch/index executed or queried first-party scripts first;
- summarize or defer vendor scripts;
- enforce source, parse, graph, and output budgets.

Acceptance requirements:

- reloading the same build does not reparse unchanged script hashes;
- a new deployment reparses only changed chunk hashes;
- script ids can change without invalidating content-hash entries;
- cache eviction is bounded and document/session aware.

## 16.2 CodeGraph comparison POC

Run a development-only comparison without adding CodeGraph as a runtime
dependency, embedding it into the extension, or forking it:

```text
A. CodeGraph graph-only temporary workspace
B. targeted Tree-sitter/runtime index
```

Compare:

- initial index latency;
- incremental index latency;
- RAM;
- graph quality;
- query latency;
- source-map/runtime integration complexity;
- packaging and failure isolation.

The result may justify an external development/index adapter or a targeted
subset. It must not silently expand the production runtime architecture.

## 16.3 Phase 8A dependencies and optional graph join

The core runtime code index depends on Phases 1.5, 2, and 5. Performance
correlation with the web trace graph is an optional Phase 7B join, not a
prerequisite for script/source indexing.

## Phase 8A exit criteria

- A fixture page produces a script registry and at least one runtime correlation.
- `cN` refs are scoped and invalidated with the runtime document/session.
- Source-map and missing-source behavior are explicit.
- Unchanged script hashes are not reparsed on same-build reload.
- Output is bounded and token-budgeted.
- No local filesystem permission is required.
- The CodeGraph comparison is recorded as a POC result, not assumed as a
  production dependency.

---

# 17. Phase 8B — Optional local workspace mapping

## Entry condition

Start only after Phase 8A proves that page-runtime evidence is useful and the
user explicitly opts into local workspace mapping.

Map runtime source to local files only through:

- configured allowed roots;
- explicit user opt-in;
- path normalization and traversal rejection;
- maximum file size and result size;
- no secrets/config files by default;
- language/parser capability reported explicitly;
- clear separation from browser page content;
- source-map/path validation rather than trusting a page-provided path.

Possible deliverables:

- runtime source to local symbol lookup;
- source location lookup from an error/stack trace;
- bounded dependency/package metadata lookup;
- local source graph enrichment for first-party dev pages.

Do not build a general `RuntimeGraph` until both runtime and local-source
privacy boundaries are validated.

---

# 18. Phase 9 — Sidepanel redesign

## Entry condition

Start only after semantic state, action lifecycle, capture profiles, and auth
configuration are stable.

## Incremental UI work

1. Add auth/pairing status and daemon status.
2. Surface capability/profile state.
3. Show snapshot revision/ref freshness.
4. Show action/flow settle state and bounded errors.
5. Show artifact references and retention state.
6. Only then reconsider the full navigation/layout redesign.

Keep CLI-agent chat as an optional tab until its process policy and data policy
are complete. Do not let a UI redesign decide backend security behavior.

---

# 19. Phase 10 — Optional research features

Candidates from `PLANS.md` may be considered only after the relevant gates:

- advanced adaptive planning;
- broader runtime graph analysis;
- native artifact processing;
- richer visual reasoning;
- additional crawler/knowledge automation;
- more aggressive compression or binary transport.

Every candidate requires a one-page spike proposal with:

- user problem;
- current repository evidence;
- dependency list;
- security/privacy impact;
- token/performance hypothesis;
- rollback plan;
- acceptance measurement.

---

# 20. Cross-phase file impact map

| Concern            | Likely files/modules                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| Test runner/CI     | root `package.json`, package `package.json`, `.github/`, `.mise.toml`             |
| Auth/config        | `app/server/src/daemon.ts`, `configs/server.ts`, extension settings/offscreen/API |
| Route validation   | `app/server/src/daemon.ts`, `libs/`, `modules/tools/`                             |
| CLI process policy | `app/server/src/modules/cliAgent/`                                                |
| Redaction          | server owning modules, recorder, network, capture                                 |
| Snapshot state     | `packages/shared/src/protocol.ts`, extension snapshot module                      |
| Flow/replay        | extension flow module, server `replay.ts`, data store migration                   |
| Action lifecycle   | extension actions, flow, wait, CDP helpers                                        |
| Evidence/overlay   | capture, screencast, overlay, action/evidence event consumers                     |
| Benchmarks/T0      | call log/data store, benchmark package, sidepanel benchmark view                  |
| Telemetry 7A       | call log/data store, product telemetry module                                     |
| Telemetry 7B       | CDP Network/Tracing/Profiler/PerformanceTimeline modules                          |
| Runtime code 8A    | extension debugger/CDP modules, runtime index, shared query contract              |
| Workspace map 8B   | server workspace module, settings, path policy                                    |
| Sidepanel          | sidepanel API/settings/components after backend contracts                         |

Respect module ownership. A module should not import another module's private
`types.ts` or `constants.ts`; promote a type only when at least two domains
really need it. Use `packages/shared/` only for dependency-light wire contracts,
runtime protocol constants, and binary encode/decode—not as a general runtime
utility package.

---

# 21. Compatibility and migration policy

## Protocol

- Add a protocol/schema version before changing a wire shape.
- Readers should tolerate one previous version during migration.
- Writers should emit one selected version, not a mixture based on call site.
- Unknown fields are ignored when safe; unknown required versions fail clearly.
- Binary framing changes require a version/handshake test.

## Flows

- Read v1 and v2 during migration.
- Persist `FlowTargetDescriptor` as durable locator data.
- Persist runtime refs/revisions only as recording provenance/debug metadata.
- Never overwrite a v1 flow without a backup/version marker.
- Report stale refs, low-confidence repair, target drift, and ambiguity as
  actionable errors.

## Storage

- Add migrations with a numbered version.
- Back up local SQLite before destructive migration.
- Keep old columns/readers until all consumers migrate.
- Do not store private test fixtures under tracked `data/`.

## Configuration

- Keep current defaults where safe.
- Add new settings with explicit defaults.
- Never commit absolute `C:/` or `D:/` paths.
- Use workspace-relative paths, environment variables, or runtime discovery
  where the tool contract supports them.

---

# 22. Definition of done for every implementation PR

Every PR implementing this plan must include:

- the phase/work-item id in the PR description;
- a short statement of the behavior changed;
- tests for the changed decision or a clear reason a test is impossible;
- migration notes for protocol/storage/config changes;
- security/privacy review for persisted or networked data;
- token impact with a `NO TOKEN REGRESSION` result, or a documented exception;
- no unrelated formatting churn;
- `bun run check` result;
- `bun test` result once Phase 0.5 lands;
- relevant lint/build result;
- rollback instructions if the change is behaviorally risky.

No PR should combine Rust introduction, semantic-state migration, and sidepanel
redesign. Those are separate review units.

---

# 23. Suggested first implementation backlog

This backlog is split so no item bypasses the phase gates.

## Immediate implementation: T0 → Phase 1.5

1. Preserve the existing geometry tests and add Bun workspace test scripts.
2. Add snapshot/flow ambiguity characterization fixtures.
3. Add fixed schema/instruction and task-level token baselines.
4. Add daemon route/auth tests using a fake executor.
5. Add centralized server and extension-boundary redaction tests.
6. Change flow and replay ambiguity from “first candidate” to fail-closed.
7. Remove or validate duplicate `/execute` routing.
8. Add `/mcp`, `/flows/*`, `/metrics`, `/cli-agent/*`, `/status`, and WebSocket
   entries to the enforced auth/capability matrix.
9. Inventory and clean unused binary opcodes.
10. Pin Bun consistently in `packageManager`, `.mise.toml`, and CI.
11. Define and implement persisted daemon secret lifecycle, rotation, and the
    first-message versioned WebSocket hello/ack state machine.
12. Build the documented real-Chrome integration harness and initial smoke tests.

Every item above is subject to the T0 token baseline and must not introduce an
unexplained token regression.

## Phase 2–4 implementation slice (current)

13. Implement the document-scoped `RuntimeTargetRef`, semantic snapshot/delta,
    and durable `FlowTargetDescriptor` adapter. **Code complete; real-Chrome smoke
    gate pending.**
14. Implement `ActionLifecycleEvent`, bounded `EvidenceRun`, raw
    capture/event-track contracts, settle reasons, and the in-process evidence
    consumer boundary. **Foundation complete; capture persistence and overlay
    rendering remain gated follow-up work.**

## Queued design work: gated proposals only

15. Prepare Phase 7A self-telemetry and Phase 7B web-runtime trace spike designs.
16. Prepare the Phase 8A page-runtime code-index and content-hash cache design,
    including the external CodeGraph comparison POC.
17. Prepare the Phase 6 Rust/native capability spike proposal only after the
    Phase 5 gate.

Items 15–17 remain design/proposal work until their dependencies and acceptance
gates are met. This backlog intentionally does **not** include a Rust rewrite, a
full UI redesign, or local-workspace code intelligence before page-runtime
intelligence.

---

# 24. Review questions

For future gated phases, review or amend these decisions:

1. Where should the daemon auth token be configured and paired with the
   extension?
2. Should insecure local development mode exist, and if so, how is it visibly
   enabled and prevented in production?
3. Should `evaluate` stay in `browser_act` with an advanced capability gate, or
   move to `browser_dev`?
4. Should CLI-agent chat remain an optional feature after the process-policy
   hardening?
5. Which data is allowed to persist by default: call metadata, page text,
   network headers, network bodies, screenshots, and video?
6. What retention period and cleanup behavior are acceptable?
7. What are the target p95 latency/token budgets for the baseline tasks?
8. What performance bottleneck or native/data capability boundary would justify a
   Rust spike?
9. Is the document-scoped runtime-ref plus durable flow-descriptor contract
   acceptable?
10. Which page-runtime code correlations should Phase 8A prioritize?
11. Is a v2 flow/snapshot schema acceptable, and what migration window is
    required?
12. Should artifact ids be the only model-facing reference, with local paths
    hidden by default?

Questions that affect later phases remain open; they do not block the completed
T0–Phase 1 foundation. Phase 1.5 and beyond additionally require the accepted
auth, privacy, and integration contracts.
