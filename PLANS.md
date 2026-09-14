# BrowserControl — Full Repository Refactor Plan

> Status: **Planning / Audit Contract**
>
> Scope: whole repository
>
> Primary goals:
>
> 1. Make BrowserControl a reliable real-Chrome control runtime for coding/automation agents.
> 2. Put **token efficiency at Tier 0** across every subsystem.
> 3. Replace ephemeral node-based control with a revisioned semantic browser state.
> 4. Turn recorded flows into adaptive, observable, repairable automation.
> 5. Turn capture/video into structured test evidence rather than raw screen recording.
> 6. Add a Rust data plane for telemetry, artifacts, evidence, runtime-code indexing, analysis, and storage-heavy workloads.
> 7. Add runtime-aware web development intelligence: DOM/action → JS handler → code symbol → network → render/performance.
> 8. Keep the architecture bounded. Do not turn the refactor into an unnecessary generic browser/research platform.

---

# 0. Instructions for the audit agent

This document is **not an implementation command**.

Before changing code, scan the repository and audit this plan against the current implementation.

For every major statement or proposed migration in this document, classify it as:

- `CONFIRMED` — current repository behavior matches the assumption.
- `PARTIAL` — the assumption is directionally correct but implementation already covers part of it.
- `STALE` — repository changed and this plan is outdated.
- `REJECT` — proposal is technically unnecessary, harmful, or conflicts with a better existing architecture.
- `UNKNOWN` — insufficient evidence from repository inspection.

The audit should specifically produce:

1. **Current architecture map**
2. **Current feature inventory**
3. **Mismatch report against PLANS.md**
4. **Dead / duplicate / overlapping features**
5. **Risk list**
6. **Recommended changes to this plan**
7. **Dependency/tooling review**
8. **Estimated migration complexity per phase**
9. **Tests required before each destructive refactor**
10. **Token-cost impact of each MCP-facing change**

Do **not** blindly rewrite working subsystems because this document proposes a cleaner architecture.

Prefer migration behind stable interfaces.

Preserve behavior until characterization tests prove replacement parity.

---

# 1. Product definition

BrowserControl should converge on the following product identity:

> **A token-efficient real-browser runtime for AI agents, with semantic control, adaptive automation, test evidence, runtime code intelligence, and web-performance diagnostics.**

The core product is:

```text
Real Chrome Control
+
Semantic Browser State
+
Token-efficient MCP
+
Adaptive Recorded Flows
+
Visible Agent Actions
+
Autotest Evidence
+
Runtime Code Intelligence
+
Web Performance Telemetry
```

The following capabilities are useful but should not shape the entire core architecture:

```text
Crawler
Search
Saved site skills
Docs/FTS knowledge
Research jobs
Deep web graph
Multi-agent coordination
```

Those should remain optional capability layers unless real usage proves they belong in the core.

---

# 2. Tier-0 architectural constraints

These constraints outrank feature convenience.

## 2.1 Token efficiency is Tier 0

Every new feature must answer:

> What is the smallest useful projection the LLM needs to make the next decision?

Raw data must stay below the MCP boundary whenever possible.

The desired pipeline is:

```text
Browser / Runtime
      ↓ massive data
Rust / Local indexes
      ↓ structured state
Bounded projection layer
      ↓ compact refs + summaries + deltas
MCP
      ↓
LLM
```

The model should **not** receive raw:

- full DOM
- full AX tree repeatedly
- HAR
- trace streams
- source maps
- minified JS bundles
- full code graph
- video bytes
- screenshot base64 by default
- whole flow history
- large network logs
- full crawler corpus

Large data becomes:

```text
artifact
index
handle
short ref
queryable local state
```

The model drills down only when necessary.

---

## 2.2 Correctness is Tier 0

BrowserControl must not silently:

- click an ambiguous first match,
- operate on stale node identity,
- auto-repair a flow below confidence threshold,
- continue after meaningful UI drift without reporting it,
- hide behavior drift,
- assume a page is stable because arbitrary DOM mutations became quiet,
- fabricate HAR timings that were never observed.

---

## 2.3 Security boundary is Tier 0

The extension has powerful permissions and the daemon may expose sensitive local capabilities.

The daemon/extension boundary must be treated as a privileged control channel.

Requirements:

- loopback-only daemon
- authenticated extension ↔ daemon session
- strict origin/handshake policy
- no anonymous command-execution HTTP surface
- no arbitrary CLI spawn path exposed to untrusted browser content
- explicit access policy for non-workspace/personal tabs
- sensitive input redaction in evidence/logs
- artifact privacy controls

---

## 2.4 Evidence must be reproducible

Automation failures should produce enough local evidence to understand:

- what action was intended,
- which target was resolved,
- what changed,
- what network/runtime event followed,
- why the expected state did not appear.

A raw video alone is insufficient.

---

# 3. Current repository — audit baseline

Current high-level repository shape is approximately:

```text
app/
├── extension/
│   ├── entrypoints/
│   │   ├── background
│   │   ├── offscreen
│   │   └── sidepanel
│   ├── modules/
│   │   ├── actions
│   │   ├── capture
│   │   ├── devtools
│   │   ├── dialog
│   │   ├── dispatch
│   │   ├── flow
│   │   ├── inspect
│   │   ├── interceptor
│   │   ├── network
│   │   ├── overlay
│   │   ├── peek
│   │   ├── read
│   │   ├── recorder
│   │   ├── screencast
│   │   ├── screenshot
│   │   ├── search
│   │   ├── snapshot
│   │   ├── tabs
│   │   ├── telemetry
│   │   └── wait
│   └── libs/
│
├── server/
│   └── src/
│       ├── modules/
│       │   ├── callLog
│       │   ├── cliAgent
│       │   ├── crawl
│       │   ├── dataStore
│       │   ├── geometry
│       │   ├── jobs
│       │   ├── sessionFlow
│       │   ├── skills
│       │   ├── streamSink
│       │   └── tools
│       ├── daemon.ts
│       └── replay.ts
│
packages/
├── shared
└── benchmark
```

The existing topology is worth preserving:

```text
MCP client
    ↓
Bun daemon
    ↓ WebSocket
Extension offscreen
    ↓ runtime messaging
MV3 background
    ↓ chrome.debugger / CDP
Real Chrome tab
```

The refactor should improve internal boundaries without replacing this topology unless benchmark data proves a better one.

---

# 4. Primary architecture problems to solve

## 4.1 Browser control is still too node-ID-centric

Current observation/action behavior is based heavily on transient backend DOM node IDs.

Problems:

- React/Vue rerenders invalidate identity.
- Model may need fresh snapshots unnecessarily.
- Flows maintain a separate semantic resolver.
- Snapshot diffs use weak identity.
- Duplicate role/name controls can collide.
- Current flow resolution may know a target is ambiguous but still pick the first candidate.

Target: model-facing **logical semantic references**.

---

## 4.2 State is not first-class

