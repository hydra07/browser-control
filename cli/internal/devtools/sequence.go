package devtools

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
	"github.com/hydra07/browsercontrol/cli/internal/privacy"
)

type SequenceKind string

const (
	ActionSequence   SequenceKind = "action"
	ResumeSequence   SequenceKind = "resume"
	Retained                      = "retained"
	Remapped                      = "remapped"
	Stale                         = "stale"
	GuardMatch                    = "match"
	StaleFingerprint              = "stale_fingerprint"
	Continuous                    = "continuous"
	Reconstructed                 = "reconstructed"
	Incomplete                    = "incomplete"
	SnapshotAt                    = "snapshot_at"
	SameDocument                  = "same_document"
	Reloaded                      = "reloaded"
	Navigated                     = "navigated"
	BrowserRestarted              = "browser_restarted"
)

type Sequence struct {
	SchemaVersion  int                  `json:"schemaVersion"`
	Classification Classification       `json:"classification"`
	ID             string               `json:"id"`
	Kind           SequenceKind         `json:"kind"`
	States         []SequenceState      `json:"states"`
	Transitions    []SequenceTransition `json:"transitions"`
}

type SequenceState struct {
	ID          string           `json:"id"`
	Observation string           `json:"observation"`
	Document    string           `json:"document"`
	Browser     string           `json:"browser"`
	Snapshot    driver.Capture   `json:"snapshot"`
	Nodes       []SequenceNode   `json:"nodes"`
	Facts       []SequenceFact   `json:"facts"`
	Coverage    SequenceCoverage `json:"coverage"`
}

type SequenceNode struct {
	Key      string `json:"key"`
	Ref      string `json:"ref"`
	Physical string `json:"physical"`
	Handle   int    `json:"handle"`
	Anchor   string `json:"anchor"`
}

type SequenceFact struct {
	Key      string  `json:"key"`
	NodeKey  string  `json:"nodeKey"`
	Property string  `json:"property"`
	Captured bool    `json:"captured"`
	Value    *string `json:"value"`
}

type SequenceCoverage struct {
	Scopes         []string `json:"scopes"`
	Unobservable   []string `json:"unobservable"`
	Complete       bool     `json:"complete"`
	ObserverActive bool     `json:"observerActive"`
	Gap            bool     `json:"gap"`
	Revision       int      `json:"revision"`
	OldestRevision int      `json:"oldestRevision"`
	History        []string `json:"history"`
}

type SequenceTransition struct {
	From     string              `json:"from"`
	To       string              `json:"to"`
	Trigger  string              `json:"trigger"`
	Offline  bool                `json:"offline"`
	Reopen   bool                `json:"reopen"`
	Expected SequenceExpectation `json:"expected"`
}

type SequenceExpectation struct {
	DocumentState string               `json:"documentState"`
	Provenance    string               `json:"provenance"`
	Mappings      []RefExpectation     `json:"mappings"`
	Content       []ContentExpectation `json:"content"`
}

type RefExpectation struct {
	Key         string `json:"key"`
	FromRef     string `json:"fromRef"`
	ToRef       string `json:"toRef,omitempty"`
	Decision    string `json:"decision"`
	AnchorGuard string `json:"anchorGuard"`
}

type ContentExpectation struct {
	Key    string  `json:"key"`
	Status string  `json:"status"`
	Before *string `json:"before"`
	After  *string `json:"after"`
}

func ReadSequence(reader io.Reader) (Sequence, error) {
	data, err := io.ReadAll(io.LimitReader(reader, (16<<20)+1))
	if err != nil || len(data) > 16<<20 || len(privacy.CheckFile("fixtures/synthetic/sequence.json", data)) != 0 {
		return Sequence{}, errors.New("unsafe or oversized sequence fixture")
	}
	var sequence Sequence
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&sequence) != nil {
		return Sequence{}, errors.New("invalid sequence schema")
	}
	if err := ValidateSequence(sequence); err != nil {
		return Sequence{}, err
	}
	return sequence, nil
}

func (p *OutputPlan) WriteSequence(sequence Sequence) error {
	if p.class != Synthetic || sequence.Classification != Synthetic {
		return errors.New("sequence fixtures must be synthetic")
	}
	if err := ValidateSequence(sequence); err != nil {
		return err
	}
	return p.writeJSON(sequence)
}

func NormalizeSequence(sequence Sequence, origin string) Sequence {
	for i := range sequence.States {
		fixture := NormalizeSynthetic(Fixture{Snapshot: sequence.States[i].Snapshot}, origin)
		sequence.States[i].Snapshot = fixture.Snapshot
	}
	return sequence
}

func CaptureFact(capture driver.Capture, key, property string) (*string, error) {
	var found *driver.DOMNode
	var document *driver.Document
	for i := range capture.Documents {
		for j := range capture.Documents[i].Nodes {
			node := &capture.Documents[i].Nodes[j]
			if node.Attributes["data-testid"] == key {
				if found != nil {
					return nil, errors.New("ambiguous fixture witness")
				}
				found, document = node, &capture.Documents[i]
			}
		}
	}
	if found == nil {
		return nil, nil
	}
	var value string
	switch {
	case property == "value":
		value = found.Value
	case property == "attr:aria-rowcount":
		var present bool
		value, present = found.Attributes["aria-rowcount"]
		if !present {
			return nil, nil
		}
	case property == "anchor":
		byIndex := map[int]driver.DOMNode{}
		for _, node := range document.Nodes {
			byIndex[node.Index] = node
		}
		current := *found
		for range len(document.Nodes) + 1 {
			if anchor, exists := current.Attributes["data-test"]; exists {
				return &anchor, nil
			}
			if current.Parent < 0 {
				value = "page"
				return &value, nil
			}
			var exists bool
			current, exists = byIndex[current.Parent]
			if !exists {
				return nil, errors.New("incomplete fixture ancestor witness")
			}
		}
		return nil, errors.New("cyclic fixture ancestor witness")
	case property == "text":
		descendants := map[int]bool{found.Index: true}
		var text []string
		for _, node := range document.Nodes {
			if descendants[node.Parent] {
				descendants[node.Index] = true
			}
			if descendants[node.Index] && node.Type == 3 && node.Text != "" {
				text = append(text, node.Text)
			}
		}
		value = strings.Join(strings.Fields(strings.Join(text, " ")), " ")
	default:
		return nil, errors.New("unsupported fixture fact property")
	}
	return &value, nil
}

func WitnessNode(capture driver.Capture, key string) (driver.DOMNode, error) {
	var found driver.DOMNode
	for _, document := range capture.Documents {
		for _, node := range document.Nodes {
			if node.Attributes["data-testid"] == key {
				if found.Handle != 0 {
					return driver.DOMNode{}, errors.New("ambiguous fixture node witness")
				}
				found = node
			}
		}
	}
	if found.Handle <= 0 {
		return driver.DOMNode{}, errors.New("fixture node witness missing")
	}
	return found, nil
}
