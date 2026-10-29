package session

import (
	"context"
	"errors"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
)

func (m *BrowserManager) CaptureFixture(ctx context.Context, binding BrowserBinding, request driver.CaptureRequest, claim func(context.Context, string) error) (driver.Capture, error) {
	if binding.Mode != "agent" {
		return driver.Capture{}, errors.New("fixture capture requires an owned agent profile")
	}
	path, err := m.profilePath(binding.Profile)
	if err != nil {
		return driver.Capture{}, err
	}
	owner, err := readBrowserOwner(path, binding.Profile)
	if err != nil || owner.ID != binding.ID || owner.Process != binding.Process {
		return driver.Capture{}, errors.New("browser_not_owned: fixture session binding does not match the browser")
	}
	client, _, err := connectOwnedBrowser(ctx, path, owner)
	if err != nil {
		return driver.Capture{}, errors.New("owned fixture browser is unavailable; run browser status")
	}
	defer client.Close()
	return client.CaptureFixture(ctx, request, claim)
}
