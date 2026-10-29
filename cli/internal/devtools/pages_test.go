package devtools

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"strings"
	"testing"

	"github.com/hydra07/browsercontrol/cli/internal/privacy"
)

func TestEmbeddedPagesContainOnlySyntheticData(t *testing.T) {
	files, err := fs.Glob(pages, "pages/*.html")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		data, err := pages.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if findings := privacy.CheckFile("fixtures/synthetic/"+strings.TrimPrefix(file, "pages/"), data); len(findings) > 0 {
			t.Errorf("%s: %+v", file, findings)
		}
	}
}

func TestVendoredReactMatchesIntegrityManifest(t *testing.T) {
	data, err := pages.ReadFile("pages/vendor/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest map[string]struct {
		Version, Source, Integrity string
		SHA256                     map[string]string
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest) != 2 {
		t.Fatal("missing React package provenance")
	}
	for _, pkg := range manifest {
		if pkg.Version != "18.3.1" || !strings.HasPrefix(pkg.Source, "https://registry.npmjs.org/") || !strings.HasPrefix(pkg.Integrity, "sha512-") {
			t.Fatal("unversioned fixture dependency")
		}
		for name, expected := range pkg.SHA256 {
			data, err := pages.ReadFile("pages/vendor/" + name)
			if err != nil {
				t.Fatal(err)
			}
			hash := sha256.Sum256(data)
			if hex.EncodeToString(hash[:]) != expected {
				t.Errorf("vendored dependency changed: %s", name)
			}
		}
	}
}