The browser runtime should know:

- current tab
- frame
- loader/navigation identity
- semantic revision
- dirty status
- element reference mapping
- previous projection
- state delta

Instead of treating each command as a mostly stateless read/action cycle.

---

## 4.3 MCP schema/context tax is under-measured

Current benchmark logic must not optimize only tool arguments and response text.

Real task token economics include:

```text
tool definitions
+ instructions
+ arguments
+ observations
+ responses
+ retries
+ model follow-up required because output was insufficient
```

Main KPI:

```text
tokens / successful task
```

Not:

```text
tokens / tool call
```

---

## 4.4 Network/HAR diagnostics are too shallow for serious web development

HAR must remain an import/export compatibility representation.

It should not be the canonical performance model.

BrowserControl needs normalized runtime telemetry:

- network
- initiators
- stacks
- priority
- redirect chains
- cache/service worker source
- protocol/connection
- timing phases
- CPU tasks
- script execution
- GC
- style/layout/paint
- LCP/CLS attribution
- process/memory data
- runtime source mapping

---

## 4.5 Overlay has valid product purpose but wrong visual complexity

The overlay exists primarily so a user can **see the agent controlling the page**.

Its job is not to be a decorative graphics demo.

Default behavior should maximize clarity:

```text
target acquire
→ cursor movement
→ action feedback
→ result
→ fade
```

Advanced debug/performance overlays should be optional.

---

## 4.6 Screen recording is too weak as “video only”

The real product capability should be an **Evidence Recorder**.

A run should correlate:

- video
- actions
- semantic targets
- assertions
- screenshots
- console failures
- relevant network events
- runtime/performance context
- flow drift
- failure cause

---

## 4.7 Flow recording is underpowered if treated as a macro

A recorded flow should not only store:

```text
role + name
or
selector
```

It should capture:

```text
intent
target fingerprints
semantic context
locator candidates
expected transition
historical repairs
success/failure evidence
```

---

## 4.8 Existing diagnostics/data modules overlap

Likely overlaps to audit:

```text
capture / screencast / recorder
network / interceptor / devtools
snapshot / inspect / peek / read
telemetry / benchmark / devtools
flow / sessionFlow / recorder
```

Do not merge by filename alone.

Merge only after identifying actual responsibility boundaries.

---

# 5. Feature disposition matrix

Legend:

- **KEEP** — preserve architecture/API with minor cleanup.
- **HARDEN** — behavior is useful but needs correctness/security/testing.
- **REFACTOR** — keep capability but substantially change internals/API.
- **MERGE** — duplicate responsibility should converge.
- **SPLIT** — current module is too broad.
- **MOVE** — feature belongs under another capability/domain.
- **REMOVE CORE** — remove from default/core surface, optionally keep elsewhere.
- **REMOVE** — capability likely has negative value.
- **ADD** — new capability.
- **DEFER** — useful but not part of main refactor.

| Capability                       | Disposition               | Target                                   |
| -------------------------------- | ------------------------- | ---------------------------------------- |
| WXT Chrome extension             | KEEP                      | Browser adapter/runtime                  |
| Bun daemon                       | KEEP                      | MCP/control plane                        |
| Offscreen persistent bridge      | KEEP + HARDEN             | Authenticated long-lived transport       |
| Background CDP ownership         | KEEP + REFACTOR           | TargetSessionManager                     |
| Workspace tab grouping           | KEEP + HARDEN             | Safety/control scope                     |
| navigate/list/switch/close       | KEEP                      | Session control                          |
| AX snapshot                      | REFACTOR CORE             | Semantic state projection                |
| public backendDOMNodeId identity | DEPRECATE                 | Internal only                            |
| semantic `eN` refs               | ADD                       | Model-facing identity                    |
| revisioned state                 | ADD                       | Per-tab semantic revision                |
| micro-delta                      | ADD                       | Action/result observation                |
| query_region                     | MERGE                     | Scoped semantic query                    |
| find                             | KEEP + REWIRE             | Query semantic/indexed state             |
| inspect_element                  | KEEP + REFACTOR           | Ref-first detail query                   |
| reading_mode                     | KEEP                      | Cheap text extraction                    |
| select_content                   | KEEP + HARDEN             | Artifact/docs extraction                 |
| visual_snapshot                  | KEEP FALLBACK             | Vision/annotated debug                   |
| screenshot                       | KEEP                      | Evidence + vision                        |
| peek_screen                      | RESTRICT + MERGE          | Read-only overview with explicit policy  |
| click/type/key/scroll            | KEEP + REFACTOR           | Ref-first ActionEngine                   |
| basic drag                       | KEEP                      | Trusted input                            |
| exotic drag DSL                  | REMOVE CORE               | Optional advanced input only             |
| evaluate                         | MOVE                      | Developer/advanced profile               |
| run_flow                         | KEEP + REFACTOR CORE      | Adaptive flow executor                   |
| explore_flow                     | MERGE                     | `run_flow(observe=steps)`                |
| current DOM quiet wait           | REPLACE INTERNALS         | State/lifecycle settle engine            |
| risky-target policy              | KEEP + HARDEN             | Policy layer                             |
| automatic dialog dismissal       | REFACTOR                  | Dialog event/state                       |
| network request buffer           | REPLACE                   | Telemetry capture                        |
| HAR analyzer                     | REMOVE/ALIAS              | Performance analyzer                     |
| HAR export                       | KEEP                      | Projection from normalized network model |
| process/memory diagnostics       | REPLACE INTERNALS         | Rust data/telemetry engine               |
| layout diagnostics               | KEEP + REWIRE             | Ref-first development query              |
| emulation                        | KEEP OPTIONAL             | Dev profile                              |
| network interception/sandbox     | KEEP + HARDEN             | Explicit policy                          |
| current extension telemetry      | RENAME                    | BrowserControl self-health               |
| Browser Data Engine              | ADD                       | Rust sidecar/data plane                  |
| PerformanceGraph                 | ADD                       | Runtime performance correlations         |
| RuntimeGraph                     | ADD                       | Cross-domain runtime correlation         |
| Runtime Code Intelligence        | ADD                       | Page JS/TS indexing                      |
| evidence event model             | ADD                       | Structured event timeline                |
| EvidenceRun                      | ADD                       | Test evidence artifact                   |
| failure package                  | ADD                       | Failure-focused evidence                 |
| overlay                          | REFACTOR                  | Visible agent control                    |
| decorative liquid/RGB default    | REMOVE DEFAULT            | Optional theme at most                   |
| sidepanel flows                  | KEEP                      | Flow/run UI                              |
| sidepanel metrics                | REPLACE                   | Runs + telemetry                         |
| sidepanel agent chat             | REMOVE CORE               | External agent already owns conversation |
| sidepanel settings               | KEEP + SIMPLIFY           | Configuration                            |
| flow recorder                    | KEEP + RENAME             | Semantic flow recorder                   |
| saved flows                      | KEEP + UPGRADE            | Versioned adaptive flows                 |
| skills                           | KEEP OPTIONAL             | Site knowledge                           |
| docs FTS                         | KEEP OPTIONAL             | Lightweight retrieval                    |
| batch crawl                      | KEEP OPTIONAL + FIX       | Research capability                      |
| deep crawl                       | KEEP OPTIONAL + FIX       | Research capability                      |
| jobs                             | KEEP OPTIONAL             | Async task orchestration                 |
| web search                       | KEEP OPTIONAL             | Research capability                      |
| durable web graph                | DEFER                     | Only if proven useful                    |
| vector DB                        | DEFER                     | No current requirement                   |
| multi-agent leases/cursors       | DEFER                     | Only with real multi-agent use           |
| CLI-agent subprocess chat        | REMOVE CORE               | Security/scope duplication               |
| benchmark package                | REFACTOR                  | Real task economics                      |
| JSONL replay                     | KEEP                      | Reproduction/debug                       |
| SQLite                           | KEEP, possibly MOVE OWNER | Data metadata/index                      |
| binary framing                   | KEEP + EXTEND             | High-volume streams                      |
| dead/reserved binary opcodes     | IMPLEMENT OR DELETE       | No dead protocol                         |
| new generic GraphQuery MCP tool  | DO NOT ADD YET            | Use internal bounded queries             |

