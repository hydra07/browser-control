package baseline

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOSProcessEvidenceChecksImageAndStableCreationTime(t *testing.T) {
	image, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	before, err := readProcess(os.Getpid(), image)
	if err != nil {
		t.Fatal(err)
	}
	after, err := readProcess(os.Getpid(), image)
	if err != nil {
		t.Fatal(err)
	}
	if err := validatePair(before, after); err != nil || before.ParentPID <= 0 {
		t.Fatalf("invalid OS continuity: %v", err)
	}
	if _, err := readProcess(os.Getpid(), filepath.Join(filepath.Dir(image), "wrong-executable.exe")); err == nil {
		t.Fatal("wrong executable accepted")
	}
}
