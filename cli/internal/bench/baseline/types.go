package baseline

import "time"

const SourceCommit = "9a1b4c6df6a4785a66186dd49f62f3bd49fbbe90"

type Config struct {
	Root, Chrome, Source, Bridge, Extension, Archive, Output string
	Port, Runs, CommandsPerSample                            int
	IdleWindow                                               time.Duration
}

type Report struct {
	SchemaVersion  int               `json:"schemaVersion"`
	Task           string            `json:"task"`
	BaselineCommit string            `json:"baselineCommit"`
	CollectedAt    string            `json:"collectedAt"`
	Provenance     map[string]any    `json:"provenance"`
	Method         map[string]any    `json:"method"`
	Unavailable    map[string]string `json:"unavailable"`
	Scenarios      []Scenario        `json:"scenarios"`
}

type Scenario struct {
	Name             string              `json:"name"`
	ExtensionWorkers []string            `json:"extensionWorkersAtSetup"`
	Summary          map[string]Quantile `json:"summary"`
	Samples          []Sample            `json:"samples"`
}

type Quantile struct {
	Count int     `json:"count"`
	Min   float64 `json:"min"`
	P50   float64 `json:"p50"`
	P95   float64 `json:"p95"`
	Max   float64 `json:"max"`
}

type Sample struct {
	Index              int             `json:"index"`
	PageCount          int             `json:"pageCount"`
	PIDVerified        bool            `json:"pidVerified"`
	RendererPID        int             `json:"rendererPid"`
	BrowserPID         int             `json:"browserPid"`
	BridgePID          int             `json:"bridgePid,omitempty"`
	HostProcesses      int             `json:"browserControlHostProcesses"`
	PageAttachedBefore bool            `json:"pageAttachedBefore"`
	PageAttachedAfter  bool            `json:"pageAttachedAfter"`
	WallNS             int64           `json:"wallNs"`
	OSWindowNS         int64           `json:"osWindowNs"`
	RendererBefore     ProcessReading  `json:"rendererBefore"`
	RendererAfter      ProcessReading  `json:"rendererAfter"`
	RendererCDPBefore  float64         `json:"rendererCdpCpuSecondsBefore"`
	RendererCDPAfter   float64         `json:"rendererCdpCpuSecondsAfter"`
	RendererCDPDelta   float64         `json:"rendererCdpCpuSecondsDelta"`
	RendererPercent    float64         `json:"rendererPercentOfOneCore"`
	BridgeBefore       *ProcessReading `json:"bridgeBefore,omitempty"`
	BridgeAfter        *ProcessReading `json:"bridgeAfter,omitempty"`
	Commands           []Command       `json:"commands,omitempty"`
}

type ProcessReading struct {
	Cycles        uint64 `json:"cycles"`
	Start         string `json:"start"`
	Kernel100NS   uint64 `json:"kernel100ns"`
	User100NS     uint64 `json:"user100ns"`
	ParentPID     int    `json:"parentPid"`
	ImageVerified bool   `json:"imageVerified"`
}

type Command struct {
	DurationNS   int64  `json:"durationNs"`
	ExitCode     int    `json:"exitCode"`
	StdoutBytes  int    `json:"stdoutBytes"`
	StdoutTokens int    `json:"stdoutTokens"`
	StdoutSHA256 string `json:"stdoutSha256"`
}