---

# 6. Target architecture

```text
                     MCP HOST
             Codex / Claude / Zed / ...
                         │
                         ▼
┌─────────────────────────────────────────────────┐
│                Bun Control Plane                │
│                                                 │
│ MCP tool registry / capability profiles         │
│ Session + policy                                │
│ Tool projection / token budgets                 │
│ Flow orchestration                              │
│ Rust engine supervision                         │
│ Optional crawl/knowledge adapters               │
└──────────────┬──────────────────┬───────────────┘
               │ control          │ compact IPC
               ▼                  ▼
┌────────────────────────┐   ┌─────────────────────────────┐
│ Chrome Extension TS    │   │ Rust Browser Data Engine    │
│                        │   │                             │
│ TargetSessionManager   │   │ Artifact store              │
│ CDP DomainManager      │   │ SQLite/FTS owner*           │
│ LiveSemanticState      │   │ Evidence engine             │
│ ActionEngine           │   │ Flow history / drift        │
│ FlowRuntime            │   │ Video/image processing      │
│ SettleEngine           │   │ Telemetry normalization     │
│ TelemetryTap           │──▶│ RuntimeGraph                │
│ Raw frame/source tap   │   │ PerformanceGraph            │
│ EvidenceEventBus       │   │ Runtime Code Index          │
│ Visible Overlay        │   │ Query planner               │
└──────────────┬─────────┘   │ Compare / analysis          │
               │             │ Compression / hashing       │
               ▼             └─────────────────────────────┘
          REAL CHROME TAB
```

`*` Storage ownership should be decided after a migration audit.

If Rust becomes first-class and long-lived, prefer one metadata owner rather than Bun and Rust both writing SQLite.

---

# 7. Control plane vs data plane

## TypeScript/Bun should own

- MCP tool definitions
- capability profiles
- authorization/policy
- user-facing tool semantics
- extension orchestration
- browser actions
- live Chrome tab/session state
- CDP command ownership
- semantic projection close to page state
- live overlay
- sidepanel UI
- high-level flow orchestration

## Rust should own or progressively own

- high-volume event ingestion
- telemetry normalization
- trace/network correlation
- artifact indexing
- video encoding/transcoding/rendering
- image processing/diff/redaction
- evidence packaging
- report generation
- flow history / versions / repair statistics
- code indexing
- source-map processing
- runtime-code correlation
- hash/cache/index
- large queryable datasets
- compression
- expensive compare/analysis
- potentially SQLite/FTS as the single persistent data owner

---

# 8. Tier-0 token economy

## 8.1 Main KPI

Measure:

```text
task_tokens =
    tool_definition_tokens
  + instruction_tokens
  + call_argument_tokens
  + tool_response_tokens
  + retry_tokens
  + recovery_tokens
```

Primary product metric:

```text
tokens / successful task
```

Secondary:

- calls / successful task
- roundtrips / successful task
- stale-ref retry rate
- ambiguous-target rate
- observation tokens
- fixed schema tax
- error recovery tokens
- successful-flow average tokens

---

## 8.2 Hard output budgets

Every model-facing query must have a bounded projection.

Suggested defaults:

| Output                | Typical budget |
| --------------------- | -------------: |
| Action success        |   20–80 tokens |
| Micro-delta           |         50–200 |
| Page overview         |        150–400 |
| Semantic search       |        100–300 |
| Flow success          |         20–100 |
| Flow failure          |        100–400 |
| Network diagnosis     |        200–500 |
| Performance diagnosis |        300–700 |
| Runtime-code query    |        150–500 |
| Error diagnostic      |        100–400 |

Internal APIs should carry a budget type:

```ts
type QueryBudget = {
  maxItems: number;
  maxChars: number;
  maxDepth: number;
  maxEvidence?: number;
};
```

Rust equivalent should be mandatory for large graph/index queries.

---

## 8.3 Short stable references

Use compact namespaces:

```text
e17 element
c42 code symbol
r18 network request
t7  runtime/trace task
p4  process
f3  flow
a12 artifact
x9  finding/evidence
```

Example:

```text
e17 button "Save"
→ c42 handleSave()
→ r18 PUT /api/settings
→ t7 render 241ms
```

Do not expose giant nested metadata unless requested.

---

## 8.4 Revision-aware state

Every page semantic projection has a revision:

```text
rev=84
```

Model can query changes since a revision:

```text
inspect since=84
```

Response:

```text
r87
+e42 dialog "Confirm"
~e17 checked=true
-e11
```

Do not resend unchanged page state.

---

## 8.5 Micro-delta after actions

Target pattern:

```text
click e13
→ ok r84
  +e21 heading "Dashboard"
  -e12,e13
```

Avoid:

```text
snapshot
click
snapshot
inspect
```

for ordinary interaction.

---

## 8.6 Progressive disclosure

All large datasets should expose:

```text
overview
→ match/search
→ neighborhood
→ detail
→ raw artifact
```

Examples:

### Network

```text
124 requests
3 issues

r19 /api/feed late +483ms
r7  app.js blocking 318ms
r33 hero.webp LCP +211ms
```

Then query `r19` if needed.

### Code

```text
c42 handleSave()
calls c51,c53
called_by c31
runtime 184ms
requests r12,r14
```

Then request neighbors only if necessary.

---

## 8.7 Artifact-first

Binary/large outputs return refs:

```text
a32 screenshot 1440x900
a33 evidence-video 18.4s
a34 trace 42MB
```

Never inline binary/base64 by default.

---

## 8.8 Local deterministic computation before LLM

Resolution, ranking, diffing, aggregation and anomaly detection should happen locally.

