package cdp

import (
	"context"
	"errors"
)

type BrowserIdentity struct {
	PID       int
	Arguments []string
}

func (c *Client) BrowserIdentity(ctx context.Context) (BrowserIdentity, error) {
	var processes struct {
		ProcessInfo []struct {
			ID   int
			Type string
		}
	}
	if err := c.call(ctx, "", "SystemInfo.getProcessInfo", nil, &processes); err != nil {
		return BrowserIdentity{}, err
	}
	var identity BrowserIdentity
	for _, process := range processes.ProcessInfo {
		if process.Type == "browser" {
			if identity.PID != 0 {
				return BrowserIdentity{}, errors.New("Chrome returned ambiguous browser process identity")
			}
			identity.PID = process.ID
		}
	}
	if identity.PID <= 0 {
		return BrowserIdentity{}, errors.New("Chrome returned no browser process identity")
	}
	var command struct{ Arguments []string }
	if err := c.call(ctx, "", "Browser.getBrowserCommandLine", nil, &command); err != nil {
		return BrowserIdentity{}, err
	}
	identity.Arguments = command.Arguments
	return identity, nil
}

func (c *Client) CloseBrowser(ctx context.Context) error {
	return c.call(ctx, "", "Browser.close", nil, nil)
}
