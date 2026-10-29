//go:build linux

package session

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

func ProcessStart(pid int) (string, error) {
	if pid <= 0 {
		return "", errors.New("invalid process ID")
	}
	file, err := os.Open(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("%w: %v", ErrProcessNotRunning, err)
		}
		return "", err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil {
		return "", err
	}
	end := strings.LastIndexByte(string(data), ')')
	if len(data) > 4096 || end < 0 {
		return "", errors.New("invalid process stat")
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) < 20 {
		return "", errors.New("invalid process stat")
	}
	if fields[0] == "Z" {
		return "", ErrProcessNotRunning
	}
	if _, err := strconv.ParseUint(fields[19], 10, 64); err != nil {
		return "", errors.New("invalid process start ticks")
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(boot)) + ":" + fields[19], nil
}
