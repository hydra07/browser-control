package session

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

type Capability string

const (
	Read Capability = "read"
	Act  Capability = "act"
	Eval Capability = "eval"
)

var ErrPermission = errors.New("session permission denied")
var ErrProcessNotRunning = errors.New("process is not running")

type Permissions struct {
	Read    bool     `json:"read"`
	Act     bool     `json:"act"`
	Eval    bool     `json:"eval"`
	Origins []string `json:"origins,omitempty"`
}

func DefaultPermissions() Permissions { return Permissions{Read: true, Act: true} }

func (p Permissions) Validate() error {
	if len(p.Origins) > 64 {
		return errors.New("origin allowlist exceeds 64 entries")
	}
	for _, origin := range p.Origins {
		if len(origin) > 512 {
			return errors.New("origin policy entry exceeds 512 bytes")
		}
		if _, err := canonicalOrigin(origin, true); err != nil {
			return err
		}
	}
	return nil
}

func (p Permissions) Check(capability Capability, pageURL string) error {
	if err := p.Validate(); err != nil {
		return fmt.Errorf("%w: invalid origin policy", ErrPermission)
	}
	allowed := false
	switch capability {
	case Read:
		allowed = p.Read
	case Act:
		allowed = p.Act
	case Eval:
		allowed = p.Eval
	}
	if !allowed {
		return fmt.Errorf("%w: %s", ErrPermission, capability)
	}
	if capability == Read {
		return nil
	}
	origin, err := canonicalOrigin(pageURL, false)
	if err != nil {
		return fmt.Errorf("%w: target has no allowed HTTP(S) origin", ErrPermission)
	}
	if len(p.Origins) == 0 {
		return nil
	}
	matched := false
	for _, entry := range p.Origins {
		allowedOrigin, err := canonicalOrigin(entry, true)
		if err != nil {
			return fmt.Errorf("%w: invalid origin policy", ErrPermission)
		}
		matched = matched || origin == allowedOrigin
	}
	if !matched {
		return fmt.Errorf("%w: target origin is outside the session allowlist", ErrPermission)
	}
	return nil
}

func canonicalOrigin(value string, policy bool) (string, error) {
	u, err := url.Parse(value)
	if err != nil || u.User != nil || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return "", errors.New("invalid origin")
	}
	if policy && (u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/") {
		return "", errors.New("policy entry must be an origin")
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	parsedPort, err := strconv.Atoi(port)
	if err != nil || parsedPort < 1 || parsedPort > 65535 {
		return "", errors.New("invalid origin port")
	}
	return u.Scheme + "://" + net.JoinHostPort(strings.ToLower(u.Hostname()), port), nil
}

type OwnedProcess struct {
	PID     int    `json:"pid"`
	Started string `json:"started"`
	Profile string `json:"profile"`
}

type ProcessIdentity struct {
	PID       int
	Started   string
	Arguments []string
}

// Validate prevents stale metadata or a reused PID from authorizing browser shutdown.
func (p OwnedProcess) Validate(actual ProcessIdentity, expectedProfile string) error {
	if p.PID <= 0 || actual.PID != p.PID || p.Started == "" || actual.Started != p.Started {
		return errors.New("browser_not_owned: process identity does not match")
	}
	if !filepath.IsAbs(expectedProfile) || !sameProfile(p.Profile, expectedProfile) {
		return errors.New("browser_not_owned: profile metadata does not match")
	}
	profiles := 0
	for _, argument := range actual.Arguments {
		if value, ok := strings.CutPrefix(argument, "--user-data-dir="); ok {
			profiles++
			if !sameProfile(value, expectedProfile) {
				return errors.New("browser_not_owned: live user-data-dir does not match")
			}
		}
	}
	if profiles != 1 {
		return errors.New("browser_not_owned: live user-data-dir cannot be verified uniquely")
	}
	return nil
}

func sameProfile(left, right string) bool {
	if !filepath.IsAbs(left) || !filepath.IsAbs(right) {
		return false
	}
	left, right = filepath.Clean(left), filepath.Clean(right)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}
