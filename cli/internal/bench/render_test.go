package bench

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/hydra07/browsercontrol/cli/internal/devtools"
	"github.com/hydra07/browsercontrol/cli/internal/driver"
)

func fixtureForTest() devtools.Fixture {
	return devtools.Fixture{SchemaVersion: 1, Classification: devtools.Synthetic, SourceURL: "fixture:bench", Observation: "snapshot_at",
		Snapshot: driver.Capture{Epoch: "fixture_test", Frames: []driver.Frame{{ID: "main"}}, Accessibility: []driver.AccessTree{{FrameID: "main", Nodes: []driver.AccessNode{{ID: "button", Handle: 1, Role: "button", Name: "Save"}}}}}}
}

func writeFixture(t *testing.T, fixture devtools.Fixture) string {
	t.Helper()
	data, err := json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "capture.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func testView(nodes []any, _ Options) View {
	return View{Text: "hello world", Data: map[string]any{"text": "hello world"}, Shown: len(nodes), Total: len(nodes)}
}

func TestTokenizerUsesReferenceBPEAndOrdinaryText(t *testing.T) {
	for _, encoding := range []string{O200kBase, Cl100kBase} {
		t.Run(encoding, func(t *testing.T) {
			counter, err := newCounter(encoding)
			if err != nil {
				t.Fatal(err)
			}
			for _, text := range []string{"", "hello world", "Tiếng Việt: Lưu đơn hàng 👋", "<|endoftext|>", "[42] button \"Save\"\n"} {
				ids, _, err := counter.Encode(text)
				if err != nil {
					t.Fatal(err)
				}
				count, err := counter.Count(text)
				decoded, decodeErr := counter.Decode(ids)
				if err != nil || decodeErr != nil || decoded != text || count != len(ids) {
					t.Fatal("token counting must match lossless ordinary-text BPE encoding")
				}
				if encoding == Cl100kBase && text == "hello world" && !slices.Equal(ids, []uint{15339, 1917}) {
					t.Fatalf("OpenAI's public cl100k reference vector changed: %v", ids)
				}
				if text == "<|endoftext|>" && count <= 1 {
					t.Fatal("page text must not acquire a special-token interpretation")
				}
			}
		})
	}
}

func TestReportFingerprintsExecutableAndDoesNotEchoFilter(t *testing.T) {
	options := DefaultOptions()
	options.Grep = "password=do-not-echo-filter"
	report, err := Run(context.Background(), writeFixture(t, fixtureForTest()), options, testView)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), options.Grep) || report.FilterSHA256 != digest(options.Grep) || len(report.Environment.ExecutableSHA256) != 64 || report.Environment.ExecutableBytes <= 0 {
		t.Fatal("report must identify executable/filter without exposing their contents or paths")
	}
}

func TestProjectionPreservesLegacyFilteringAndMergeRules(t *testing.T) {
	nodes := []driver.AccessNode{
		{ID: "root", Role: "RootWebArea", Children: []string{"button", "a", "b", "hidden"}},
		{ID: "button", Role: "button", Name: "Save", Handle: 4, Children: []string{"label"}},
		{ID: "label", Role: "StaticText", Name: "Save", Handle: 5},
		{ID: "a", Role: "StaticText", Name: "Hi", Handle: 10},
		{ID: "b", Role: "StaticText", Name: "there", Handle: 12},
		{ID: "hidden", Role: "button", Name: "No backend"},
		{ID: "blank", Role: "heading", Name: "  \n "},
	}
	before := slices.Clone(nodes)
	projected := ProjectFlatAX(nodes)
	expected := []any{map[string]any{"i": float64(4), "r": "button", "n": "Save"}, map[string]any{"i": float64(10), "r": "StaticText", "n": "Hi there"}}
	if !reflect.DeepEqual(projected, expected) || !reflect.DeepEqual(nodes, before) {
		t.Fatalf("incorrect legacy projection: %+v", projected)
	}
	cycle := []driver.AccessNode{{ID: "button", Role: "button", Handle: 1, Children: []string{"loop"}}, {ID: "loop", Role: "generic", Children: []string{"loop"}}}
	if len(ProjectFlatAX(cycle)) != 1 {
		t.Fatal("cyclic child links must remain bounded")
	}
}

func TestProjectionBoundsMergedTextLikeUTF16Collector(t *testing.T) {
	nodes := []driver.AccessNode{{ID: "a", Handle: 1, Role: "StaticText", Name: strings.Repeat("👋", 250)}, {ID: "b", Handle: 2, Role: "StaticText", Name: "tail"}}
	entries, truncated := projectFlatAX(nodes)
	name := entries[0].(map[string]any)["n"].(string)
	if !truncated || name != strings.Repeat("👋", 249)+"�…" {
		t.Fatal("merged text must use the collector's 500 UTF-16-unit bound and wire-decoded surrogate behavior")
	}
}

