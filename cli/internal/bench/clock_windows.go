package bench

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

func newBenchmarkClock() (benchmarkClock, error) {
	/** The observed Go clock was too coarse for these stages; QPC avoids publishing zero-duration samples. */
	kernel := windows.NewLazySystemDLL("kernel32.dll")
	counter := kernel.NewProc("QueryPerformanceCounter")
	frequencyProc := kernel.NewProc("QueryPerformanceFrequency")
	if err := counter.Find(); err != nil {
		return benchmarkClock{}, err
	}
	if err := frequencyProc.Find(); err != nil {
		return benchmarkClock{}, err
	}
	var frequency int64
	ok, _, _ := frequencyProc.Call(uintptr(unsafe.Pointer(&frequency)))
	if ok == 0 || frequency <= 0 {
		return benchmarkClock{}, errors.New("Windows performance counter frequency unavailable")
	}
	var initial int64
	ok, _, _ = counter.Call(uintptr(unsafe.Pointer(&initial)))
	if ok == 0 {
		return benchmarkClock{}, errors.New("Windows performance counter unavailable")
	}
	return benchmarkClock{name: "windows_qpc_ns", frequency: frequency, now: func() int64 {
		var value int64
		counter.Call(uintptr(unsafe.Pointer(&value)))
		return value
	}, elapsed: func(start, end int64) int64 {
		return int64(float64(end-start) * 1e9 / float64(frequency))
	}}, nil
}
