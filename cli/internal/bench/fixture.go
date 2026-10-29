package bench

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/hydra07/browsercontrol/cli/internal/devtools"
	"github.com/hydra07/browsercontrol/cli/internal/privacy"
)

const (
	maxFixtureBytes = 16 << 20
	maxCorpusBytes  = 64 << 20
	maxFixtureFiles = 64
	maxCaptureNodes = 100000
)

type fixtureInput struct {
	name, hash string
	bytes      int
	fixture    devtools.Fixture
}

func loadInputs(ctx context.Context, source string) ([]fixtureInput, error) {
	info, err := os.Lstat(source)
	if err != nil {
		return nil, errors.New("cannot read benchmark input")
	}
	paths := []string{source}
	if info.IsDir() {
		entries, err := os.ReadDir(source)
		if err != nil {
			return nil, errors.New("cannot read benchmark directory")
		}
		paths = nil
		for _, entry := range entries {
			if strings.EqualFold(filepath.Ext(entry.Name()), ".json") && !entry.IsDir() {
				paths = append(paths, filepath.Join(source, entry.Name()))
			}
		}
	}
	if len(paths) == 0 || len(paths) > maxFixtureFiles {
		return nil, errors.New("benchmark requires 1 to 64 capture JSON files (directory scan is not recursive)")
	}
	slices.Sort(paths)
	inputs := make([]fixtureInput, 0, len(paths))
	totalBytes := 0
	totalNodes, totalFrames := 0, 0
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		input, err := readInput(path)
		if err != nil {
			return nil, err
		}
		totalBytes += input.bytes
		if totalBytes > maxCorpusBytes {
			return nil, errors.New("benchmark corpus exceeds 64 MiB")
		}
		for _, tree := range input.fixture.Snapshot.Accessibility {
			totalNodes += len(tree.Nodes)
			totalFrames++
		}
		for _, document := range input.fixture.Snapshot.Documents {
			totalNodes += len(document.Nodes)
		}
		if totalNodes > 250000 || totalFrames > 256 {
			return nil, errors.New("benchmark corpus exceeds 250000 DOM/AX nodes or 256 observed frames")
		}
		inputs = append(inputs, input)
	}
	return inputs, ctx.Err()
}

func readInput(path string) (fixtureInput, error) {
	file, err := os.Open(path)
	if err != nil {
		return fixtureInput{}, errors.New("cannot open benchmark fixture")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxFixtureBytes {
		return fixtureInput{}, errors.New("benchmark fixture must be a regular file of at most 16 MiB")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxFixtureBytes+1))
	if err != nil || len(data) > maxFixtureBytes {
		return fixtureInput{}, errors.New("cannot read bounded benchmark fixture")
	}
	if findings := privacy.CheckFile("fixtures/public/"+filepath.Base(path), data); len(findings) > 0 {
		return fixtureInput{}, fmt.Errorf("benchmark fixture rejected by privacy gate: %s", findings[0].Code)
	}
	var fixture devtools.Fixture
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil {
		return fixtureInput{}, errors.New("benchmark input must use the capture fixture schema (not sequences)")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fixtureInput{}, errors.New("benchmark fixture contains trailing JSON")
	}
	if err := validateFixture(fixture); err != nil {
		return fixtureInput{}, err
	}
	hash := sha256.Sum256(data)
	return fixtureInput{name: filepath.Base(path), hash: hex.EncodeToString(hash[:]), bytes: len(data), fixture: fixture}, nil
}

func validateFixture(fixture devtools.Fixture) error {
	if fixture.SchemaVersion != 1 || fixture.Observation != "snapshot_at" || fixture.Classification != devtools.Synthetic && fixture.Classification != devtools.Public {
		return errors.New("benchmark requires a v1 snapshot_at synthetic/public capture; private captures are not accepted")
	}
	capture := fixture.Snapshot
	if len(capture.Frames) == 0 || len(capture.Frames) > 128 || len(capture.Accessibility) == 0 || len(capture.Accessibility) > 128 {
		return errors.New("benchmark capture requires bounded frame and AX trees")
	}
	frames := make(map[string]bool, len(capture.Frames))
	for _, frame := range capture.Frames {
		if frame.ID == "" || frames[frame.ID] {
			return errors.New("benchmark frame IDs must be nonempty and unique")
		}
		frames[frame.ID] = true
	}
	count := 0
	for _, document := range capture.Documents {
		count += len(document.Nodes)
	}
	seenFrames := make(map[string]bool)
	for _, tree := range capture.Accessibility {
		if !frames[tree.FrameID] || seenFrames[tree.FrameID] {
			return errors.New("benchmark AX trees must belong to distinct captured frames")
		}
		seenFrames[tree.FrameID] = true
		seen := make(map[string]bool, len(tree.Nodes))
		for _, node := range tree.Nodes {
			if node.ID == "" || seen[node.ID] || node.Handle < 0 {
				return errors.New("benchmark AX IDs must be unique per frame and handles nonnegative")
			}
			seen[node.ID] = true
		}
		count += len(tree.Nodes)
	}
	if count > maxCaptureNodes {
		return errors.New("benchmark capture exceeds 100000 DOM/AX nodes")
	}
	return nil
}
