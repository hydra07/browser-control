package cdp

import "testing"

func TestBenchmarkTraceUsesExactFrameAndRejectsPIDSwap(t *testing.T) {
	p := &BenchmarkProbe{pageURL: "http://fixture.test/bench", frames: map[string]int{}}
	if err := p.collectFrames([]byte(`{"value":[{"name":"TracingStartedInBrowser","args":{"data":{"frames":[{"frame":"other","url":"http://other.test","processId":9},{"frame":"main","url":"http://fixture.test/bench","processId":42}]}}}]}`)); err != nil {
		t.Fatal(err)
	}
	if len(p.frames) != 1 || p.frames["main"] != 42 {
		t.Fatalf("wrong renderer association: %v", p.frames)
	}
	if err := p.collectFrames([]byte(`{"value":[{"name":"FrameCommittedInBrowser","args":{"data":{"frame":"main","url":"http://fixture.test/bench","processId":77}}}]}`)); err == nil {
		t.Fatal("renderer changes must invalidate setup evidence")
	}
}
