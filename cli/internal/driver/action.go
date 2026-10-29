package driver

import (
	"crypto/rand"
	"errors"
	"math"
	"time"
)

type ActionStatus string

const (
	Completed      ActionStatus = "completed"
	Blocked        ActionStatus = "blocked"
	Cancelled      ActionStatus = "cancelled"
	Failed         ActionStatus = "failed"
	OutcomeUnknown ActionStatus = "outcome_unknown"
)

type ActionResult struct {
	ActionID        string       `json:"actionId"`
	Kind            ActionKind   `json:"kind"`
	Status          ActionStatus `json:"status"`
	Dispatched      bool         `json:"dispatched"`
	InputState      InputState   `json:"inputState"`
	Acknowledged    bool         `json:"acknowledged"`
	CleanupComplete bool         `json:"cleanupComplete"`
	StartedAt       int64        `json:"startedAt"`
	DispatchedAt    *int64       `json:"dispatchedAt"`
	FinishedAt      int64        `json:"finishedAt"`
	BBox            *Bounds      `json:"bbox"`
	Verified        bool         `json:"verified"`
	Observation     Observation  `json:"observation"`
}

type ActionKind string

const (
	Click      ActionKind = "click"
	Press      ActionKind = "press"
	InsertText ActionKind = "insert_text"
	Navigate   ActionKind = "navigate"
	CreateTab  ActionKind = "create_tab"
	CloseTab   ActionKind = "close_tab"
	Scroll     ActionKind = "scroll"
)

type InputState string

const (
	NotSent        InputState = "not_sent"
	WriteAttempted InputState = "write_attempted"
	Acknowledged   InputState = "acknowledged"
)

type Observation string

const (
	NotObserved  Observation = "not_observed"
	SnapshotAt   Observation = "snapshot_at"
	ConditionMet Observation = "condition_met"
)

type Bounds struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

func NewAction(kind ActionKind) ActionResult {
	return ActionResult{ActionID: "a_" + rand.Text(), Kind: kind, Status: Failed, InputState: NotSent,
		StartedAt: time.Now().UnixMilli(), CleanupComplete: true, Observation: NotObserved}
}

func ValidActionID(id string) bool {
	if len(id) < 3 || len(id) > 128 || id[:2] != "a_" {
		return false
	}
	for _, char := range id[2:] {
		if !(char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '_' || char == '-') {
			return false
		}
	}
	return true
}

func (r ActionResult) Validate() error {
	valid := ValidActionID(r.ActionID) && ValidActionKind(r.Kind)
	valid = valid && (r.Status == Completed || r.Status == Blocked || r.Status == Cancelled || r.Status == Failed || r.Status == OutcomeUnknown)
	valid = valid && r.StartedAt > 0 && r.FinishedAt >= r.StartedAt && r.FinishedAt <= 9007199254740991
	valid = valid && (r.InputState == NotSent || r.InputState == WriteAttempted || r.InputState == Acknowledged)
	valid = valid && r.Dispatched == (r.InputState != NotSent) && r.Acknowledged == (r.InputState == Acknowledged)
	valid = valid && (!r.Acknowledged || r.CleanupComplete)
	if r.Dispatched && !r.CleanupComplete {
		valid = valid && r.Status == OutcomeUnknown
	}
	if r.Dispatched {
		valid = valid && r.DispatchedAt != nil && *r.DispatchedAt >= r.StartedAt && *r.DispatchedAt <= r.FinishedAt
	} else {
		valid = valid && r.DispatchedAt == nil
	}
	if r.Status == Completed {
		valid = valid && r.Dispatched && r.Acknowledged && r.CleanupComplete
	}
	if r.Status == OutcomeUnknown {
		valid = valid && r.Dispatched
	}
	valid = valid && (r.Observation == NotObserved || r.Observation == SnapshotAt || r.Observation == ConditionMet)
	if r.Verified {
		valid = valid && r.Status == Completed && r.Observation == ConditionMet
	}
	if box := r.BBox; box != nil {
		for _, value := range []float64{box.X, box.Y, box.Width, box.Height} {
			valid = valid && !math.IsInf(value, 0) && !math.IsNaN(value)
		}
		valid = valid && box.Width >= 0 && box.Height >= 0
	}
	if !valid {
		return errors.New("invalid action result")
	}
	return nil
}

func ValidActionKind(kind ActionKind) bool {
	return kind == Click || kind == Press || kind == InsertText || kind == Navigate || kind == CreateTab || kind == CloseTab || kind == Scroll
}

type Point struct{ X, Y float64 }

type Key struct {
	Key        string
	Code       string
	VirtualKey int
	Text       string
}
