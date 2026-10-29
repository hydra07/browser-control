package session

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/chrome"
	"github.com/hydra07/browsercontrol/cli/internal/driver/cdp"
	"github.com/hydra07/browsercontrol/cli/internal/statefile"
)

type BrowserOptions struct {
	Profile    string
	Executable string
	Headless   bool
	NoSandbox  bool
}

type BrowserInfo struct {
	ID          string `json:"browserId,omitempty"`
	Profile     string `json:"profile"`
	ProfilePath string `json:"profilePath"`
	PID         int    `json:"pid,omitempty"`
	Running     bool   `json:"running"`
	Reused      bool   `json:"reused,omitempty"`
	Endpoint    string `json:"-"`
	Started     string `json:"-"`
}

type BrowserManager struct{ root string }

type browserOwner struct {
	SchemaVersion int          `json:"schemaVersion"`
	ID            string       `json:"id"`
	Profile       string       `json:"profile"`
	Process       OwnedProcess `json:"process"`
}

func NewBrowserManager(root string) (*BrowserManager, error) {
	if root == "" {
		return nil, errors.New("browser state directory is required")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	return &BrowserManager{root: absolute}, nil
}

func (m *BrowserManager) profilePath(name string) (string, error) {
	if err := ValidateID(name); err != nil {
		return "", fmt.Errorf("invalid profile: %w", err)
	}
	path := filepath.Join(m.root, "profiles", name)
	for _, directory := range []string{filepath.Dir(path), path} {
		info, err := os.Lstat(directory)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("agent profile must be a regular directory, not a link")
		}
	}
	return path, nil
}

func (m *BrowserManager) Status(ctx context.Context, name string) (BrowserInfo, error) {
	path, err := m.profilePath(name)
	if err != nil {
		return BrowserInfo{}, err
	}
	info := BrowserInfo{Profile: name, ProfilePath: path}
	owner, err := readBrowserOwner(path, name)
	if errors.Is(err, os.ErrNotExist) {
		return info, nil
	}
	if err != nil {
		return info, err
	}
	info.ID, info.PID = owner.ID, owner.Process.PID
	client, endpoint, err := connectOwnedBrowser(ctx, path, owner)
	if errors.Is(err, ErrProcessNotRunning) {
		return info, nil
	}
	if err != nil {
		return info, err
	}
	defer client.Close()
	info.Running, info.Endpoint = true, endpoint
	return info, nil
}

func (m *BrowserManager) Start(ctx context.Context, options BrowserOptions) (BrowserInfo, error) {
	path, err := m.profilePath(options.Profile)
	if err != nil {
		return BrowserInfo{}, err
	}
	lock, err := acquireLock(ctx, path+".lock")
	if err != nil {
		return BrowserInfo{}, err
	}
	defer lock.Close()
	owner, err := readBrowserOwner(path, options.Profile)
	if err == nil {
		client, endpoint, connectErr := connectOwnedBrowser(ctx, path, owner)
		if connectErr == nil {
			_ = client.Close()
			return browserInfo(owner, path, endpoint, true), nil
		}
		if !errors.Is(connectErr, ErrProcessNotRunning) {
			return BrowserInfo{}, connectErr
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return BrowserInfo{}, err
	} else if entries, err := os.ReadDir(path); err == nil && len(entries) > 0 {
		return BrowserInfo{}, errors.New("browser_not_owned: existing nonempty profile has no ownership record")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return BrowserInfo{}, err
	}
	// A stale port may belong to another process; never launch into a live, unverified endpoint.
	if endpoint, err := cdp.Discover(path); err == nil {
		probe, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
		client, err := cdp.Connect(probe, endpoint, cdp.Options{})
		cancel()
		if err == nil {
			_ = client.Close()
			return BrowserInfo{}, errors.New("browser_not_owned: profile endpoint is already live")
		}
	}
	if err := ctx.Err(); err != nil {
		return BrowserInfo{}, err
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return BrowserInfo{}, err
	}
	if err := os.Chmod(path, 0o700); err != nil {
		return BrowserInfo{}, err
	}
	executable := options.Executable
	if executable == "" {
		executable = chrome.FindExecutable()
	}
	if executable == "" {
		return BrowserInfo{}, errors.New("Chrome not found; supply --executable with an installed Chrome path")
	}
	arguments := []string{"--remote-debugging-port=0", "--user-data-dir=" + path,
		"--no-first-run", "--no-default-browser-check", "--disable-extensions", "--enable-automation"}
	if options.Headless {
		arguments = append(arguments, "--headless=new", "--disable-gpu")
	}
	if options.NoSandbox {
		arguments = append(arguments, "--no-sandbox")
	}
	arguments = append(arguments, "about:blank")
	command := exec.Command(executable, arguments...)
	output, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		return BrowserInfo{}, err
	}
	command.Stdout, command.Stderr = output, output
	if err := ctx.Err(); err != nil {
		_ = output.Close()
		return BrowserInfo{}, err
	}
	err = command.Start()
	_ = output.Close()
	if err != nil {
		return BrowserInfo{}, fmt.Errorf("start Chrome: %w", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- command.Wait() }()
	started, err := ProcessStart(command.Process.Pid)
	if err != nil {
		_ = command.Process.Kill()
		return BrowserInfo{}, fmt.Errorf("identify launched Chrome: %w", err)
	}
	owned := OwnedProcess{PID: command.Process.Pid, Started: started, Profile: path}
	committed := false
	defer func() {
		if !committed {
			if current, err := ProcessStart(owned.PID); err == nil && current == owned.Started {
				_ = command.Process.Kill()
			}
		}
	}()
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return BrowserInfo{}, err
	}
	owner = browserOwner{SchemaVersion: 1, ID: hex.EncodeToString(id), Profile: options.Profile, Process: owned}
	data, err := json.Marshal(owner)
	if err != nil {
		return BrowserInfo{}, err
	}
	// Keep ownership recoverable if cancellation interrupts the initial CDP handshake.
	if err := statefile.WriteAtomic(filepath.Join(path, "browsercontrol-owner.json"), data); err != nil {
		return BrowserInfo{}, err
	}
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	var lastErr error
	for {
		probe, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
		client, endpoint, err := connectOwnedBrowser(probe, path, owner)
		cancel()
		if err == nil {
			_ = client.Close()
			committed = true
			return browserInfo(owner, path, endpoint, false), nil
		}
		lastErr = err
		select {
		case <-ctx.Done():
			return BrowserInfo{}, fmt.Errorf("start Chrome: %w (last probe: %v)", ctx.Err(), lastErr)
		case err := <-exited:
			return BrowserInfo{}, fmt.Errorf("Chrome exited before ownership verification: %v (last probe: %v)", err, lastErr)
		case <-ticker.C:
		}
	}
}

