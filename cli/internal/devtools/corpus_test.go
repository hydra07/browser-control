package devtools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hydra07/browsercontrol/cli/internal/privacy"
)

func TestVersionedCaptureCorpusHasTenCompleteSanitizedFixtures(t *testing.T) {
	for _, name := range FixtureNames() {
		path := filepath.Join("..", "..", "..", "fixtures", "synthetic", "captures", name+".json")
		data, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("missing captured fixture %s: %v", name, err)
			continue
		}
		if findings := privacy.CheckFile("fixtures/synthetic/captures/"+name+".json", data); len(findings) > 0 {
			t.Errorf("%s: %+v", name, findings)
		}
		var fixture Fixture
		if err := json.Unmarshal(data, &fixture); err != nil {
			t.Fatal(err)
		}
		capture := fixture.Snapshot
		if fixture.SchemaVersion != 1 || fixture.Classification != Synthetic || fixture.SourceURL != "fixture:"+name || fixture.Observation != "snapshot_at" || capture.Truncated || len(capture.Frames) == 0 || len(capture.Documents) == 0 || len(capture.Accessibility) == 0 {
			t.Errorf("incomplete corpus fixture %s", name)
		}
		if !strings.HasPrefix(capture.Epoch, "fixture_") || strings.Contains(string(data), "127.0.0.1:") {
			t.Errorf("unstable origin/epoch in %s", name)
		}
		if name == "modal" {
			modal := false
			for _, tree := range capture.Accessibility {
				for _, node := range tree.Nodes {
					modal = modal || node.Role == "dialog" && node.States["modal"] == "true"
				}
			}
			if !modal {
				t.Fatal("versioned modal fixture is not modal")
			}
		}
	}
}
