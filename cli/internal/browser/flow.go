package browser

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/go-rod/rod"
)

type FlowStep struct {
	Action    string  `json:"action"` // click, type, press_key, scroll, wait, navigate
	Target    string  `json:"target,omitempty"`
	Selector  string  `json:"selector,omitempty"`
	Role      string  `json:"role,omitempty"`
	Name      string  `json:"name,omitempty"`
	Text      string  `json:"text,omitempty"`
	Key       string  `json:"key,omitempty"`
	URL       string  `json:"url,omitempty"`
	DeltaX    float64 `json:"deltaX,omitempty"`
	DeltaY    float64 `json:"deltaY,omitempty"`
	TimeoutMs int     `json:"timeoutMs,omitempty"`
}

type StepReport struct {
	StepIndex int    `json:"stepIndex"`
	Action    string `json:"action"`
	Success   bool   `json:"success"`
	Message   string `json:"message"`
	Duration  string `json:"duration"`
}

type FlowReport struct {
	Success     bool         `json:"success"`
	TotalSteps  int          `json:"totalSteps"`
	PassedSteps int          `json:"passedSteps"`
	Duration    string       `json:"duration"`
	Steps       []StepReport `json:"steps"`
}

// RunFlow executes a list of sequential steps on the active page.
func RunFlow(page *rod.Page, steps []FlowStep) (*FlowReport, error) {
	start := time.Now()
	var reports []StepReport

	for i, step := range steps {
		stepStart := time.Now()
		target := step.Target
		if target == "" {
			target = step.Selector
		}

		var err error
		var msg string

		switch step.Action {
		case "navigate":
			res, e := Navigate(page, step.URL)
			err = e
			if res != nil {
				msg = res.Message
			}
		case "click":
			res, e := Click(page, target)
			err = e
			if res != nil {
				msg = res.Message
			}
		case "type":
			res, e := Type(page, target, step.Text, false)
			err = e
			if res != nil {
				msg = res.Message
			}
		case "press_key", "press":
			res, e := PressKey(page, step.Key)
			err = e
			if res != nil {
				msg = res.Message
			}
		case "scroll":
			res, e := Scroll(page, step.DeltaX, step.DeltaY)
			err = e
			if res != nil {
				msg = res.Message
			}
		case "wait", "sleep":
			waitDuration := time.Duration(step.TimeoutMs) * time.Millisecond
			if waitDuration <= 0 {
				waitDuration = 1000 * time.Millisecond
			}
			time.Sleep(waitDuration)
			msg = fmt.Sprintf("Waited for %v", waitDuration)
		default:
			err = fmt.Errorf("unsupported flow action: %s", step.Action)
		}

		duration := time.Since(stepStart).String()
		if err != nil {
			reports = append(reports, StepReport{
				StepIndex: i + 1,
				Action:    step.Action,
				Success:   false,
				Message:   err.Error(),
				Duration:  duration,
			})
			return &FlowReport{
				Success:     false,
				TotalSteps:  len(steps),
				PassedSteps: i,
				Duration:    time.Since(start).String(),
				Steps:       reports,
			}, fmt.Errorf("flow stopped at step %d (%s): %w", i+1, step.Action, err)
		}

		reports = append(reports, StepReport{
			StepIndex: i + 1,
			Action:    step.Action,
			Success:   true,
			Message:   msg,
			Duration:  duration,
		})
	}

	return &FlowReport{
		Success:     true,
		TotalSteps:  len(steps),
		PassedSteps: len(steps),
		Duration:    time.Since(start).String(),
		Steps:       reports,
	}, nil
}

// LoadFlowFile parses a JSON file containing an array of FlowSteps.
func LoadFlowFile(filePath string) ([]FlowStep, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read flow file %s: %w", filePath, err)
	}
	var steps []FlowStep
	if err := json.Unmarshal(data, &steps); err != nil {
		return nil, fmt.Errorf("failed to parse flow JSON: %w", err)
	}
	return steps, nil
}