Do not give the model 40 candidates if a deterministic ranker can narrow to 2.

Do not send 130 requests and ask the model to find duplicates.

Do not send 1M trace events and ask the model to find long tasks.

---

## 8.9 Capability profiles

Default core should stay small.

Suggested profiles:

### `core`

```text
browser_session
browser_inspect
browser_act
```

### `dev`

Adds:

```text
browser_dev
runtime/performance queries
```

### `automation`

Adds:

```text
flow/evidence operations
```

### `research`

Adds:

```text
browser_bulk
browser_knowledge
```

### `full`

All supported capabilities.

Advanced drag geometry should not tax the default schema.

Dynamic MCP tool-list changes may be used only if client compatibility is proven.

Static startup profiles are an acceptable first implementation.

---

# 9. Live Semantic State Engine

## 9.1 Purpose

Replace transient node identity with logical semantic identity.

Per tab/frame maintain:

```text
TabSemanticState
├── tabId
├── frameId
├── loaderId
├── revision
├── dirty
├── semantic nodes
├── ref index
└── previous projection
```

---

## 9.2 Model-facing node

Example:

```text
e12 textbox "Email"
e13 textbox "Password"
e14 button "Sign in"
```

Internal state may include:

```text
backendNodeId
role
name
value
states
href
input type/name
ARIA relationships
landmark context
parent semantic ref
sibling ordinal
stable attributes
bounds
frame
structural fingerprint
```

Do not expose all fields by default.

---

## 9.3 Reconciliation priority

Suggested signals:

1. stable explicit ID
2. `data-testid` / test attributes
3. semantic role + accessible name
4. stable form/name/type/href
5. parent/landmark context
6. ARIA relationships
7. sibling ordinal
8. structural fingerprint
9. backend node ID as a transient hint only

Generate reconciliation confidence.

If confidence is low, allocate a new logical ref.

Never pretend identity is stable when confidence is poor.

---

## 9.4 Ambiguity

Do not silently choose the first candidate.

If ranking cannot resolve confidently:

```text
AMBIGUOUS "Edit"

e41 button "Edit" in card "Project Alpha" .91
e66 button "Edit" in card "Project Beta"  .88
```

Return a small candidate set.

---

## 9.5 Semantic diff

Diff:

- added
- removed
- changed fields
- relationships only when useful

Avoid full state after each action.

If a delta is too large:

```text
RESET r92
```

and provide a compact new overview rather than a giant diff.

---

# 10. ActionEngine

Action logic should be separated from presentation.

```text
ActionEngine
    │
    ├── resolve ref
    ├── policy check
    ├── execute trusted CDP input
    ├── settle
    ├── compute state delta
    └── emit ActionEvent
                     │
           ┌─────────┴─────────┐
           ▼                   ▼
    Live Overlay        Evidence Recorder
```

Action result:

```text
success
target ref
duration
revision
small state delta
optional warning
```

Overlay rendering must not be embedded deeply in each action implementation.

---

# 11. Settle engine

Replace generic “DOM quiet means stable” with a composite settle strategy.

Potential signals:

- navigation lifecycle
- frame/loader changes
- meaningful semantic mutations
- target state transition
- network state when explicitly relevant
- bounded quiet period
- known SPA route change
- expected flow transition

Ignore cosmetic churn where possible:

- continuously changing style
- animations
- unrelated class updates
- counters/timers outside target context

A settle engine must always be bounded.

---

# 12. Adaptive Flow Engine

## 12.1 Flow is cached reasoning

A saved flow should let future tasks execute internally with minimal LLM involvement.

Happy path target:

```text
run f12
→ f12 ✓ 8/8 1.7s r84
```

---

## 12.2 Flow step model

A flow step should capture more than a selector.

```text
Step
├── action intent
├── target semantic descriptor
├── locator hints
├── contextual neighbors
├── page/region signature
├── expected transition
├── safety metadata
└── historical repair metadata
```

Example:

```text
ACTION
  click

TARGET
  role: button
  name: Sign in

LOCATORS
  data-testid: login-submit
  type: submit

CONTEXT
  form "Login"
  near textbox "Email"
  near textbox "Password"

EXPECTED
  disappear form "Login"
  appear heading "Dashboard"
  route /dashboard
```

---

## 12.3 Replay modes

### Exact/fast path

High-confidence known target.

Execute without model intervention.

### Semantic recovery

Selectors/backend IDs changed but semantic context is strongly consistent.

Auto-repair temporarily if confidence exceeds threshold.

Log repair.

### Drift

UI changed enough that target is uncertain.

Stop and expose candidates.

Never click arbitrarily.

---

## 12.4 Flow Drift UI

Sidepanel:

```text
checkout
Step 6 / 12

FLOW DRIFT

Recorded:
button "Place order"

Candidates:
e91 button "Confirm purchase" .92
e104 button "Continue"        .54

[Use candidate]
[Inspect]
[Abort]
```

Overlay should highlight candidate targets.

---

## 12.5 Behavior drift

Target identity may survive while behavior changes.

Example:

```text
click Save

expected:
+ toast "Saved"

actual:
+ dialog "Confirm changes"
```

This is **behavior drift**, and must be reported even if the click target matched perfectly.

---

## 12.6 Flow repair history

Do not overwrite saved flow after one recovery.

Track repair evidence:

```text
old target → new target
successful uses
failure uses
confidence history
first seen
last seen
```

After repeated success, offer to update the flow.

Keep version history:

```text
checkout-flow
├── v1
├── v2
├── v3
└── v4 current
```

---

# 13. Visible Agent Overlay

Primary purpose:

> Let the human see what the agent is controlling in real time.

Default visual language should be compact and professional.

Required visual states:

- target acquire
- cursor move
- click
- typing
- key press
- scroll
- drag
- navigation
- waiting
- success
- error
- flow drift candidate

Default pipeline:

```text
target outline
→ cursor glide
→ action pulse/label
→ result
→ fade
```

Avoid heavy persistent decoration.

Optional modes may add:

- semantic refs
- layout diagnostics
- performance attribution
- drift candidates
- debug info

Overlay must be disable-able for clean performance measurement.

No idle render loop when nothing is visible.

---

# 14. Evidence Recorder

## 14.1 EvidenceRun

```text
EvidenceRun
├── run metadata
├── video
├── structured events
├── screenshots
├── assertions
├── semantic state refs
├── network slice
├── console/errors
├── optional runtime trace
├── flow drift
└── report
```

Example filesystem:

```text
data/runs/<run-id>/
├── manifest.json
├── events.msgpack.zst
├── video.webm
├── network.msgpack.zst
├── trace/
├── screenshots/
├── failure.json
└── report.html
```

Do not design a proprietary monolithic archive first.

A portable `.bctrace`-like bundle may be added later.

---

## 14.2 Live events and evidence must share one model

Example:

