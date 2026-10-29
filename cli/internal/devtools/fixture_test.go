package devtools

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func fixtureWorktree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := exec.Command("git", "-C", root, "init", "-q").Run(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("data/\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestPrivateCaptureCannotBeWrittenOutsideIgnoredLocalStorage(t *testing.T) {
	root := fixtureWorktree(t)
	for _, out := range []string{"fixtures/public/private.json", "private.json", "../outside.json"} {
		if _, err := PrepareOutput(context.Background(), root, out, Private); err == nil {
			t.Error("private output escaped local storage")
		}
	}
	plan, err := PrepareOutput(context.Background(), root, "", Private)
	if err != nil {
		t.Fatal(err)
	}
	if err := plan.Write(Fixture{SchemaVersion: 1, Classification: Private}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(plan.Path); err != nil {
		t.Fatal(err)
	}
}

func TestFixtureWritesAreBoundedSanitizedAndDoNotOverwrite(t *testing.T) {
	root := fixtureWorktree(t)
	plan, err := PrepareOutput(context.Background(), root, "fixtures/synthetic/test.json", Synthetic)
	if err != nil {
		t.Fatal(err)
	}
	if err := plan.Write(Fixture{SchemaVersion: 1, Classification: Public}); err == nil {
		t.Fatal("classification changed after validation")
	}
	fixture := Fixture{SchemaVersion: 1, Classification: Synthetic, SourceURL: "https://example.test/orders?token=not-safe"}
	if err := plan.Write(fixture); err == nil {
		t.Fatal("unsafe capture was written")
	}
	if _, err := os.Stat(plan.Path); !os.IsNotExist(err) {
		t.Fatal("failed capture left a partial file")
	}
	fixture.SourceURL = "https://example.test/orders?orderId=ORD-42"
	if err := plan.Write(fixture); err != nil {
		t.Fatal(err)
	}
	if err := plan.Write(fixture); err == nil {
		t.Fatal("existing fixture overwritten")
	}
	plan.Path = filepath.Join(root, "changed.json")
	if err := plan.Write(fixture); err == nil {
		t.Fatal("destination changed after validation")
	}
	plan.Path = plan.validatedPath
	data, _ := os.ReadFile(plan.Path)
	if !json.Valid(data) {
		t.Fatal("fixture was partially published")
	}
}

func TestSyntheticSuiteHasTenDistinctReadyPages(t *testing.T) {
	names := FixtureNames()
	if len(names) < 10 {
		t.Fatalf("only %d fixtures", len(names))
	}
	server, err := StartFixtureServer()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	for _, name := range names {
		if _, err := server.URL(name); err != nil {
			t.Fatal(err)
		}
	}
}
