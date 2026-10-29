//go:build windows

package baseline

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var queryProcessCycles = windows.NewLazySystemDLL("kernel32.dll").NewProc("QueryProcessCycleTime")

func readProcess(pid int, image string) (ProcessReading, error) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return ProcessReading{}, err
	}
	defer windows.CloseHandle(handle)
	var cycles uint64
	if err := queryProcessCycles.Find(); err != nil {
		return ProcessReading{}, err
	}
	if ok, _, err := queryProcessCycles.Call(uintptr(handle), uintptr(unsafe.Pointer(&cycles))); ok == 0 {
		return ProcessReading{}, fmt.Errorf("OS process cycles unavailable: %w", err)
	}
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		return ProcessReading{}, err
	}
	if exited.HighDateTime != 0 || exited.LowDateTime != 0 {
		return ProcessReading{}, errors.New("benchmark process exited during measurement")
	}
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size); err != nil {
		return ProcessReading{}, err
	}
	if !strings.EqualFold(filepath.Clean(windows.UTF16ToString(buffer[:size])), filepath.Clean(image)) {
		return ProcessReading{}, errors.New("benchmark process executable does not match owned binary")
	}
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return ProcessReading{}, err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	parent := 0
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		if int(entry.ProcessID) == pid {
			parent = int(entry.ParentProcessID)
			break
		}
	}
	if parent == 0 {
		return ProcessReading{}, errors.New("benchmark process missing from OS process inventory")
	}
	return ProcessReading{Cycles: cycles, Start: fmt.Sprintf("%08x%08x", created.HighDateTime, created.LowDateTime), Kernel100NS: uint64(kernel.HighDateTime)<<32 | uint64(kernel.LowDateTime), User100NS: uint64(user.HighDateTime)<<32 | uint64(user.LowDateTime), ParentPID: parent, ImageVerified: true}, nil
}