```text
ActionEvent
{
  timestamp
  action
  targetRef
  targetBounds
  semanticLabel
  result
  duration
  sensitive
}
```

Same event stream feeds:

```text
Live Overlay
Evidence timeline
Flow history
Failure report
```

No duplicated action annotation logic.

---

## 14.3 Video processing

Preferred architecture if Rust sidecar is first-class:

```text
Chrome frame stream
→ binary IPC
→ Rust
→ encoder/muxer
→ video artifact
```

Do not keep unnecessary:

```text
base64 JPEG
→ JS decode
→ Canvas redraw
→ MediaRecorder encode
```

unless it remains the most reliable fallback.

Implementation strategy:

1. retain current capture pipeline as compatibility fallback
2. prototype native/FFmpeg pipeline
3. benchmark CPU, memory, frame loss, latency, portability
4. migrate only if clearly better

A practical first Rust implementation may spawn FFmpeg rather than bind libav directly.

---

## 14.4 Annotated evidence video

Store raw media + event track separately.

Generate annotated evidence from both.

This allows:

- different themes later
- clean/raw recording
- redaction
- re-rendering old evidence
- annotation without perturbing the measured page

---

## 14.5 Failure package

On flow/test failure, automatically preserve a bounded diagnostic window.

Example:

```text
failure/
├── video clip
├── screenshot
├── failing step
├── target resolution data
├── expected transition
├── actual semantic delta
├── console errors
├── relevant requests
└── optional performance slice
```

---

## 14.6 Sensitive information

Evidence must support redaction.

Never persist cleartext sensitive values simply because the agent typed them.

Sensitive events should store:

```text
type Password
value [REDACTED]
```

Image/video redaction should support target-bound masking when required.

---

# 15. Rust Browser Data Engine

Rust should evolve beyond “telemetry parser” into the main heavy-data engine.

Suggested conceptual domains:

```text
crates/
├── bc-data-core/
│   ├── ids
│   ├── events
│   ├── artifacts
│   ├── hashing
│   ├── budgets
│   └── query
│
├── bc-storage/
│   ├── sqlite
│   ├── migrations
│   ├── artifact_index
│   └── fts
│
├── bc-evidence/
│   ├── timeline
│   ├── video
│   ├── images
│   ├── redaction
│   └── reports
│
├── bc-flow/
│   ├── versions
│   ├── repair_history
│   ├── drift
│   └── scoring
│
├── bc-telemetry/
│   ├── network
│   ├── trace
│   ├── performance
│   ├── process
│   └── compare
│
├── bc-page-code/
│   ├── scripts
│   ├── sourcemaps
│   ├── parser
│   ├── symbols
│   └── graph
│
├── bc-runtime-graph/
│   ├── correlate
│   ├── evidence
│   └── queries
│
└── bc-engine/
    ├── IPC
    ├── supervision
    └── service API
```

Do not create all crates immediately if it hurts iteration.

Start coarse and split when boundaries stabilize.

---

# 16. Rust toolchain candidates

Use only where justified.

## Core

- Rust stable
- Cargo workspace
- Tokio
- Serde
- `thiserror`
- `tracing`
- `url`
- BLAKE3
- zstd

## IPC

Candidate:

- MessagePack
- `rmp-serde`
- TS `msgpackr`

Requirements:

- versioned protocol
- binary frames/chunks
- bounded queues
- backpressure
- crash isolation
- restart/reconnect
- feature negotiation

Do not optimize into shared memory/native bindings before benchmark evidence.

---

## Storage

Candidate:

- `rusqlite`
- SQLite FTS5
- explicit migrations

If Rust becomes the data owner, Bun should query through Rust IPC rather than opening the same SQLite database independently.

Migration should happen only after data-store behavior is characterized.

---

## Images

Candidate:

- Rust `image` crate
- optional specialized diff/SSIM tools later

Capabilities:

- decode
- crop
- resize
- annotate
- thumbnail
- blur/redact
- pixel diff
- evidence composition

---

## Video

Initial practical strategy:

```text
Rust
→ FFmpeg subprocess
→ stdin frame/event pipeline
→ WebM/MP4 artifact
```

Later evaluate direct bindings only if needed.

---

## Reports

Primary evidence report:

```text
HTML
```

Secondary:

```text
Markdown
```

Optional:

```text
PDF export
```

Reports should reference artifacts instead of embedding huge data by default.

---

# 17. Browser Telemetry Engine

## 17.1 Capture sources

Potential Chrome/CDP inputs:

- Network domain
- PerformanceTimeline
- Tracing
- Profiler/precise coverage
- Runtime
- Page lifecycle
- System/process information where available
- optional NetLog deep mode

---

## 17.2 Normalized network model

Capture:

```text
request identity
url/method
frame/loader
initiator
stack
redirect chain
priority and priority changes
cache/service-worker source
protocol/connection
encoded/decoded size
DNS/connect/SSL/send/TTFB/receive
response/body metadata
timestamps
```

Bodies should normally be stored as artifacts/refs, not sent to LLM.

---

## 17.3 Trace/performance

Normalize:

- main-thread tasks
- script execution
- GC
- style calculation
- layout
- paint/composite
- long tasks
- LCP
- CLS
- navigation/resource timing

---

## 17.4 PerformanceGraph

Correlate:

```text
navigation
→ document
→ script
→ API
→ callback/task
→ component/update
→ style/layout
→ paint/LCP
```

The model should query compact causal projections.

Example:

```text
LCP 2.84s

critical path:
document        418ms
app.js          502ms
/api/home       624ms
React commit    471ms
layout          302ms
hero paint      211ms

likely:
1. API starts 536ms late.
2. Main thread blocks response processing 318ms.
3. Hero decode adds 211ms.
```

---

## 17.5 Baseline/candidate loop

Core development workflow:

```text
capture baseline
→ agent edits code
→ capture candidate
→ compare
```

Compact result:

```text
LCP       2.84s → 1.91s  -32.7%
JS CPU    1.42s → .96s   -32.4%
Layout    481ms → 212ms   -55.9%
Transfer  3.2MB → 2.7MB  -15.6%

regression:
CLS .018 → .094
/api/feed 1 → 4 requests
```

---

# 18. Runtime Code Intelligence

## 18.1 Goal

Treat a running page as a temporary runtime code workspace.

Bridge:

```text
DOM element
→ event handler
→ generated script
→ source map
→ original symbol
→ call graph
→ network request
→ runtime task
→ render/performance outcome
```

This is distinct from a normal IDE code graph.

---

## 18.2 Script registry

Use page/runtime script events to collect lightweight metadata:

```text
scriptId
url
hash
sourceMapURL
execution context
module flag
```

Do not immediately download/index every script.

---

## 18.3 Progressive code indexing

### Tier 0 metadata

Register script metadata only.

### Tier 1 executed/first-party code

Use coverage/runtime activity to prioritize.

### Tier 2 demand-driven expansion

Fetch/index:

