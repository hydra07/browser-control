package cdp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Options struct {
	MaxMessageBytes int64
	CallTimeout     time.Duration
	AllowRemote     bool
}

type Stats struct {
	Calls         map[string]uint64 `json:"calls"`
	BytesSent     uint64            `json:"bytesSent"`
	BytesReceived uint64            `json:"bytesReceived"`
}

type CommandError struct {
	Method  string
	Written bool
	Cause   error
}

func (e *CommandError) Error() string {
	return fmt.Sprintf("%s (write attempted: %t): %v", e.Method, e.Written, e.Cause)
}
func (e *CommandError) Unwrap() error { return e.Cause }

type ProtocolError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *ProtocolError) Error() string { return fmt.Sprintf("CDP %d: %s", e.Code, e.Message) }

type response struct {
	Result json.RawMessage
	Error  error
}

type Client struct {
	ws       *websocket.Conn
	options  Options
	writer   chan struct{}
	done     chan struct{}
	mu       sync.Mutex
	err      error
	next     uint64
	pending  map[uint64]chan response
	targets  map[string]*Target
	detached map[string]bool
	stats    Stats
}

func Connect(ctx context.Context, endpoint string, options Options) (*Client, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := validateEndpoint(endpoint, options.AllowRemote); err != nil {
		return nil, err
	}
	if options.MaxMessageBytes == 0 {
		options.MaxMessageBytes = 16 * 1024 * 1024
	}
	if options.CallTimeout == 0 {
		options.CallTimeout = 10 * time.Second
	}
	if options.MaxMessageBytes < 1024 || options.MaxMessageBytes > 64*1024*1024 || options.CallTimeout <= 0 || options.CallTimeout > 2*time.Minute {
		return nil, errors.New("invalid CDP transport limits")
	}
	dialer := websocket.Dialer{HandshakeTimeout: options.CallTimeout}
	ws, reply, err := dialer.DialContext(ctx, endpoint, nil)
	if reply != nil && reply.Body != nil {
		_ = reply.Body.Close()
	}
	if err != nil {
		return nil, fmt.Errorf("connect Chrome: %w", err)
	}
	ws.SetReadLimit(options.MaxMessageBytes)
	c := &Client{ws: ws, options: options, writer: make(chan struct{}, 1), done: make(chan struct{}), pending: map[uint64]chan response{}, targets: map[string]*Target{}, detached: map[string]bool{}, stats: Stats{Calls: map[string]uint64{}}}
	go c.readLoop()
	return c, nil
}

// Close releases this connection and its handles; it never closes the user's browser.
func (c *Client) Close() error { c.fail(io.ErrClosedPipe); return nil }

func (c *Client) Stats() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()
	stats := c.stats
	stats.Calls = maps.Clone(stats.Calls)
	return stats
}

func (c *Client) call(ctx context.Context, session, method string, params, out any) error {
	return c.callWithReceipt(ctx, session, method, params, out, nil)
}

type writeReceipt struct{ attemptedAt int64 }

func (c *Client) callWithReceipt(ctx context.Context, session, method string, params, out any, receipt *writeReceipt) error {
	ctx, cancel := context.WithTimeout(ctx, c.options.CallTimeout)
	defer cancel()
	failure := func(written bool, err error) error {
		return &CommandError{Method: method, Written: written, Cause: err}
	}
	if err := ctx.Err(); err != nil {
		return failure(false, err)
	}
	if params == nil {
		params = map[string]any{}
	}
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		return failure(false, err)
	}
	c.next++
	id := c.next
	wait := make(chan response, 1)
	c.pending[id] = wait
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, id); c.mu.Unlock() }()
	message, err := json.Marshal(struct {
		ID      uint64 `json:"id"`
		Session string `json:"sessionId,omitempty"`
		Method  string `json:"method"`
		Params  any    `json:"params"`
	}{id, session, method, params})
	if err != nil {
		return failure(false, err)
	}
	if int64(len(message)) > c.options.MaxMessageBytes {
		return failure(false, errors.New("CDP request exceeds transport limit"))
	}
	select {
	case c.writer <- struct{}{}:
	case <-ctx.Done():
		return failure(false, ctx.Err())
	case <-c.done:
		return failure(false, io.ErrClosedPipe)
	}
	if err := ctx.Err(); err != nil {
		<-c.writer
		return failure(false, err)
	}
	c.mu.Lock()
	closed := c.err
	c.mu.Unlock()
	if closed != nil {
		<-c.writer
		return failure(false, closed)
	}
	deadline, _ := ctx.Deadline()
	_ = c.ws.SetWriteDeadline(deadline)
	if err := ctx.Err(); err != nil {
		<-c.writer
		return failure(false, err)
	}
	if receipt != nil {
		receipt.attemptedAt = time.Now().UnixMilli()
	}
	err = c.ws.WriteMessage(websocket.TextMessage, message)
	<-c.writer
	c.mu.Lock()
	c.stats.Calls[method]++
	c.stats.BytesSent += uint64(len(message))
	c.mu.Unlock()
	if err != nil {
		c.fail(err)
		return failure(true, err)
	}
	var reply response
	select {
	case reply = <-wait:
	case <-ctx.Done():
		select {
		case reply = <-wait:
		default:
			return failure(true, ctx.Err())
		}
	}
	if reply.Error != nil {
		return failure(true, reply.Error)
	}
	if out != nil {
		if err := json.Unmarshal(reply.Result, out); err != nil {
			return failure(true, fmt.Errorf("invalid CDP result: %w", err))
		}
	}
	return nil
}

func (c *Client) readLoop() {
	for {
		kind, data, err := c.ws.ReadMessage()
		if err != nil {
			c.fail(err)
			return
		}
		if kind != websocket.TextMessage {
			c.fail(errors.New("unexpected CDP binary message"))
			return
		}
		var message struct {
			ID     uint64
			Method string
			Params json.RawMessage
			Result json.RawMessage
			Error  *ProtocolError
		}
		if err := json.Unmarshal(data, &message); err != nil {
			c.fail(fmt.Errorf("invalid CDP response: %w", err))
			return
		}
		if message.ID == 0 && message.Method == "" {
			c.fail(errors.New("CDP message has neither response ID nor event method"))
			return
		}
		c.mu.Lock()
		c.stats.BytesReceived += uint64(len(data))
		if message.ID != 0 {
			wait := c.pending[message.ID]
			delete(c.pending, message.ID)
			if wait != nil {
				reply := response{Result: message.Result}
				if message.Error != nil {
					reply.Error = message.Error
				} else if len(message.Result) == 0 || string(message.Result) == "null" {
					reply.Error = errors.New("CDP response has no result")
				}
				wait <- reply
			}
		} else if message.Method == "Target.detachedFromTarget" {
			var params struct{ SessionID string }
			if json.Unmarshal(message.Params, &params) == nil {
				if target := c.targets[params.SessionID]; target != nil {
					target.valid.Store(false)
					delete(c.targets, params.SessionID)
				} else if params.SessionID != "" {
					// Detach can arrive before the caller registers an attach response.
					if len(c.detached) >= 256 {
						c.mu.Unlock()
						c.fail(errors.New("CDP detached-session history exceeded its bound"))
						return
					}
					c.detached[params.SessionID] = true
				}
			}
		}
		c.mu.Unlock()
	}
}

func (c *Client) fail(err error) {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return
	}
	c.err = err
	for id, wait := range c.pending {
		wait <- response{Error: err}
		delete(c.pending, id)
	}
	for _, target := range c.targets {
		target.valid.Store(false)
	}
	close(c.done)
	c.mu.Unlock()
	_ = c.ws.Close()
}