func (m *BrowserManager) Stop(ctx context.Context, name string) (BrowserInfo, error) {
	return m.stop(ctx, name, nil)
}

func (m *BrowserManager) StopOwned(ctx context.Context, binding BrowserBinding) (BrowserInfo, error) {
	return m.stop(ctx, binding.Profile, &binding)
}

func (m *BrowserManager) stop(ctx context.Context, name string, binding *BrowserBinding) (BrowserInfo, error) {
	path, err := m.profilePath(name)
	if err != nil {
		return BrowserInfo{}, err
	}
	lock, err := acquireLock(ctx, path+".lock")
	if err != nil {
		return BrowserInfo{}, err
	}
	defer lock.Close()
	owner, err := readBrowserOwner(path, name)
	if err != nil {
		return BrowserInfo{}, fmt.Errorf("browser_not_owned: %w", err)
	}
	if binding != nil && (binding.Mode != "agent" || binding.ID != owner.ID || binding.Process != owner.Process) {
		return BrowserInfo{}, errors.New("browser_not_owned: session binding does not match the owned browser")
	}
	info := browserInfo(owner, path, "", false)
	info.Running = false
	client, _, err := connectOwnedBrowser(ctx, path, owner)
	if errors.Is(err, ErrProcessNotRunning) {
		return info, nil
	}
	if err != nil {
		return BrowserInfo{}, err
	}
	defer client.Close()
	if err := ctx.Err(); err != nil {
		return BrowserInfo{}, err
	}
	closeErr := client.CloseBrowser(ctx)
	// Chrome can close its socket before acknowledging Browser.close; only OS exit confirms success.
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		current, err := ProcessStart(owner.Process.PID)
		if errors.Is(err, ErrProcessNotRunning) || err == nil && current != owner.Process.Started {
			return info, nil
		}
		if err != nil {
			return BrowserInfo{}, err
		}
		select {
		case <-ctx.Done():
			return BrowserInfo{}, fmt.Errorf("outcome_unknown: stop requested once; process exit unconfirmed: %w (close: %v)", ctx.Err(), closeErr)
		case <-ticker.C:
		}
	}
}

func browserInfo(owner browserOwner, path, endpoint string, reused bool) BrowserInfo {
	return BrowserInfo{ID: owner.ID, Profile: owner.Profile, ProfilePath: path, PID: owner.Process.PID, Started: owner.Process.Started, Endpoint: endpoint, Running: true, Reused: reused}
}

func connectOwnedBrowser(ctx context.Context, path string, owner browserOwner) (*cdp.Client, string, error) {
	started, err := ProcessStart(owner.Process.PID)
	if err != nil {
		return nil, "", err
	}
	if started != owner.Process.Started {
		return nil, "", errors.New("browser_not_owned: PID has been reused")
	}
	endpoint, err := cdp.Discover(path)
	if err != nil {
		return nil, "", err
	}
	client, err := cdp.Connect(ctx, endpoint, cdp.Options{})
	if err != nil {
		return nil, "", err
	}
	identity, err := client.BrowserIdentity(ctx)
	if err == nil {
		err = owner.Process.Validate(ProcessIdentity{PID: identity.PID, Started: started, Arguments: identity.Arguments}, path)
	}
	if err != nil {
		_ = client.Close()
		return nil, "", err
	}
	return client, endpoint, nil
}

func readBrowserOwner(path, name string) (browserOwner, error) {
	file, err := os.Open(filepath.Join(path, "browsercontrol-owner.json"))
	if err != nil {
		return browserOwner{}, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxStateBytes+1))
	if err != nil || len(data) > maxStateBytes {
		return browserOwner{}, errors.New("invalid browser ownership record size")
	}
	var owner browserOwner
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&owner); err != nil {
		return browserOwner{}, err
	}
	if decoder.Decode(new(any)) != io.EOF || owner.SchemaVersion != 1 || len(owner.ID) != 32 || owner.Profile != name ||
		owner.Process.PID <= 0 || owner.Process.Started == "" || !sameProfile(owner.Process.Profile, path) {
		return browserOwner{}, errors.New("invalid browser ownership record")
	}
	if _, err := hex.DecodeString(owner.ID); err != nil {
		return browserOwner{}, errors.New("invalid browser identity")
	}
	return owner, nil
}
