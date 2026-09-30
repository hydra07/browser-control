//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// detach lets the auto-started bridge outlive the short-lived CLI call and its terminal.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
