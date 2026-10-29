package driver

type CaptureOptions struct {
	MaxNodes            int
	MaxFrames           int
	RequireFixtureReady bool
}

type CaptureRequest struct {
	URL      string
	TargetID string
	Private  bool
	CaptureOptions
}

type Frame struct {
	ID       string `json:"id"`
	ParentID string `json:"parentId,omitempty"`
	URL      string `json:"url"`
}

type DOMNode struct {
	Index      int               `json:"index"`
	Parent     int               `json:"parent"`
	Handle     int               `json:"handle,omitempty"`
	Type       int               `json:"type"`
	Name       string            `json:"name"`
	ShadowRoot string            `json:"shadowRoot,omitempty"`
	Text       string            `json:"text,omitempty"`
	Value      string            `json:"value,omitempty"`
	Attributes map[string]string `json:"attributes,omitempty"`
}

type Document struct {
	FrameID string    `json:"frameId"`
	URL     string    `json:"url"`
	Title   string    `json:"title"`
	Nodes   []DOMNode `json:"nodes"`
}

type AccessNode struct {
	ID       string            `json:"id"`
	ParentID string            `json:"parentId,omitempty"`
	Children []string          `json:"children,omitempty"`
	Handle   int               `json:"handle,omitempty"`
	Role     string            `json:"role"`
	Name     string            `json:"name,omitempty"`
	Value    string            `json:"value,omitempty"`
	Ignored  bool              `json:"ignored,omitempty"`
	States   map[string]string `json:"states,omitempty"`
}

type AccessTree struct {
	FrameID string       `json:"frameId"`
	Nodes   []AccessNode `json:"nodes"`
}

type Capture struct {
	Epoch         string       `json:"epoch"`
	URL           string       `json:"url"`
	Browser       string       `json:"browser"`
	Frames        []Frame      `json:"frames"`
	Documents     []Document   `json:"documents"`
	Accessibility []AccessTree `json:"accessibility"`
	Truncated     bool         `json:"truncated"`
	MissingFrames []string     `json:"missingFrames,omitempty"`
}