- implicated script
- source map
- original source neighborhood
- callers/callees
- nearby runtime correlations

---

## 18.4 Source maps

Resolve:

```text
generated location
→ original source
→ original line/column
→ symbol
```

When source maps contain original source content, reconstruct a temporary workspace.

When working against a local dev repo, try to map runtime source URLs to local source files.

---

## 18.5 Parser/index

Initial language scope:

- JavaScript
- TypeScript
- JSX
- TSX

Candidate implementation:

- Tree-sitter
- symbol extraction
- imports/exports
- call edges
- class/function graph

Do not add embeddings/vector search initially.

---

## 18.6 CodeGraph integration strategy

Use CodeGraph externally first only if it accelerates proof-of-concept.

Potential temporary workflow:

```text
page scripts/source maps
→ temp workspace
→ graph-only indexing
→ bounded symbol query
```

However, BrowserControl eventually needs additional runtime edges CodeGraph does not own:

```text
scriptId
generated location
source-mapped location
DOM element
event listener
network request
runtime stack
trace task
performance event
```

Therefore avoid locking the architecture to an external IDE graph engine.

Long-term, a targeted JS/TS runtime index may be simpler and cheaper.

---

# 19. RuntimeGraph

Unify cross-domain references conceptually:

```text
RuntimeGraph
├── semantic DOM refs
├── actions
├── flow steps
├── JS code symbols
├── event handlers
├── network requests
├── runtime tasks
├── profiles
├── layout/paint
├── performance metrics
└── evidence
```

Example:

```text
e42 button "Filter"
  → c19 handleFilterChange()
  → c27 fetchProducts()
  → r18 GET /api/products
  → t44 ProductGrid render
  → t46 layout
```

Queries should be bounded projections, not graph dumps.

---

# 20. Developer queries

Desired high-level queries:

```text
why_slow(e42)
why_request(r18)
what_handles(e17)
what_changed_after(e42)
why_lcp
why_cls
memory_growth
layout_cost
critical_path
compare(runA, runB)
flow_failure(f3)
```

The local engine should combine relevant subsystems before returning a compact answer.

Do not force the model to manually orchestrate ten low-level calls when the engine can deterministically aggregate them.

---

# 21. Sidepanel redesign

The sidepanel should not become a generic chat client.

Primary sections:

```text
RUN
EVIDENCE
FLOWS
TELEMETRY
SETTINGS
```

Possible layout:

```text
BrowserControl                LIVE

Current Run
checkout.spec
Step 4 / 11
Recording 01:42

Latest
✓ Navigate
✓ Type Email
✓ Type Password
→ Click Sign in

[Stop] [Screenshot] [Marker]

Runs | Flows | Telemetry | Settings
```

Key responsibilities:

- current tab/run status
- recording state
- latest actions
- failure/drift status
- evidence list
- flow library/version
- telemetry capture and findings
- configuration

Remove decorative UI behavior that consumes complexity without adding information.

---

# 22. Security refactor

Audit current HTTP/WS exposure carefully.

Target:

```text
daemon startup
→ generate/resolve local secret
→ extension pairing
→ authenticated WebSocket
→ strict HTTP origin/token policy
```

Rules:

- no wildcard CORS for privileged mutation endpoints
- no unauthenticated arbitrary command execution
- no hidden local shell execution surface
- explicit permission for reading/control outside workspace
- secrets never serialized to evidence
- dangerous actions remain policy-gated

If CLI-agent subprocess support is kept for development, isolate it outside the default daemon/API.

---

# 23. Dialogs

Current blanket auto-dismiss behavior should be replaced.

Suggested behavior:

```text
alert
→ may auto-dismiss after emitting event

confirm
→ expose pending dialog state

prompt
→ expose pending dialog state + privacy handling
```

Flow expected-transition logic should understand dialog appearance.

---

# 24. Crawler / docs / knowledge

These remain optional.

First fix correctness before adding graph complexity.

Audit:

- canonical URL normalization before frontier insertion
- normalized deduplication
- `sameDomainOnly`
- match/exclude patterns
- configured outlink limits
- max chars semantics
- unchanged-content dedupe
- page revision/content hash
- FTS snippets
- polling/delivery semantics

Do not build a durable general web graph unless a real use case justifies it.

---

# 25. Storage model

Preferred principle:

```text
SQLite = metadata/index/queryable state
filesystem = large artifacts
```

Likely tables/domains:

```text
sessions
tabs/runs
flows
flow_versions
flow_repairs
evidence_runs
artifacts
tool_calls
docs
runtime_scripts
runtime_sources
captures
metrics summaries
```

Large:

```text
video
screenshots
trace
network chunks
source bundles
reports
```

stay on filesystem.

Add explicit schema versioning and ordered migrations.

Do not continue uncontrolled “try ALTER TABLE / ignore error” migration patterns.

---

# 26. Testing strategy

Before destructive refactors, build characterization tests.

## Semantic/browser fixtures

Cover:

- static HTML
- React SPA
- Vue SPA if practical
- duplicate buttons/names
- forms
- modals
- popovers
- navigation
- SPA route changes
- iframe
- shadow DOM
- virtualized list
- infinite scroll
- rerender between observation/action
- focus changes
- stale nodes
- dialogs
- ARIA state changes

---

## Flow fixtures

Cover:

- exact replay
- selector changed
- backend node changed
- accessible name changed slightly
- duplicate targets
- target moved to new parent
- target replaced semantically
- behavior drift
- confirmation dialog inserted
- flow repair accepted/rejected
- version history

---

## Evidence tests

Cover:

- recording start/stop
- frame loss
- binary stream disconnect
- large capture
- redaction
- failure clip
- screenshot annotation
- event/video timestamp alignment
- artifact cleanup

---

## Telemetry tests

Cover:

- redirects
- cache
- service worker
- repeated requests
- late requests
- long tasks
- LCP resource
- CLS source
- CPU/network overlap
- navigation
- huge traces

---

## Runtime-code tests

Cover:

- no source maps
- inline source map
- external source map
- minified JS
- dynamic imports
- Vite
- Webpack
- Next.js bundles
- React delegated events
- plain DOM listener
- local source mapping
- repeated reload with same script hash
- one changed chunk

---

# 27. Benchmark strategy

## Browser-control metrics

- task success rate
- wrong-target rate
- ambiguous-target rate
- stale-ref retry rate
- calls/task
- roundtrips/task
- action latency
- semantic reconcile accuracy
- semantic rebuild latency

## Token metrics

- fixed schema tokens
- instruction tokens
- observation tokens
- action-result tokens
- recovery tokens
- total tokens/successful task
- flow token savings
- unchanged-state response cost

## Runtime engine

- memory
- CPU
- event ingest throughput
- large trace size
- 100k/1M event query latency
- code-index speed
- source-map resolution latency
- cache hit ratio
- video encode CPU
- dropped frames

## Perturbation

Telemetry itself changes measured performance.

Measure overhead of:

