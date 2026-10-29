package bench

type benchmarkClock struct {
	name      string
	frequency int64
	now       func() int64
	elapsed   func(int64, int64) int64
}

// Clock shares the renderer benchmark's monotonic clock with live benchmark instrumentation.
type Clock struct{ value benchmarkClock }

func NewClock() (Clock, error) {
	value, err := newBenchmarkClock()
	return Clock{value: value}, err
}

func (c Clock) Now() int64                     { return c.value.now() }
func (c Clock) Elapsed(start, end int64) int64 { return c.value.elapsed(start, end) }
func (c Clock) Name() string                   { return c.value.name }
func (c Clock) Frequency() int64               { return c.value.frequency }

func clockReadOverhead(clock benchmarkClock) Distribution {
	samples := make([]int64, 128)
	for i := range samples {
		start := clock.now()
		samples[i] = clock.elapsed(start, clock.now())
	}
	return distribution(samples)
}
