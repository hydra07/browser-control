//go:build !windows && !linux && !darwin

package session

import "errors"

func ProcessStart(int) (string, error) {
	return "", errors.New("process ownership supports Windows, Linux and macOS")
}
