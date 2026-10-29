package bench

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"runtime"
	"runtime/debug"
)

const (
	ProjectionID = "legacy-flat-ax-go-v1"
	RendererID   = "legacy-flat-cli-v1"
	O200kBase    = "o200k_base"
	Cl100kBase   = "cl100k_base"
)

type Options struct {
	Runs     int    `json:"runs"`
	Warmup   int    `json:"warmup"`
	Limit    int    `json:"limit"`
	Grep     string `json:"-"`
	Encoding string `json:"encoding"`
}

func DefaultOptions() Options {
	return Options{Runs: 20, Warmup: 3, Limit: 80, Encoding: O200kBase}
}

func (o Options) Validate() error {
	if o.Runs < 10 || o.Runs > 1000 {
		return errors.New("--runs must be between 10 and 1000")
	}
	if o.Warmup < 0 || o.Warmup > 100 {
		return errors.New("--warmup must be between 0 and 100")
	}
	if o.Limit < 0 || o.Limit > 100000 {
		return errors.New("--limit must be between 0 and 100000")
	}
	if len(o.Grep) > 4096 {
		return errors.New("--grep exceeds 4096 bytes")
	}
	if o.Encoding != O200kBase && o.Encoding != Cl100kBase {
		return errors.New("--encoding must be o200k_base or cl100k_base")
	}
	return nil
}

type View struct {
	Text         string
	Data         any
	Shown, Total int
}

type Renderer func([]any, Options) View

type Metrics struct {
	Bytes  int    `json:"bytes"`
	Tokens int    `json:"tokens"`
	SHA256 string `json:"sha256"`
}

type Distribution struct {
	Samples int   `json:"samples"`
	MinNS   int64 `json:"minNs"`
	P50NS   int64 `json:"p50Ns"`
	P95NS   int64 `json:"p95Ns"`
	MaxNS   int64 `json:"maxNs"`
}

type Timings struct {
	Projection  Distribution `json:"projection"`
	AgentRender Distribution `json:"agentRender"`
	JSONEncode  Distribution `json:"jsonEncode"`
	Pipeline    Distribution `json:"pipeline"`
}

type Case struct {
	Fixture                 string  `json:"fixture"`
	FixtureSHA256           string  `json:"fixtureSha256"`
	Classification          string  `json:"classification"`
	FrameIndex              int     `json:"frameIndex"`
	InputBytes              int     `json:"inputBytes"`
	RawDOMNodes             int     `json:"rawDomNodes"`
	RawAXNodes              int     `json:"rawAxNodes"`
	InputTruncated          bool    `json:"inputTruncated"`
	MissingFrames           int     `json:"missingFrameCount"`
	ProjectedNodes          int     `json:"projectedNodes"`
	ProjectionTextTruncated bool    `json:"projectionTextTruncated"`
	ShownNodes              int     `json:"shownNodes"`
	RenderedNodes           int     `json:"renderedNodes"`
	ViewFiltered            bool    `json:"viewFiltered"`
	Agent                   Metrics `json:"agent"`
	JSON                    Metrics `json:"json"`
	Timings                 Timings `json:"timings"`
}

type TokenizerInfo struct {
	Implementation string `json:"implementation"`
	Version        string `json:"version"`
	Encoding       string `json:"encoding"`
	SpecialTokens  string `json:"specialTokens"`
}

type Environment struct {
	GoVersion        string            `json:"goVersion"`
	OS               string            `json:"os"`
	Arch             string            `json:"arch"`
	CPUs             int               `json:"cpus"`
	GOMAXPROCS       int               `json:"gomaxprocs"`
	Build            map[string]string `json:"build"`
	ExecutableSHA256 string            `json:"executableSha256"`
	ExecutableBytes  int64             `json:"executableBytes"`
}

type Report struct {
	SchemaVersion     int           `json:"schemaVersion"`
	Projection        string        `json:"projection"`
	Renderer          string        `json:"renderer"`
	TimingClock       string        `json:"timingClock"`
	ClockFrequencyHz  int64         `json:"clockFrequencyHz,omitempty"`
	ClockReadOverhead Distribution  `json:"clockReadOverhead"`
	Tokenizer         TokenizerInfo `json:"tokenizer"`
	Config            Options       `json:"config"`
	FilterSHA256      string        `json:"filterSha256"`
	Environment       Environment   `json:"environment"`
	Cases             []Case        `json:"cases"`
}

func environment() (Environment, error) {
	env := Environment{GoVersion: runtime.Version(), OS: runtime.GOOS, Arch: runtime.GOARCH, CPUs: runtime.NumCPU(), GOMAXPROCS: runtime.GOMAXPROCS(0), Build: map[string]string{}}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, setting := range info.Settings {
			switch setting.Key {
			case "vcs", "vcs.revision", "vcs.modified", "vcs.time", "-race", "-compiler", "-buildmode", "GOAMD64", "GOARM64", "CGO_ENABLED":
				env.Build[setting.Key] = setting.Value
			}
		}
	}
	path, err := os.Executable()
	if err != nil {
		return Environment{}, errors.New("benchmark executable identity unavailable")
	}
	file, err := os.Open(path)
	if err != nil {
		return Environment{}, errors.New("cannot fingerprint benchmark executable")
	}
	defer file.Close()
	hash := sha256.New()
	env.ExecutableBytes, err = io.Copy(hash, file)
	if err != nil {
		return Environment{}, errors.New("cannot fingerprint benchmark executable")
	}
	env.ExecutableSHA256 = hex.EncodeToString(hash.Sum(nil))
	return env, nil
}
