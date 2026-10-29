package driver

import "context"

type PageInfo struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

type AgentNode struct {
	ID       int    `json:"id"`
	Role     string `json:"role"`
	Name     string `json:"name"`
	Value    string `json:"value,omitempty"`
	Disabled bool   `json:"disabled,omitempty"`
}

type AgentSnapshot struct {
	Epoch     string      `json:"documentId"`
	URL       string      `json:"url"`
	Title     string      `json:"title"`
	Nodes     []AgentNode `json:"nodes"`
	Truncated bool        `json:"truncated"`
	Coverage  string      `json:"coverage"`
}

type AgentRequest struct {
	Operation string   `json:"op"`
	Target    string   `json:"target,omitempty"`
	Epoch     string   `json:"epoch,omitempty"`
	Text      string   `json:"text,omitempty"`
	Clear     bool     `json:"clear,omitempty"`
	X         float64  `json:"x,omitempty"`
	Y         float64  `json:"y,omitempty"`
	Origins   []string `json:"origins,omitempty"`
}

type AgentPage interface {
	ID() string
	Close(context.Context) error
	Snapshot(context.Context) (AgentSnapshot, error)
	CheckOrigin(context.Context, []string) error
	Navigate(context.Context, string) (ActionResult, error)
	Act(context.Context, AgentRequest) (ActionResult, error)
	Press(context.Context, []Key) (ActionResult, error)
	ReadText(context.Context, int) (string, error)
	Wait(context.Context, string) error
	Screenshot(context.Context, bool) ([]byte, error)
}

type AgentBrowser interface {
	Close() error
	Pages(context.Context) ([]PageInfo, error)
	OpenBlank(context.Context) (AgentPage, ActionResult, error)
	AttachPage(context.Context, string) (AgentPage, error)
	RemovePage(context.Context, string) (ActionResult, error)
}
