package cdp

import "encoding/json"

type captureFrame struct {
	Frame       struct{ ID, ParentID, URL, LoaderID string }
	ChildFrames []captureFrame
}

type rareStrings struct{ Index, Value []int }

type captureDOM struct {
	Strings   []string
	Documents []struct {
		DocumentURL, Title, FrameID int
		Nodes                       struct {
			ParentIndex, NodeType, NodeName, NodeValue, BackendNodeID []int
			Attributes                                                [][]int
			InputValue, TextValue, ShadowRootType                     rareStrings
		}
	}
}

type captureAXValue struct{ Value json.RawMessage }

func (v captureAXValue) text() string {
	var text string
	if json.Unmarshal(v.Value, &text) == nil {
		return text
	}
	var scalar any
	if json.Unmarshal(v.Value, &scalar) == nil {
		switch scalar.(type) {
		case bool, float64:
			return string(v.Value)
		}
	}
	return ""
}

type captureAXNode struct {
	NodeID, ParentID  string
	ChildIDs          []string
	BackendDOMNodeID  int
	Ignored           bool
	Role, Name, Value captureAXValue
	Properties        []struct {
		Name  string
		Value captureAXValue
	}
}
