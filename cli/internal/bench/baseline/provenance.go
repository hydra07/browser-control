package baseline

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

func hash(data []byte) string {
	value := sha256.Sum256(data)
	return hex.EncodeToString(value[:])
}

func fileHash(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return hash(data), nil
}

func treeHash(root string, include func(string) bool) (string, int, error) {
	var paths []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("benchmark input trees cannot contain symlinks")
		}
		if entry.IsDir() {
			if entry.Name() == "node_modules" || entry.Name() == ".output" || entry.Name() == ".wxt" {
				return filepath.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		if include(filepath.ToSlash(rel)) {
			paths = append(paths, rel)
		}
		return nil
	})
	if err != nil {
		return "", 0, err
	}
	slices.Sort(paths)
	var content bytes.Buffer
	for _, path := range paths {
		value, err := fileHash(filepath.Join(root, path))
		if err != nil {
			return "", 0, err
		}
		fmt.Fprintf(&content, "%s\x00%s\n", filepath.ToSlash(path), value)
	}
	return hash(content.Bytes()), len(paths), nil
}

func provenance(ctx context.Context, c Config) (map[string]any, error) {
	paths := []string{"cli", "app", "packages", "assets", "package.json", "bun.lock", "turbo.json", "biome.json", ".gitignore", ".gitattributes"}
	args := append([]string{"ls-tree", "-r", "--name-only", SourceCommit, "--"}, paths...)
	command := exec.CommandContext(ctx, "git", args...)
	command.Dir = c.Root
	listing, err := command.Output()
	if err != nil {
		return nil, errors.New("cannot enumerate baseline commit inputs")
	}
	const endpointFile = "app/extension/entrypoints/offscreen/main.ts"
	var verified bytes.Buffer
	var originalEndpointHash, patchedEndpointHash string
	count := 0
	for _, path := range strings.Fields(string(listing)) {
		command := exec.CommandContext(ctx, "git", "show", SourceCommit+":"+path)
		command.Dir = c.Root
		original, err := command.Output()
		if err != nil {
			return nil, fmt.Errorf("cannot read original build input %s", path)
		}
		actual, err := os.ReadFile(filepath.Join(c.Source, filepath.FromSlash(path)))
		if err != nil {
			return nil, fmt.Errorf("missing archived build input %s", path)
		}
		expected := original
		if path == endpointFile {
			old := []byte("ws://127.0.0.1:8765")
			if bytes.Count(original, old) != 1 {
				return nil, errors.New("unexpected original endpoint configuration")
			}
			expected = bytes.Replace(original, old, fmt.Appendf(nil, "ws://127.0.0.1:%d", c.Port), 1)
			originalEndpointHash, patchedEndpointHash = hash(original), hash(expected)
		}
		if !bytes.Equal(expected, actual) {
			return nil, fmt.Errorf("archived build input differs outside declared endpoint patch: %s", path)
		}
		fmt.Fprintf(&verified, "%s\x00%s\n", path, hash(original))
		count++
	}
	if count == 0 || originalEndpointHash == "" {
		return nil, errors.New("baseline source verification found no original runtime inputs")
	}
	archiveHash, err := fileHash(c.Archive)
	if err != nil {
		return nil, err
	}
	bridgeHash, err := fileHash(c.Bridge)
	if err != nil {
		return nil, err
	}
	chromeHash, err := fileHash(c.Chrome)
	if err != nil {
		return nil, err
	}
	zipHash, err := fileHash(filepath.Join(filepath.Dir(filepath.Dir(c.Chrome)), "chrome-win64.zip"))
	if err != nil {
		return nil, errors.New("official Chrome for Testing archive must be retained beside chrome-win64 for provenance")
	}
	extensionHash, extensionFiles, err := treeHash(c.Extension, func(string) bool { return true })
	if err != nil || extensionFiles == 0 {
		return nil, errors.New("cannot hash original extension build")
	}
	harnessHash, harnessFiles, err := treeHash(filepath.Join(c.Root, "cli"), func(path string) bool {
		return strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, "_test.go") || path == "go.mod" || path == "go.sum"
	})
	if err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	executableHash, err := fileHash(executable)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"baselineSource": "archived original runtime inputs; extension endpoint-only patch; no current product source substituted",
		"archiveSha256":  archiveHash, "originalInputsSha256": hash(verified.Bytes()), "verifiedOriginalFiles": count,
		"endpointPatch":          map[string]any{"file": endpointFile, "originalSha256": originalEndpointHash, "patchedSha256": patchedEndpointHash, "fromPort": 8765, "toPort": c.Port},
		"bridgeExecutableSha256": bridgeHash, "extensionTreeSha256": extensionHash, "extensionFiles": extensionFiles,
		"chromeExecutableSha256": chromeHash, "harnessExecutableSha256": executableHash,
		"chromeArchiveSha256": zipHash, "chromeDistribution": "Chrome for Testing win64; official version/download recorded after Browser.getVersion",
		"harnessGoInputsSha256": harnessHash, "harnessGoInputFiles": harnessFiles,
		"harnessScope": "current worktree instrumentation; not the original product binary",
		"go":           runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH, "logicalCPUs": runtime.NumCPU(),
		"tokenizer": "github.com/tiktoken-go/tokenizer v0.8.1 / o200k_base / ordinary_text",
	}, nil
}
