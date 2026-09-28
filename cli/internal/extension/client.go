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
	for _, arg := range args {
		arg = strings.TrimSpace(arg)
		if arg == "" {
			continue
		}
		if strings.HasPrefix(arg, "@") {
			object, err := readJSONObject(strings.TrimPrefix(arg, "@"))
			if err != nil {
				return nil, err
			}
			for k, v := range object {
				payload[k] = v
			}
			continue
		}
		if strings.HasPrefix(arg, "{") {
			var object map[string]any
			if err := json.Unmarshal([]byte(arg), &object); err != nil {
				return nil, fmt.Errorf("parse inline JSON object: %w", err)
			}
			for k, v := range object {
				payload[k] = v
			}
			continue
		}
		key, raw, ok := strings.Cut(arg, "=")
		if !ok {
			return nil, fmt.Errorf("expected %q to be key=value, @file.json, or inline JSON object", arg)
		}
		value, err := parseValue(raw)
		if err != nil {
			return nil, err
		}
		payload[strings.TrimSpace(key)] = value
	}
	return payload, nil
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
