//go:build darwin

package session

import (
	"errors"
	"fmt"

	"golang.org/x/sys/unix"
)

func ProcessStart(pid int) (string, error) {
	if pid <= 0 {
		return "", errors.New("invalid process ID")
	}
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		if errors.Is(err, unix.ESRCH) {
			return "", fmt.Errorf("%w: %v", ErrProcessNotRunning, err)
		}
		return "", err
	}
	if int(info.Proc.P_pid) != pid || info.Proc.P_starttime.Sec <= 0 {
		return "", ErrProcessNotRunning
	}
	return fmt.Sprintf("%d:%d", info.Proc.P_starttime.Sec, info.Proc.P_starttime.Usec), nil
}