- Network only
- Network + performance
- tracing
- profiling
- overlay
- video recording
- full capture

Provide capture profiles.

---

# 28. Capture profiles

Suggested:

```text
light
  network + basic performance

web_performance
  network + performance timeline + selected tracing

cpu
  trace + profiler

memory
  memory/process focused

deep_network
  network + tracing + optional deep network diagnostics

full
  explicit expensive capture
```

Overlay/video should be independent switches where possible.

---

# 29. MCP output style

Model-facing output should prefer compact text/projections over verbose pretty JSON.

Example action:

```text
ok r84 e17 click 126ms
+e21 dialog "Confirm"
```

Example stale ref:

```text
ERR STALE_REF e17 r81→r89
resolved e23 confidence=.96
```

Example flow:

```text
f12 ✓ 8/8 1.7s r84
```

Example flow drift:

```text
f12 ✕ step=6 TARGET_DRIFT
expected button "Place order"
e91 "Confirm purchase" .92
e104 "Continue" .54
x17 evidence
```

Machine-readable internal representation can remain richer.

---

# 30. Internal query budget

Large-data functions must not expose unrestricted dumps to the MCP adapter.

Prefer APIs like:

```text
project_semantic(query, budget)
query_runtime_graph(query, budget)
query_telemetry(query, budget)
query_code_graph(query, budget)
```

Avoid public MCP-facing functions like:

```text
dump_graph()
dump_trace()
dump_har()
dump_all_scripts()
```

Semantic truncation must rank meaningful results rather than blindly slice bytes.

Return cursors/refs for further exploration.

---

# 31. Migration phases

The sequence matters.

Do not start with Rust or UI redesign while correctness/state behavior is uncharacterized.

---

## Phase 0 — Freeze, audit, characterize

Goals:

- confirm repository behavior
- remove stale assumptions from this plan
- create architecture map
- measure existing task/token baseline
- add characterization tests
- identify dangerous API/security surfaces

Deliverables:

- current feature inventory
- tool schema token count
- instructions token count
- benchmark fixtures
- current action/flow success baseline
- security findings
- module dependency map

No large architectural rewrite.

---

## Phase 1 — Correctness and security cleanup

Fix before building new abstractions:

- crawler config mismatch
- URL canonicalization/dedup
- ambiguous flow target behavior
- snapshot diff identity collision
- dead protocol/opcodes
- error shape consistency
- sensitive logging issues
- daemon auth/origin policy
- dialog behavior
- personal-tab policy
- CI test execution

Acceptance:

- no silent first-candidate ambiguity
- no known exposed config ignored by implementation
- security boundary documented/tested
- critical characterization suite green

---

## Phase 2 — Token-aware semantic state foundation

Implement:

- `LiveSemanticState`
- short refs `eN`
- revision
- semantic diff
- bounded overview/match/region/detail
- ref resolution
- reconciliation confidence
- action micro-delta
- state cache
- semantic query budgets

Maintain compatibility with old node IDs temporarily.

Acceptance:

- normal happy-path browser task no longer requires full snapshot after each action
- duplicate-role/name fixtures handled correctly
- ref survives common SPA rerender when identity is confident
- token/task materially lower than baseline

---

## Phase 3 — Action/flow unification

Implement:

- common resolver
- ActionEvent
- new settle engine
- flow replay on semantic refs
- expected transitions
- flow drift
- behavior drift
- versioned flow model
- repair history
- merge/remove duplicated explore-flow behavior

Acceptance:

- flow resolver and direct action resolver use the same identity model
- high-confidence drift repair works
- ambiguous drift stops visibly
- successful saved flow is dramatically cheaper in tokens than rediscovery

---

## Phase 4 — Overlay + Evidence event architecture

Refactor:

- decouple action execution from overlay
- layered visible-agent overlay
- shared ActionEvent stream
- EvidenceRun model
- screenshots
- failure package
- privacy/redaction
- timestamp synchronization

Keep current video capture until replacement is benchmarked.

Acceptance:

- overlay can be disabled
- idle overlay costs near-zero
- flow failure yields structured evidence
- sensitive typed values are not persisted in cleartext

---

## Phase 5 — Rust Browser Data Engine bootstrap

Add:

- Cargo workspace
- versioned IPC
- supervision/restart
- event ingest
- artifact index
- hashing/compression
- first Rust-owned analysis endpoint

Do **not** migrate every data subsystem at once.

Acceptance:

- daemon survives Rust-engine restart
- backpressure exists
- version mismatch produces clear failure
- binary event workload does not pass through MCP

---

## Phase 6 — Native artifact/evidence processing

Move/implement:

- image processing
- evidence composition
- report generation
- optional FFmpeg video pipeline prototype
- artifact manifests
- flow history analytics

Benchmark current JS MediaRecorder pipeline versus Rust/FFmpeg.

Migrate video only if reliability/performance wins.

---

## Phase 7 — Telemetry / PerformanceGraph

Implement:

- complete network capture
- normalized request timeline
- tracing stream
- LCP/CLS attribution
- critical path
- main-thread analysis
- process/memory analysis
- baseline/candidate compare

Replace shallow HAR diagnostics.

HAR remains export/import compatibility.

Acceptance:

- analyzer identifies post-response CPU/render bottleneck
- compare detects regressions
- large traces are queried locally with bounded model output

---

## Phase 8 — Runtime Code Intelligence

Implement progressively:

1. script registry
2. script hashing/cache
3. source acquisition
4. source-map resolution
5. executed-first-party filtering
6. JS/TS/JSX/TSX indexing
7. symbol/call graph
8. event-listener mapping
9. request initiator mapping
10. profile/trace → source symbol correlation
11. local repo source matching

External CodeGraph may be used for a proof-of-concept, but runtime graph architecture must not depend on CodeGraph-specific semantics.

Acceptance:

- given a runtime request, identify likely initiating source symbol when data exists
- given a plain DOM event listener, map to source
- page reload with unchanged bundle hash reuses index
- model receives bounded symbol projections

---

## Phase 9 — Sidepanel redesign

Only after underlying runtime APIs stabilize.

Replace current panel information architecture with:

- Run
- Evidence
- Flows
- Telemetry
- Settings

Remove embedded generic agent chat from default/core.

Keep panel compact, information-dense and browser-sidepanel-friendly.

---

## Phase 10 — Optional research cleanup

Finally:

- crawler
- docs
- skills
- research jobs
- search

Improve only after core platform is stable.

Do not allow research features to re-expand default MCP schema/token tax.

---

# 32. Suggested target repository shape

This is conceptual, not a mandatory rename.

