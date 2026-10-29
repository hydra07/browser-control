//go:build !windows

package bench

import "time"

func newBenchmarkClock() (benchmarkClock, error) {
	origin := time.Now()
	return benchmarkClock{name: "go_monotonic_ns", now: func() int64 { return time.Since(origin).Nanoseconds() }, elapsed: func(start, end int64) int64 { return end - start }}, nil
}
