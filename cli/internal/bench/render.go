package bench

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
)

const maxRenderedBytes = 1 << 20

type tokenCounter interface {
	Count(string) (int, error)
}

func Run(ctx context.Context, source string, options Options, renderer Renderer) (Report, error) {
	if err := options.Validate(); err != nil {
		return Report{}, err
	}
	if renderer == nil {
		return Report{}, errors.New("benchmark requires the CLI renderer")
	}
	inputs, err := loadInputs(ctx, source)
	if err != nil {
		return Report{}, err
	}
	counter, err := newCounter(options.Encoding)
	if err != nil {
		return Report{}, err
	}
	clock, err := newBenchmarkClock()
	if err != nil {
		return Report{}, err
	}
	env, err := environment()
	if err != nil {
		return Report{}, err
	}
	report := Report{SchemaVersion: 1, Projection: ProjectionID, Renderer: RendererID, TimingClock: clock.name, ClockFrequencyHz: clock.frequency, ClockReadOverhead: clockReadOverhead(clock), Tokenizer: tokenizerInfo(options.Encoding), Config: options, FilterSHA256: digest(options.Grep), Environment: env, Cases: []Case{}}
	for _, input := range inputs {
		for frameIndex, tree := range input.fixture.Snapshot.Accessibility {
			result, err := runCase(ctx, tree.Nodes, options, renderer, counter, clock)
			if err != nil {
				return Report{}, err
			}
			result.Fixture, result.FixtureSHA256 = input.name, input.hash
			result.Classification, result.FrameIndex = string(input.fixture.Classification), frameIndex
			result.InputBytes, result.RawAXNodes = input.bytes, len(tree.Nodes)
			result.InputTruncated, result.MissingFrames = input.fixture.Snapshot.Truncated, len(input.fixture.Snapshot.MissingFrames)
			for _, document := range input.fixture.Snapshot.Documents {
				if document.FrameID == tree.FrameID {
					result.RawDOMNodes += len(document.Nodes)
				}
			}
			report.Cases = append(report.Cases, result)
		}
	}
	return report, ctx.Err()
}

func runCase(ctx context.Context, nodes []driver.AccessNode, options Options, renderer Renderer, counter tokenCounter, clock benchmarkClock) (Case, error) {
	var result Case
	var projection, agentRender, jsonEncode, pipeline []int64
	for iteration := -options.Warmup; iteration < options.Runs; iteration++ {
		if err := ctx.Err(); err != nil {
			return Case{}, err
		}
		start := clock.now()
		projected, projectionTruncated := projectFlatAX(nodes)
		projectedAt := clock.now()
		view := renderer(projected, options)
		agent := strings.TrimRight(view.Text, "\n") + "\n"
		renderedAt := clock.now()
		var encoded bytes.Buffer
		encoder := json.NewEncoder(&encoded)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(view.Data); err != nil {
			return Case{}, errors.New("benchmark JSON renderer failed")
		}
		jsonAt := clock.now()
		if projectedAt < start || renderedAt < projectedAt || jsonAt < renderedAt {
			return Case{}, errors.New("benchmark clock moved backwards")
		}
		if len(agent) > maxRenderedBytes || encoded.Len() > maxRenderedBytes {
			return Case{}, errors.New("benchmark output exceeds 1 MiB; narrow --grep or --limit")
		}
		if view.Shown < 0 || view.Total < view.Shown || view.Total > len(projected) {
			return Case{}, errors.New("benchmark renderer returned invalid node counts")
		}
		if err := ctx.Err(); err != nil {
			return Case{}, err
		}
		if iteration < 0 {
			continue
		}
		if iteration == 0 {
			var err error
			result.Agent, err = payloadMetrics(agent, counter)
			if err != nil {
				return Case{}, err
			}
			result.JSON, err = payloadMetrics(encoded.String(), counter)
			if err != nil {
				return Case{}, err
			}
			result.ProjectedNodes, result.ShownNodes, result.RenderedNodes = len(projected), view.Shown, view.Total
			result.ProjectionTextTruncated = projectionTruncated
			result.ViewFiltered = view.Shown < view.Total
		} else if result.Agent.SHA256 != digest(agent) || result.JSON.SHA256 != digest(encoded.String()) || result.ProjectedNodes != len(projected) || result.ShownNodes != view.Shown || result.RenderedNodes != view.Total || result.ProjectionTextTruncated != projectionTruncated {
			return Case{}, errors.New("benchmark renderer is nondeterministic for the same input/config")
		}
		projection = append(projection, clock.elapsed(start, projectedAt))
		agentRender = append(agentRender, clock.elapsed(projectedAt, renderedAt))
		jsonEncode = append(jsonEncode, clock.elapsed(renderedAt, jsonAt))
		pipeline = append(pipeline, clock.elapsed(start, jsonAt))
	}
	result.Timings = Timings{Projection: distribution(projection), AgentRender: distribution(agentRender), JSONEncode: distribution(jsonEncode), Pipeline: distribution(pipeline)}
	return result, ctx.Err()
}

func payloadMetrics(text string, counter tokenCounter) (Metrics, error) {
	count, err := counter.Count(text)
	if err != nil {
		return Metrics{}, errors.New("benchmark tokenizer failed")
	}
	return Metrics{Bytes: len(text), Tokens: count, SHA256: digest(text)}, nil
}

func digest(text string) string {
	hash := sha256.Sum256([]byte(text))
	return hex.EncodeToString(hash[:])
}

func distribution(samples []int64) Distribution {
	slices.Sort(samples)
	return Distribution{Samples: len(samples), MinNS: samples[0], P50NS: samples[(len(samples)*50+99)/100-1], P95NS: samples[(len(samples)*95+99)/100-1], MaxNS: samples[len(samples)-1]}
}

func Summary(report Report) string {
	var lines []string
	for _, result := range report.Cases {
		lines = append(lines, fmt.Sprintf("%s frame %d · nodes %d/%d · agent %d B/%d tok · JSON %d B/%d tok · pipeline p50/p95 %d/%d ns", result.Fixture, result.FrameIndex, result.ShownNodes, result.RenderedNodes, result.Agent.Bytes, result.Agent.Tokens, result.JSON.Bytes, result.JSON.Tokens, result.Timings.Pipeline.P50NS, result.Timings.Pipeline.P95NS))
	}
	return fmt.Sprintf("%s · %s · %d runs · %s\n%s", report.Renderer, report.Tokenizer.Encoding, report.Config.Runs, report.TimingClock, strings.Join(lines, "\n"))
}