```text
app/
├── extension/
│   ├── entrypoints/
│   │   ├── background/
│   │   ├── offscreen/
│   │   └── sidepanel/
│   │
│   └── runtime/
│       ├── cdp/
│       ├── targets/
│       ├── semantic/
│       ├── actions/
│       ├── flows/
│       ├── settling/
│       ├── telemetry/
│       ├── evidence/
│       └── overlay/
│
└── server/
    └── src/
        ├── mcp/
        ├── bridge/
        ├── policy/
        ├── sessions/
        ├── engine/
        ├── capabilities/
        └── optional/
            ├── crawl/
            ├── knowledge/
            └── jobs/

crates/
├── bc-data-core/
├── bc-engine/
├── bc-storage/
├── bc-evidence/
├── bc-flow/
├── bc-telemetry/
├── bc-page-code/
└── bc-runtime-graph/

packages/
├── shared/
└── benchmark/
```

Do not create a large number of tiny crates/modules before boundaries are proven.

---

# 33. Tool/dependency policy

## Keep

- Bun
- Turbo
- Biome
- TypeScript
- WXT
- React
- Tailwind
- MCP SDK
- Chrome DevTools Protocol
- SQLite / FTS5

## Add when phase requires it

- Rust/Cargo
- Tokio
- Serde
- `thiserror`
- `tracing`
- MessagePack
- zstd
- BLAKE3
- `rusqlite`
- Tree-sitter JS/TS
- Rust image tooling
- FFmpeg process integration

## Avoid unless proven necessary

- GraphQL
- Cypher
- vector database
- Redis
- OpenTelemetry stack as a dependency
- Electron
- Playwright as product runtime
- huge UI framework
- generic distributed job system
- WASM everywhere
- N-API/native bindings before IPC benchmark
- custom database engine

---

# 34. Explicit non-goals for this refactor

Do not:

- rewrite the entire extension in Rust/WASM
- replace WXT without evidence
- replace Bun daemon merely for language purity
- create a generic browser graph database
- implement arbitrary Cypher/GraphQL queries
- persist the full live DOM
- send raw trace/HAR/code bundles to LLM
- build vector search before lexical/symbol indexes prove insufficient
- solve multi-agent coordination before there are real concurrent agents
- add more MCP gateways simply because internal architecture has more domains
- optimize binary IPC before measuring bottlenecks
- make every optional feature visible in default MCP schema
- auto-repair flows below safe confidence
- let evidence capture silently store secrets

---

# 35. Acceptance criteria for the full refactor

The project should eventually satisfy:

## Browser control

- reliable semantic refs
- no silent ambiguous targeting
- stale-node recovery
- iframe/shadow/modal coverage appropriate to supported scope
- action returns compact state change

## Token efficiency

- fixed MCP schema cost known
- tokens/successful-task tracked
- default page interaction uses bounded projections
- large artifacts never inline by default
- saved flows yield large token reduction
- unchanged state can return an extremely small response

## Flows

- recorded flow includes expected transition
- automatic high-confidence semantic recovery
- visible drift when uncertain
- behavior drift detection
- versioned repair history
- failure evidence

## Evidence

- synchronized structured events + video/screenshots
- redaction
- failure package
- human-readable HTML report
- compact MCP refs

## Telemetry

- request causal data
- CPU/render correlation
- LCP/CLS attribution
- critical path
- baseline/candidate compare
- bounded diagnostic queries

## Runtime code

- script cache
- source-map mapping
- JS/TS symbol graph
- handler/request correlation
- runtime-to-local-source mapping where possible
- incremental/reload-friendly indexing

## Architecture

- TypeScript owns browser control
- Rust owns heavy data processing
- clean protocol boundary
- optional capabilities remain optional
- tests cover critical behavior
- no giant god modules for core domains

---

# 36. Questions the audit agent must resolve before implementation

The repo audit should explicitly answer these.

## Semantic state

1. Which existing snapshot/inspect/read primitives can be reused?
2. How frequently does current code fetch full AX trees?
3. Where are node IDs serialized into model-facing responses?
4. Which actions can already re-resolve stale targets?
5. Are frames/shadow DOM currently represented at all?

## MCP/token

6. Exact current token size of all tool schemas?
7. Exact instruction/context cost?
8. Which gateway parameters account for most schema tax?
9. Which tool outputs are still pretty JSON?
10. Which workflows cause repeated snapshots?

## Flows

11. What exactly does current flow recorder store?
12. How are flows persisted/versioned now?
13. Which flow execution path differs from normal actions?
14. How is ambiguity currently handled?
15. Which expected-state concepts already exist?

## Overlay/evidence

16. Which actions directly call overlay rendering?
17. Is overlay recorded in current capture frames?
18. Where are recording artifacts persisted?
19. Can current screencast timestamps be aligned reliably with action events?
20. What failure evidence already exists in logs?

## Telemetry

21. Which CDP Network events are currently captured?
22. Are CDP monotonic timestamps retained?
23. Are initiator stacks retained?
24. What does current HAR export fabricate or approximate?
25. Which performance/process metrics are real versus heuristics?

## Runtime code

26. Is Debugger domain currently enabled anywhere?
27. Is script source/source-map data collected?
28. Is Runtime/Profiler currently used?
29. Can request initiators already expose call stacks?
30. Is there any existing source-workspace/cache implementation?

## Rust/data plane

31. Which data operations are actually CPU/memory hotspots today?
32. What is current daemon memory under long capture?
33. Is SQLite currently safe to migrate to a single Rust owner?
34. Which current APIs should remain Bun facades during migration?
35. Is MessagePack worth adding versus the current binary protocol?

## Security

36. Which daemon endpoints mutate browser/system state?
37. Which endpoints currently allow broad CORS/origin access?
38. What authenticates extension WebSocket connection?
39. What protects CLI-agent custom command execution?
40. How are personal tabs distinguished from workspace tabs?

---

# 37. Expected output from the first Luna xhigh audit

The first audit should **not implement the refactor**.

Produce a report roughly shaped as:

```text
1. Executive summary

2. Architecture found
   - extension
   - daemon
   - protocol
   - storage
   - UI
   - benchmark

3. PLANS.md validation matrix
   Proposal | Status | Evidence | Recommendation

4. Feature disposition corrections

5. Critical findings
   P0
   P1
   P2

6. Token-efficiency audit
   schema cost
   response waste
   repeated context
   likely biggest wins

7. Refactor dependency graph

8. Revised phase ordering

9. Files/modules likely touched per phase

10. Risks and rollback strategy

11. Recommended edits to PLANS.md
```

The audit should challenge this document where appropriate.

The goal is not to prove the plan correct.

The goal is to arrive at a repository-grounded plan that can be safely implemented by agents over multiple phases.

---

# 38. Final architectural principle

The system should optimize for:

```text
MASSIVE LOCAL KNOWLEDGE
         ↓
SMALL DETERMINISTIC PROJECTION
         ↓
FEW MODEL DECISIONS
         ↓
RELIABLE ACTION
         ↓
STRUCTURED EVIDENCE
```

BrowserControl should become smarter locally so the language model needs to see **less**, call tools **less**, retry **less**, and still obtain **more reliable control and deeper web-development context**.

That principle should guide every refactor decision in this repository.
