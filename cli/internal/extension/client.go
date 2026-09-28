package extension

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type Client struct {
	cfg   Config
	token string
	http  *http.Client
}

func NewClient(cfg Config) (*Client, TokenInfo, error) {
	cfg = NormalizeConfig(cfg)
	info, err := LoadToken(cfg)
	if err != nil {
		return nil, TokenInfo{}, err
	}
	return &Client{cfg: cfg, token: info.Token, http: &http.Client{Timeout: cfg.Timeout}}, info, nil
}

func (c *Client) Status() ([]byte, error) {
	return c.request(http.MethodGet, "/status", nil)
}

func (c *Client) Execute(cmd string, payload map[string]any) ([]byte, error) {
	payload["cmd"] = cmd
	return c.request(http.MethodPost, "/execute", payload)
}

func (c *Client) request(method, path string, body any) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		buf, err := marshalBody(body)
		if err != nil {
			return nil, err
		}
		reader = buf
	}
	req, err := http.NewRequest(method, strings.TrimRight(c.cfg.BaseURL, "/")+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 400 {
		return nil, fmt.Errorf("bridge returned %s: %s", res.Status, strings.TrimSpace(string(data)))
	}
	return data, nil
}

func ParsePayloadArgs(args []string) (map[string]any, error) {
	payload := map[string]any{}
	for i := 0; i < len(args); i++ {
		arg := strings.TrimSpace(args[i])
		if arg == "" {
			continue
		}
		if strings.HasPrefix(arg, "--") {
			key, raw, hasInlineValue := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
			key = NormalizePayloadKey(key)
			if key == "" {
				continue
			}
			if hasInlineValue {
				value, err := parseValue(raw)
				if err != nil {
					return nil, err
				}
				payload[key] = value
				continue
			}
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") && !looksLikePayloadBoundary(args[i+1]) {
				value, err := parseValue(args[i+1])
				if err != nil {
					return nil, err
				}
				payload[key] = value
				i++
				continue
			}
			payload[key] = true
			continue
		}
		if strings.HasPrefix(arg, "@") {
			object, err := readJSONObject(strings.TrimPrefix(arg, "@"))
			if err != nil {
				return nil, err
			}
			for k, v := range object {
				payload[NormalizePayloadKey(k)] = v
			}
			continue
		}
		if strings.HasPrefix(arg, "{") {
			var object map[string]any
			if err := json.Unmarshal([]byte(arg), &object); err != nil {
				return nil, fmt.Errorf("parse inline JSON object: %w", err)
			}
			for k, v := range object {
				payload[NormalizePayloadKey(k)] = v
			}
			continue
		}
		key, raw, ok := strings.Cut(arg, "=")
		if !ok {
			return nil, fmt.Errorf("expected %q to be key=value, --flag value, @file.json, or inline JSON object", arg)
		}
		value, err := parseValue(raw)
		if err != nil {
			return nil, err
		}
		payload[NormalizePayloadKey(strings.TrimSpace(key))] = value
	}
	return payload, nil
}

func NormalizePayloadKey(key string) string {
	key = strings.TrimSpace(strings.TrimLeft(key, "-"))
	key = strings.ReplaceAll(key, "_", "-")
	switch key {
	case "full", "full-page", "fullpage":
		return "fullPage"
	case "max-char", "max-chars", "maxchars":
		return "maxChars"
	case "new-tab", "newtab":
		return "newTab"
	case "tab", "tab-id", "tabid":
		return "tabId"
	case "node", "node-id", "nodeid":
		return "nodeId"
	case "document", "document-id", "documentid", "doc", "doc-id":
		return "documentId"
	case "request", "request-id", "requestid":
		return "requestId"
	case "include-body", "includebody", "body":
		return "includeBody"
	case "return-snapshot", "returnsnapshot":
		return "returnSnapshot"
	case "confirm-risky", "confirmrisky":
		return "confirmRisky"
	case "delta-x", "deltax":
		return "deltaX"
	case "delta-y", "deltay":
		return "deltaY"
	case "from-x", "fromx":
		return "fromX"
	case "from-y", "fromy":
		return "fromY"
	case "to-x", "tox":
		return "toX"
	case "to-y", "toy":
		return "toY"
	case "timeout", "timeout-ms", "timeoutms":
		return "timeoutMs"
	}
	parts := strings.Split(key, "-")
	if len(parts) == 1 {
		return parts[0]
	}
	var out strings.Builder
	out.WriteString(parts[0])
	for _, part := range parts[1:] {
		if part == "" {
			continue
		}
		out.WriteString(strings.ToUpper(part[:1]))
		if len(part) > 1 {
			out.WriteString(part[1:])
		}
	}
	return out.String()
}

func looksLikePayloadBoundary(value string) bool {
	return strings.HasPrefix(value, "@") || strings.HasPrefix(value, "{") || strings.Contains(value, "=")
}

func readJSONObject(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var object map[string]any
	if err := json.Unmarshal(data, &object); err != nil {
		return nil, fmt.Errorf("%s must contain a JSON object: %w", path, err)
	}
	return object, nil
}

func parseValue(raw string) (any, error) {
	value := strings.TrimSpace(raw)
	if strings.HasPrefix(value, "@") {
		data, err := os.ReadFile(strings.TrimPrefix(value, "@"))
		if err != nil {
			return nil, err
		}
		var decoded any
		if err := json.Unmarshal(data, &decoded); err == nil {
			return decoded, nil
		}
		return string(data), nil
	}
	if value == "" {
		return "", nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(value), &decoded); err == nil {
		return decoded, nil
	}
	return raw, nil
}

func PrettyPrintJSON(data []byte) string {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return string(data)
	}
	formatted, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return string(data)
	}
	return string(formatted)
}

func DurationFromSeconds(seconds int) time.Duration {
	if seconds <= 0 {
		return defaultTimeout
	}
	return time.Duration(seconds) * time.Second
}