func TestBenchmarkClockHasMonotonicReads(t *testing.T) {
	clock, err := newBenchmarkClock()
	if err != nil {
		t.Fatal(err)
	}
	previous := clock.now()
	for range 100 {
		current := clock.now()
		if current < previous || clock.elapsed(previous, current) < 0 {
			t.Fatal("benchmark clock moved backwards")
		}
		previous = current
	}
	overhead := clockReadOverhead(clock)
	if overhead.Samples != 128 || overhead.MinNS < 0 || overhead.P95NS < overhead.P50NS {
		t.Fatal("invalid clock calibration")
	}
}

func TestReportScopesFramesAndUsesStableHashes(t *testing.T) {
	fixture := fixtureForTest()
	fixture.Snapshot.Frames = append(fixture.Snapshot.Frames, driver.Frame{ID: "child", ParentID: "main"})
	fixture.Snapshot.Accessibility = append(fixture.Snapshot.Accessibility, driver.AccessTree{FrameID: "child", Nodes: slices.Clone(fixture.Snapshot.Accessibility[0].Nodes)})
	fixture.Snapshot.Truncated = true
	fixture.Snapshot.MissingFrames = []string{"unavailable"}
	path := writeFixture(t, fixture)
	options := DefaultOptions()
	options.Runs, options.Warmup = 10, 0
	report, err := Run(context.Background(), path, options, testView)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Cases) != 2 || report.Cases[1].FrameIndex != 1 {
		t.Fatal("each observed frame needs its own benchmark case")
	}
	for _, result := range report.Cases {
		if result.ProjectedNodes != 1 || !result.InputTruncated || result.MissingFrames != 1 || result.Agent.SHA256 != digest("hello world\n") || result.JSON.SHA256 != digest("{\"text\":\"hello world\"}\n") || result.Timings.Pipeline.Samples != 10 {
			t.Fatalf("invalid scoped metrics: %+v", result)
		}
	}
}

func TestBenchmarkRejectsInvalidInputsWithoutContentInErrors(t *testing.T) {
	for _, change := range []func(*devtools.Fixture){
		func(f *devtools.Fixture) { f.Classification = devtools.Private },
		func(f *devtools.Fixture) { f.SchemaVersion = 99 },
		func(f *devtools.Fixture) { f.Observation = "final" },
		func(f *devtools.Fixture) { f.Snapshot.Accessibility[0].Nodes[0].Name = "password=never-print-this" },
		func(f *devtools.Fixture) { f.Snapshot.Accessibility[0].FrameID = "unknown" },
		func(f *devtools.Fixture) {
			f.Snapshot.Accessibility[0].Nodes = append(f.Snapshot.Accessibility[0].Nodes, f.Snapshot.Accessibility[0].Nodes[0])
		},
	} {
		fixture := fixtureForTest()
		change(&fixture)
		_, err := Run(context.Background(), writeFixture(t, fixture), DefaultOptions(), testView)
		if err == nil || strings.Contains(err.Error(), "never-print-this") {
			t.Fatalf("invalid fixture should be rejected without its contents: %v", err)
		}
	}
	for _, data := range []string{`{"schemaVersion":1,"extra":"unsupported"}`, `{} {}`, `{"kind":"action","states":[]}`} {
		path := filepath.Join(t.TempDir(), "bad.json")
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadInputs(context.Background(), path); err == nil {
			t.Fatal("unknown/trailing/sequence JSON must not become an empty benchmark")
		}
	}
	path := filepath.Join(t.TempDir(), "large.json")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maxFixtureBytes + 1); err != nil {
		t.Fatal(err)
	}
	file.Close()
	if _, err := loadInputs(context.Background(), path); err == nil {
		t.Fatal("oversized input must fail before decode")
	}
}

func TestBenchmarkCancellationAndNondeterminism(t *testing.T) {
	path := writeFixture(t, fixtureForTest())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Run(ctx, path, DefaultOptions(), testView); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled benchmark: %v", err)
	}
	count := 0
	renderer := func(nodes []any, options Options) View {
		count++
		view := testView(nodes, options)
		view.Text = strings.Repeat("x", count)
		return view
	}
	if _, err := Run(context.Background(), path, DefaultOptions(), renderer); err == nil || !strings.Contains(err.Error(), "nondeterministic") {
		t.Fatalf("unstable output produced benchmark evidence: %v", err)
	}
	oversized := func(nodes []any, options Options) View {
		view := testView(nodes, options)
		view.Text = strings.Repeat("x", maxRenderedBytes+1)
		return view
	}
	if _, err := Run(context.Background(), path, DefaultOptions(), oversized); err == nil || !strings.Contains(err.Error(), "1 MiB") {
		t.Fatalf("oversized output: %v", err)
	}
}

func TestNearestRankDistribution(t *testing.T) {
	samples := []int64{20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1}
	actual := distribution(samples)
	if actual != (Distribution{Samples: 20, MinNS: 1, P50NS: 10, P95NS: 19, MaxNS: 20}) {
		t.Fatalf("nearest-rank distribution: %+v", actual)
	}
}
