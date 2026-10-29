package session

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/statefile"
)

const (
	SchemaVersion = 1
	maxStateBytes = 64 * 1024
)

var (
	validID    = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	reservedID = regexp.MustCompile(`^(con|prn|aux|nul|com[1-9]|lpt[1-9])$`)
)

type Target struct {
	DocumentID string `json:"documentId,omitempty"`
	TabID      int    `json:"tabId,omitempty"`
}

type State struct {
	SchemaVersion  int             `json:"schemaVersion"`
	ID             string          `json:"id"`
	LastTarget     Target          `json:"lastTarget"`
	Permissions    *Permissions    `json:"permissions,omitempty"`
	Browser        *BrowserBinding `json:"browser,omitempty"`
	DirectTarget   string          `json:"directTarget,omitempty"`
	DirectDocument string          `json:"directDocument,omitempty"`
	DirectTabs     []string        `json:"directTabs,omitempty"`
}

type BrowserBinding struct {
	Mode    string       `json:"mode"`
	Profile string       `json:"profile"`
	ID      string       `json:"id"`
	Process OwnedProcess `json:"process"`
}

func (s State) EffectivePermissions() Permissions {
	if s.Permissions != nil {
		return *s.Permissions
	}
	return DefaultPermissions()
}

type Store struct {
	id   string
	path string
	root string
	now  func() time.Time
}

// ValidateID rejects aliases and nonportable paths rather than silently changing session identity.
func ValidateID(id string) error {
	if !validID.MatchString(id) || reservedID.MatchString(id) {
		return errors.New("session ID must be 1–64 lowercase ASCII letters, digits, '_' or '-', start with a letter or digit, and not be a reserved Windows device name")
	}
	return nil
}

func NewStore(root, id string) (*Store, error) {
	if err := ValidateID(id); err != nil {
		return nil, err
	}
	return &Store{id: id, path: filepath.Join(root, "sessions", id, "session.json"), root: root, now: time.Now}, nil
}

func (s *Store) Load() (State, error) {
	file, err := os.Open(s.path)
	if err != nil {
		return State{}, fmt.Errorf("read session %q: %w", s.id, err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxStateBytes+1))
	if err != nil {
		return State{}, fmt.Errorf("read session %q: %w", s.id, err)
	}
	if len(data) > maxStateBytes {
		return State{}, fmt.Errorf("session %q exceeds %d bytes", s.id, maxStateBytes)
	}
	var state State
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		return State{}, fmt.Errorf("decode session %q: %w", s.id, err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return State{}, fmt.Errorf("session %q contains trailing data", s.id)
	}
	if err := s.validate(state); err != nil {
		return State{}, err
	}
	return state, nil
}

func (s *Store) Save(state State) error {
	if err := s.validate(state); err != nil {
		return err
	}
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if len(data) > maxStateBytes {
		return fmt.Errorf("session %q exceeds %d bytes", s.id, maxStateBytes)
	}
	if err := statefile.WriteAtomic(s.path, data); err != nil {
		return fmt.Errorf("save session %q: %w", s.id, err)
	}
	return nil
}

func (s *Store) validate(state State) error {
	if state.SchemaVersion != SchemaVersion {
		return fmt.Errorf("session %q has unsupported schemaVersion %d (want %d)", s.id, state.SchemaVersion, SchemaVersion)
	}
	if state.ID != s.id {
		return fmt.Errorf("session %q contains state owned by %q", s.id, state.ID)
	}
	if state.Permissions != nil {
		if err := state.Permissions.Validate(); err != nil {
			return fmt.Errorf("invalid session permissions: %w", err)
		}
	}
	if binding := state.Browser; binding != nil {
		_, idErr := hex.DecodeString(binding.ID)
		if binding.Mode != "agent" || ValidateID(binding.Profile) != nil || len(binding.ID) != 32 || idErr != nil ||
			binding.Process.PID <= 0 || binding.Process.Started == "" || !filepath.IsAbs(binding.Process.Profile) {
			return fmt.Errorf("session %q contains an invalid browser binding", s.id)
		}
	}
	target := state.LastTarget
	if len(state.DirectTabs) > 256 {
		return errors.New("direct tab index exceeds 256 pages")
	}
	for _, id := range state.DirectTabs {
		if !targetKey.MatchString(id) {
			return errors.New("invalid direct tab index")
		}
	}
	if state.DirectTarget != "" && !targetKey.MatchString(state.DirectTarget) || len(state.DirectDocument) > 128 || state.DirectDocument != "" && state.DirectTarget == "" {
		return errors.New("invalid direct target/document binding")
	}
	if target.TabID < 0 || (target.DocumentID == "") != (target.TabID == 0) {
		return fmt.Errorf("session %q requires documentId and a positive tabId together", s.id)
	}
	return nil
}
