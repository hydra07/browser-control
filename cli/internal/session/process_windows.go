//go:build windows

package session

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows"
)

func ProcessStart(pid int) (string, error) {
	if pid <= 0 {
		return "", errors.New("invalid process ID")
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) || errors.Is(err, windows.ERROR_NOT_FOUND) {
			return "", fmt.Errorf("%w: %v", ErrProcessNotRunning, err)
		}
		return "", err
	}
	defer windows.CloseHandle(handle)
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		return "", err
	}
	if exited.HighDateTime != 0 || exited.LowDateTime != 0 {
		return "", ErrProcessNotRunning
	}
	return fmt.Sprintf("%08x%08x", created.HighDateTime, created.LowDateTime), nil
}
