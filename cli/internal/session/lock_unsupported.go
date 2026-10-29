//go:build !windows && !linux && !darwin

package session

import (
	"errors"
	"os"
)

func tryLock(*os.File) (bool, error) {
	return false, errors.New("session locks support Windows, Linux and macOS")
}
func unlock(*os.File) error { return nil }
