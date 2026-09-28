package browser

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/go-rod/rod"
)

type FlowStep struct {
	Action    string  `json:"action"` // navigate, click, type, press_key, scroll, wait, assert_text, find
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

type FlowDocument struct {
	ID          string     `json:"id,omitempty"`
	Name        string     `json:"name,omitempty"`
	Description string     `json:"description,omitempty"`
	Domain      string     `json:"domain,omitempty"`
	Steps       []FlowStep `json:"steps"`
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
		target := firstNonEmpty(step.Target, step.Selector, step.Name)

		var err error
		var msg string

		switch step.Action {
		case "navigate", "open":
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
		case "assert_text":
			res, e := ExtractReadingMode(page, 0)
			err = e
			if err == nil && !strings.Contains(strings.ToLower(res.Text), strings.ToLower(step.Text)) {
				err = fmt.Errorf("text not found: %q", step.Text)
			}
			msg = fmt.Sprintf("Asserted text %q", step.Text)
		case "find":
			res, e := Find(page, step.Text, 1)
			err = e
			if err == nil && len(res.Matches) == 0 {
				err = fmt.Errorf("no matches for %q", step.Text)
			}
			msg = fmt.Sprintf("Found %q", step.Text)
		case "wait", "sleep", "wait_for":
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
			reports = append(reports, StepReport{StepIndex: i + 1, Action: step.Action, Success: false, Message: err.Error(), Duration: duration})
			return &FlowReport{Success: false, TotalSteps: len(steps), PassedSteps: i, Duration: time.Since(start).String(), Steps: reports}, fmt.Errorf("flow stopped at step %d (%s): %w", i+1, step.Action, err)
		}

		reports = append(reports, StepReport{StepIndex: i + 1, Action: step.Action, Success: true, Message: msg, Duration: duration})
	}

	return &FlowReport{Success: true, TotalSteps: len(steps), PassedSteps: len(steps), Duration: time.Since(start).String(), Steps: reports}, nil
}

func LoadFlow(pathOrID string) ([]FlowStep, error) {
	if doc, err := GetSavedFlow(pathOrID); err == nil {
		return doc.Steps, nil
	}
	return LoadFlowFile(pathOrID)
}

// LoadFlowFile parses a JSON file containing either an array of FlowStep or a flow document with a steps field.
func LoadFlowFile(filePath string) ([]FlowStep, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read flow file %s: %w", filePath, err)
	}
	var steps []FlowStep
	if err := json.Unmarshal(data, &steps); err == nil {
		return steps, nil
	}
	var doc FlowDocument
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("failed to parse flow JSON: %w", err)
	}
	if len(doc.Steps) == 0 {
		return nil, fmt.Errorf("flow JSON has no steps")
	}
	return doc.Steps, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
