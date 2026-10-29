package devtools

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
	"github.com/hydra07/browsercontrol/cli/internal/privacy"
)

type Classification string

const (
	Public    Classification = "public"
	Synthetic Classification = "synthetic"
	Private   Classification = "private"
)

type Fixture struct {
	SchemaVersion  int            `json:"schemaVersion"`
	Classification Classification `json:"classification"`
	SourceURL      string         `json:"sourceURL"`
	Observation    string         `json:"observation"`
	Snapshot       driver.Capture `json:"snapshot"`
}

type OutputPlan struct {
	Path          string
	validatedPath string
	class         Classification
}

func PrepareOutput(ctx context.Context, root, out string, class Classification) (*OutputPlan, error) {
	if class != Public && class != Synthetic && class != Private {
		return nil, errors.New("unknown fixture classification")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, errors.New("invalid fixture worktree")
	}
	if out == "" {
		out = filepath.Join("data", "fixtures", string(class), "capture-"+rand.Text()+".json")
	}
	if !filepath.IsAbs(out) {
		out = filepath.Join(root, out)
	}
	out, err = filepath.Abs(out)
	if err != nil || filepath.Ext(out) != ".json" {
		return nil, errors.New("fixture output requires a .json file")
	}
	if privacy.NewScrubber(nil).Text(out) != out {
		return nil, errors.New("fixture filename contains credential-like data")
	}
	relative, err := filepath.Rel(root, out)
	if err != nil && class == Private {
		return nil, errors.New("invalid fixture destination")
	}
	relative = filepath.ToSlash(relative)
	if class == Private {
		if !strings.HasPrefix(relative, "data/fixtures/private/") {
			return nil, errors.New("private fixture output must stay under data/fixtures/private/")
		}
		if err := exec.CommandContext(ctx, "git", "-C", root, "check-ignore", "--no-index", "-q", "--", relative).Run(); err != nil {
			return nil, errors.New("private fixture directory must be gitignored")
		}
		if exec.CommandContext(ctx, "git", "-C", root, "ls-files", "--error-unmatch", "--", relative).Run() == nil {
			return nil, errors.New("private fixture destination is tracked by Git")
		}
	}
	if strings.HasPrefix(relative, "fixtures/") && !strings.HasPrefix(relative, "fixtures/"+string(class)+"/") {
		return nil, errors.New("fixture directory must match the capture classification")
	}
	if err := noLinks(out); err != nil {
		return nil, err
	}
	if _, err := os.Lstat(out); !os.IsNotExist(err) {
		return nil, errors.New("fixture destination already exists or is unreadable")
	}
	return &OutputPlan{Path: out, validatedPath: out, class: class}, nil
}

func (p *OutputPlan) Write(fixture Fixture) error {
	if p.Path != p.validatedPath || fixture.Classification != p.class || fixture.SchemaVersion != 1 {
		return errors.New("fixture output classification/schema changed")
	}
	return p.writeJSON(fixture)
}

func (p *OutputPlan) writeJSON(value any) error {
	if p.Path != p.validatedPath {
		return errors.New("fixture output destination changed")
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return errors.New("cannot encode fixture")
	}
	if len(privacy.CheckFile("fixtures/public/capture.json", data)) != 0 {
		return errors.New("fixture failed the privacy or size gate; no file was published")
	}
	if err := noLinks(p.Path); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p.Path), 0700); err != nil {
		return errors.New("cannot create fixture output directory")
	}
	if err := noLinks(p.Path); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(p.Path), ".bc-fixture-")
	if err != nil {
		return errors.New("cannot prepare fixture output")
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(append(data, '\n'))
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		return errors.New("cannot persist complete fixture")
	}
	// Linking a complete sibling file publishes atomically without replacing an existing capture.
	if err := os.Link(file.Name(), p.Path); err != nil {
		return errors.New("cannot publish fixture; destination exists or filesystem does not support atomic linking")
	}
	return nil
}

func noLinks(name string) error {
	for {
		info, err := os.Lstat(name)
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return errors.New("fixture output cannot traverse symlinks")
		}
		if err != nil && !os.IsNotExist(err) {
			return errors.New("fixture output path is unreadable")
		}
		parent := filepath.Dir(name)
		if parent == name {
			return nil
		}
		name = parent
	}
}

func Worktree(ctx context.Context) (string, error) {
	command := exec.CommandContext(ctx, "git", "rev-parse", "--show-toplevel")
	data, err := command.Output()
	if err != nil {
		return "", errors.New("run fixture collection from a Git worktree")
	}
	return strings.TrimSpace(string(data)), nil
}

func NormalizeSynthetic(fixture Fixture, origin string) Fixture {
	data, _ := json.Marshal(fixture.Snapshot)
	data = []byte(strings.ReplaceAll(string(data), origin, "http://fixture.test"))
	_ = json.Unmarshal(data, &fixture.Snapshot)
	return fixture
}
