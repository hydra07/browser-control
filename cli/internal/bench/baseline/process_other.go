//go:build !windows

package baseline

import "errors"

func readProcess(pid int, image string) (ProcessReading, error) {
	return ProcessReading{}, errors.New("live baseline OS process cross-check is currently implemented for Windows only")
}
