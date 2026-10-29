package session

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
	"regexp"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/statefile"
)

var targetKey = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

type TabLease struct {
	SchemaVersion int       `json:"schemaVersion"`
	BrowserID     string    `json:"browserId"`
	TargetID      string    `json:"targetId"`
	Owner         string    `json:"owner"`
	UpdatedAt     time.Time `json:"updatedAt"`
	ExpiresAt     time.Time `json:"expiresAt"`
}

type TabOwnedError struct {
	Owner     string
	ExpiresAt time.Time
}

func (e *TabOwnedError) Error() string {
	return fmt.Sprintf("tab_owned: session %s owns the tab until %s", e.Owner, e.ExpiresAt.UTC().Format(time.RFC3339))
}

func (s *Store) leasePath(browserID, targetID string) (string, error) {
	if !targetKey.MatchString(browserID) || !targetKey.MatchString(targetID) {
		return "", errors.New("invalid browser/target identity for tab lease")
	}
	key := sha256.Sum256([]byte(browserID + "\x00" + targetID))
	return filepath.Join(s.root, "leases", hex.EncodeToString(key[:])+".json"), nil
}

func (s *Store) ClaimTab(ctx context.Context, browserID, targetID string, ttl time.Duration) (TabLease, error) {
	if ttl <= 0 || ttl > 24*time.Hour {
		return TabLease{}, errors.New("tab lease TTL must be positive and at most 24h")
	}
	path, err := s.leasePath(browserID, targetID)
	if err != nil {
		return TabLease{}, err
	}
	lock, err := acquireLock(ctx, filepath.Join(s.root, "leases", "leases.lock"))
	if err != nil {
		return TabLease{}, err
	}
	defer lock.Close()
	lease, err := readLease(path, browserID, targetID)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return TabLease{}, err
	}
	now := s.now().UTC()
	if lease.Owner != "" && lease.Owner != s.id && now.Before(lease.ExpiresAt) {
		return TabLease{}, &TabOwnedError{Owner: lease.Owner, ExpiresAt: lease.ExpiresAt}
	}
	lease = TabLease{SchemaVersion: 1, BrowserID: browserID, TargetID: targetID, Owner: s.id, UpdatedAt: now, ExpiresAt: now.Add(ttl)}
	data, err := json.Marshal(lease)
	if err != nil {
		return TabLease{}, err
	}
	if err := ctx.Err(); err != nil {
		return TabLease{}, err
	}
	if err := statefile.WriteAtomic(path, data); err != nil {
		return TabLease{}, err
	}
	return lease, nil
}

func (s *Store) ReleaseTab(ctx context.Context, browserID, targetID string) error {
	path, err := s.leasePath(browserID, targetID)
	if err != nil {
		return err
	}
	lock, err := acquireLock(ctx, filepath.Join(s.root, "leases", "leases.lock"))
	if err != nil {
		return err
	}
	defer lock.Close()
	lease, err := readLease(path, browserID, targetID)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if lease.Owner != s.id {
		return &TabOwnedError{Owner: lease.Owner, ExpiresAt: lease.ExpiresAt}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return os.Remove(path)
}

func readLease(path, browserID, targetID string) (TabLease, error) {
	file, err := os.Open(path)
	if err != nil {
		return TabLease{}, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil {
		return TabLease{}, err
	}
	if len(data) > 4096 {
		return TabLease{}, errors.New("tab lease exceeds 4 KiB")
	}
	var lease TabLease
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&lease); err != nil {
		return TabLease{}, fmt.Errorf("decode tab lease: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return TabLease{}, errors.New("tab lease contains trailing data")
	}
	if lease.SchemaVersion != 1 || lease.BrowserID != browserID || lease.TargetID != targetID || ValidateID(lease.Owner) != nil || lease.UpdatedAt.IsZero() || !lease.ExpiresAt.After(lease.UpdatedAt) {
		return TabLease{}, errors.New("invalid or unsupported tab lease; ownership cannot be determined")
	}
	return lease, nil
}
