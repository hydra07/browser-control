package main

import (
	"context"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/hydra07/browsercontrol/cli/internal/bench"
	"github.com/hydra07/browsercontrol/cli/internal/devtools"
)

const (
	commandBenchRender = "bench-render"
	devUsage           = `Usage: browsercontrol dev <dump-fixture|bench-render> [options]

  dump-fixture <url|fixture:name>  collect sanitized DOM/AX/frame fixtures
  bench-render [file|directory]   benchmark offline projection and CLI rendering

Use 'browsercontrol dev <command> --help' for command-specific flags.
`
	benchUsage = `Usage: browsercontrol dev bench-render [capture.json|directory] [--json]

Default input: fixtures/synthetic/captures/ in this worktree (sorted, non-recursive).
No browser, session state, bridge, Bun or network is used.
Only v1 synthetic/public capture fixtures are accepted; sequence/private files are rejected.

Flags: --runs 20 (10..1000) --warmup 3 (0..100)
       --encoding o200k_base|cl100k_base --grep <text> --limit 80 (0 for all)
       --timeout 30s --json --help

JSON schema v1 records fixture/output hashes, bytes, real BPE token counts, node counts and
nearest-rank p50/p95 wall time in nanoseconds for projection, agent render and JSON encoding.
Windows uses QueryPerformanceCounter; other platforms use Go's monotonic clock.
Clock frequency and empty-read overhead are reported; timing overhead is not subtracted.
Counts include the final stdout newline; JSON uses the CLI's unescaped HTML policy.
Token counts describe ordinary text, without chat/tool wrappers or special-token interpretation.
Timing excludes fixture I/O/validation, tokenizer initialization/counting and stdout I/O.
The pipeline timing includes both output formats, not a single production command's latency.

Limits: 64 files, 16 MiB/file, 64 MiB/corpus, 100000 nodes/capture, 1 MiB/rendered payload.
The corpus also has a 250000-node/256-observed-frame cap.
Use '--json > report.json' to save metrics. --out applies only to dump-fixture.
The Go AX replay is an offline legacy-flat projection, not page core or Chrome renderer CPU.
Legacy text merging/clipping can discard content; fewer tokens do not prove task completeness.
`
)

func runBenchCommand(options directOptions, g globalOpts) int {
	if len(options.positionals) < 2 || len(options.positionals) > 3 {
		return reportError(g, usagef("usage: browsercontrol dev bench-render [capture.json|directory]"))
	}
	if options.headless || options.noSandbox || options.executable != "" || options.profile != "" || options.allowPrivate || options.out != "" || options.target != "" || options.maxNodes != 0 || options.maxFrames != 0 {
		return reportError(g, usagef("browser and fixture flags do not apply to offline bench-render"))
	}
	if err := options.bench.Validate(); err != nil {
		return reportError(g, usagef("%v", err))
	}
	ctx, interrupt := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer interrupt()
	ctx, cancel := context.WithTimeout(ctx, options.timeout)
	defer cancel()
	source := ""
	if len(options.positionals) == 3 {
		source = options.positionals[2]
	} else {
		root, err := devtools.Worktree(ctx)
		if err != nil {
			return reportError(g, err)
		}
		source = filepath.Join(root, "fixtures", "synthetic", "captures")
	}
	report, err := bench.Run(ctx, source, options.bench, renderBenchView)
	if err != nil {
		return reportError(g, err)
	}
	(&session{g: g}).print(output{data: report, text: bench.Summary(report)})
	return 0
}

func renderBenchView(nodes []any, options bench.Options) bench.View {
	out := flatSnapshotView(formatEntries(nodes), options.Grep, options.Limit)
	data := out.data.(map[string]any)
	return bench.View{Text: out.text, Data: out.data, Shown: data["shown"].(int), Total: data["total"].(int)}
}
