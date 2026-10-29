package session

import (
	"context"
	"errors"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
)

func (m *BrowserManager) ConnectAgent(ctx context.Context, binding BrowserBinding) (driver.AgentBrowser, error) {
	path, err := m.profilePath(binding.Profile)
	if err != nil {
		return nil, err
	}
	owner, err := readBrowserOwner(path, binding.Profile)
	if err != nil || binding.Mode != "agent" || owner.ID != binding.ID || owner.Process != binding.Process {
		return nil, errors.New("browser_not_owned: session binding does not match browser ownership")
	}
	client, _, err := connectOwnedBrowser(ctx, path, owner)
	return client, err
}
