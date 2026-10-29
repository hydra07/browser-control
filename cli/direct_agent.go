package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
	"github.com/hydra07/browsercontrol/cli/internal/privacy"
	sessionstore "github.com/hydra07/browsercontrol/cli/internal/session"
)

func isAgentCommand(name string) bool {
	switch name {
	case "open", "snapshot", "click", "type", "fill", "press", "tabs", "screenshot", "read", "wait", "scroll", "pending", "ack":
		return true
	}
	return false
}

func agentHelp(name string) string {
	usage := map[string]string{
		"pending": "", "ack": "<action-id> --ack-unknown",
		"open":     "<url> [--new-tab] [--headless] [--executable path]",
		"snapshot": "[--grep text] [--limit 80]",
		"click":    "<snapshot-id|css-selector>", "type": "<snapshot-id|css-selector> <text> [--clear]", "fill": "<snapshot-id|css-selector> <text>",
		"press": "<key|Control+a>", "tabs": "[list|new <url>|switch <target-id|listed-index>|close <target-id|listed-index>]",
		"screenshot": "[file.png] [--out file.png] [--full]", "read": "[--max-chars 6000]", "wait": "<visible-text|css=selector> [--timeout 30s]", "scroll": "<dy|up|down> [dx]",
	}
	return "Usage: browsercontrol " + name + " " + usage[name] + "\n\nDirect CDP; owned agent profile; no extension or bridge.\nFlags: --session-id <id> --profile <name> --tab <target-id|listed-index> --timeout 30s --json --help\nActions: --snap captures a fresh snapshot after acknowledged input.\nUse open, snapshot, then click/type/fill; numeric IDs require the last observed document.\nSnapshot covers the main document and open shadow roots; child frames are not collected.\nActions report input acknowledgement; verify effects with snapshot/read/wait. No automatic replay.\n"
}

func validateAgentOptions(o directOptions) error {
	a := o.positionals
	name := a[0]
	if name == "ack" {
		if len(a) != 2 || !o.ackUnknown || !driver.ValidActionID(a[1]) {
			return usagef("usage: browsercontrol ack <action-id> --ack-unknown (inspect current state first)")
		}
		return nil
	}
	if o.ackUnknown {
		return usagef("--ack-unknown requires the explicit ack command")
	}
	count := len(a) - 1
	if o.allowPrivate || o.maxNodes != 0 || o.maxFrames != 0 || o.target != "" {
		return usagef("fixture flags do not apply to agent commands; use --tab for a browser target")
	}
	if name != "open" && (o.headless || o.executable != "" || o.noSandbox || o.newTab) {
		return usagef("browser launch and --new-tab options apply only to open")
	}
	if name != "screenshot" && (o.out != "" || o.full) {
		return usagef("--out and --full apply only to screenshot")
	}
	if name != "snapshot" && (o.bench.Grep != "" || o.bench.Limit != 80) {
		return usagef("--grep and --limit apply only to snapshot")
	}
	if name != "type" && name != "fill" && o.clear {
		return usagef("--clear applies only to type/fill")
	}
	if o.benchOnly {
		return usagef("renderer benchmark options apply only to dev bench-render")
	}
	switch name {
	case "open", "click", "press", "wait":
		if count != 1 {
			return usagef("%s", agentHelp(name))
		}
	case "type", "fill":
		if count != 2 {
			return usagef("%s", agentHelp(name))
		}
		if len(a[2]) > 1<<20 {
			return usagef("text exceeds 1 MiB")
		}
	case "snapshot", "read", "pending":
		if count != 0 {
			return usagef("%s", agentHelp(name))
		}
	case "screenshot":
		if count > 1 {
			return usagef("%s", agentHelp(name))
		}
		if count == 1 && o.out != "" {
			return usagef("choose a positional screenshot file or --out, not both")
		}
		path := o.out
		if path == "" && count == 1 {
			path = a[1]
		}
		if path != "" && !strings.EqualFold(filepath.Ext(path), ".png") {
			return usagef("screenshot output must end in .png")
		}
	case "scroll":
		if count < 1 || count > 2 {
			return usagef("%s", agentHelp(name))
		}
		_, _, err := scrollDeltas(a[1:])
		if err != nil {
			return err
		}
	case "tabs":
		if count > 2 {
			return usagef("%s", agentHelp(name))
		}
		if count > 0 && a[1] != "list" && a[1] != "switch" && a[1] != "close" && a[1] != "new" {
			return usagef("%s", agentHelp(name))
		}
		if count > 0 && a[1] != "list" && count != 2 {
			return usagef("%s", agentHelp(name))
		}
		if count > 1 && a[1] == "list" {
			return usagef("%s", agentHelp(name))
		}
	}
	if name == "open" || name == "tabs" && count > 0 && a[1] == "new" {
		value := a[len(a)-1]
		u, err := url.Parse(value)
		if err != nil || u.User != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return usagef("open requires an HTTP(S) URL without credentials")
		}
	}
	if o.bench.Limit < 0 || o.bench.Limit > 2000 {
		return usagef("--limit must be between 0 and 2000")
	}
	if name == "press" {
		_, err := agentKeys(a[1])
		return err
	}
	return nil
}

func runAgentCommand(o directOptions, g globalOpts) int {
	if err := validateAgentOptions(o); err != nil {
		return reportError(g, err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, o.timeout)
	defer cancel()
	out, err := executeAgentCommand(ctx, o)
	if err != nil {
		return reportError(g, err)
	}
	(&session{g: g}).print(out)
	return 0
}

func executeAgentCommand(ctx context.Context, o directOptions) (output, error) {
	if o.positionals[0] == "tabs" && len(o.positionals) > 1 && o.positionals[1] == "new" {
		o.positionals = []string{"open", o.positionals[2]}
		o.newTab = true
	}
	root, err := directStoreRoot()
	if err != nil {
		return output{}, err
	}
	store, err := sessionstore.NewStore(root, o.sessionID)
	if err != nil {
		return output{}, err
	}
	lock, err := store.Acquire(ctx)
	if err != nil {
		return output{}, err
	}
	defer lock.Close()
	state, err := store.Load()
	if errors.Is(err, os.ErrNotExist) {
		state = sessionstore.State{SchemaVersion: sessionstore.SchemaVersion, ID: o.sessionID}
	} else if err != nil {
		return output{}, err
	}
	permissions := state.EffectivePermissions()
	name := o.positionals[0]
	if err := permissions.Check(sessionstore.Read, ""); err != nil {
		return output{}, err
	}
	if name == "pending" || name == "ack" {
		journal, err := store.OpenJournal(lock)
		if err != nil {
			return output{}, err
		}
		if name == "ack" {
			if !permissions.Act {
				return output{}, sessionstore.ErrPermission
			}
			if err := journal.AcknowledgeUnknown(ctx, o.positionals[1]); err != nil {
				return output{}, err
			}
			return output{data: map[string]any{"acknowledgedUnknown": o.positionals[1], "verified": false}, text: "uncertainty acknowledged; no action replayed or effect verified"}, nil
		}
		pending, err := journal.Uncertain()
		return output{data: map[string]any{"pending": pending}, text: fmt.Sprintf("%d uncertain actions; inspect state, then ack <action-id> --ack-unknown if appropriate", len(pending))}, err
	}
	if err := permissions.Check(sessionstore.Read, ""); err != nil {
		return output{}, err
	}
	manager, err := sessionstore.NewBrowserManager(root)
	if err != nil {
		return output{}, err
	}
	if name == "open" {
		if err := permissions.Check(sessionstore.Act, o.positionals[1]); err != nil {
			return output{}, err
		}
		profile := o.profile
		if profile == "" && state.Browser != nil {
			profile = state.Browser.Profile
		}
		if profile == "" {
			profile = "agent"
		}
		info, err := manager.Start(ctx, sessionstore.BrowserOptions{Profile: profile, Executable: o.executable, Headless: o.headless, NoSandbox: o.noSandbox})
		if err != nil {
			return output{}, err
		}
		if state.Browser == nil || state.Browser.ID != info.ID {
			state.DirectTarget = ""
			state.DirectDocument = ""
			state.DirectTabs = nil
		}
		state.Browser = &sessionstore.BrowserBinding{Mode: "agent", Profile: profile, ID: info.ID, Process: sessionstore.OwnedProcess{PID: info.PID, Started: info.Started, Profile: info.ProfilePath}}
		if err := store.Save(state); err != nil {
			return output{}, err
		}
	}
	if state.Browser == nil {
		return output{}, &cmdError{Message: "no owned browser is bound to this session", Hint: "Run `browsercontrol open <url>` or `browsercontrol browser start` first."}
	}
	if o.profile != "" && o.profile != state.Browser.Profile {
		return output{}, errors.New("profile differs from the session browser; select the session used by open")
	}
	browser, err := manager.ConnectAgent(ctx, *state.Browser)
	if err != nil {
		return output{}, err
	}
	defer browser.Close()
	pages, err := browser.Pages(ctx)
	if err != nil {
		return output{}, err
	}
	slices.SortFunc(pages, func(a, b driver.PageInfo) int { return strings.Compare(a.ID, b.ID) })
	scrub := privacy.NewScrubber(nil)
	if name == "tabs" && (len(o.positionals) == 1 || o.positionals[1] == "list") {
		state.DirectTabs = nil
		var lines []string
		for i := range pages {
			state.DirectTabs = append(state.DirectTabs, pages[i].ID)
			pages[i].Title = scrub.Text(pages[i].Title)
			pages[i].URL = scrub.URL(pages[i].URL)
			lines = append(lines, fmt.Sprintf("[%d] %s %s %s", i+1, pages[i].ID, pages[i].Title, pages[i].URL))
		}
		if err := store.Save(state); err != nil {
			return output{}, err
		}
		text := strings.Join(lines, "\n")
		if text == "" {
			text = "(no pages)"
		}
		return output{data: map[string]any{"tabs": pages, "current": state.DirectTarget}, text: text}, nil
	}
	selector := o.tab
	if name == "tabs" {
		selector = o.positionals[2]
	}
	selected, err := selectAgentPage(pages, state, selector)
	if name == "open" && (o.newTab || len(pages) == 0) {
		journal, openErr := store.OpenJournal(lock)
		if openErr != nil {
			return output{}, openErr
		}
		var created driver.AgentPage
		result, createErr := journal.Execute(ctx, sessionstore.ActionScope{BrowserID: state.Browser.ID, TargetID: "browser_tabs"}, driver.CreateTab, func(ctx context.Context) (driver.ActionResult, error) {
			var action driver.ActionResult
			var err error
			created, action, err = browser.OpenBlank(ctx)
			return action, err
		})
		if createErr != nil {
			return output{}, &cmdError{Message: createErr.Error(), Result: result, Hint: "Inspect tabs; tab creation is never replayed automatically."}
		}
		selected = driver.PageInfo{ID: created.ID(), URL: "about:blank"}
		_ = created.Close(ctx)
		_ = store.ReleaseTab(ctx, state.Browser.ID, "browser_tabs")
		err = nil
	}
	if err != nil {
		return output{}, err
	}
	mutating := name == "open" || name == "click" || name == "type" || name == "fill" || name == "press" || name == "scroll" || name == "tabs" && o.positionals[1] == "close"
	if mutating && name != "open" && !(name == "tabs" && permissions.Act && len(permissions.Origins) == 0) {
		if err := permissions.Check(sessionstore.Act, selected.URL); err != nil {
			return output{}, err
		}
	}
	if _, err := store.ClaimTab(ctx, state.Browser.ID, selected.ID, 5*time.Minute); err != nil {
		return output{}, err
	}
	if state.DirectTarget != selected.ID && !(name == "tabs" && o.positionals[1] == "close") {
		state.DirectTarget = selected.ID
		state.DirectDocument = ""
		if err := store.Save(state); err != nil {
			return output{}, err
		}
	}
	if name == "tabs" && o.positionals[1] == "switch" {
		return output{data: map[string]any{"tab": selected, "selected": true}, text: "selected " + selected.ID}, nil
	}
	if name == "tabs" && o.positionals[1] == "close" {
		journal, err := store.OpenJournal(lock)
		if err != nil {
			return output{}, err
		}
		result, err := journal.Execute(ctx, sessionstore.ActionScope{BrowserID: state.Browser.ID, TargetID: selected.ID}, driver.CloseTab, func(ctx context.Context) (driver.ActionResult, error) { return browser.RemovePage(ctx, selected.ID) })
		if err != nil {
			return output{}, &cmdError{Message: err.Error(), Result: result}
		}
		if state.DirectTarget == selected.ID {
			state.DirectTarget = ""
			state.DirectDocument = ""
		}
		if err := store.Save(state); err != nil {
			return output{}, err
		}
		_ = store.ReleaseTab(ctx, state.Browser.ID, selected.ID)
		return output{data: result, text: "closed " + selected.ID}, nil
	}
	page, err := browser.AttachPage(ctx, selected.ID)
	if err != nil {
		return output{}, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = page.Close(cleanup)
	}()
	snapshot := func() (output, error) {
		value, err := page.Snapshot(ctx)
		if err != nil {
			return output{}, err
		}
		if state.DirectDocument != value.Epoch {
			state.DirectDocument = value.Epoch
			if err := store.Save(state); err != nil {
				return output{}, err
			}
		}
		return agentSnapshotOutput(value, o), nil
	}
	switch name {
	case "snapshot":
		return snapshot()
	case "read":
		max := o.maxChars
		if max == 0 {
			max = 6000
		}
		text, err := page.ReadText(ctx, max)
		return output{data: map[string]any{"text": text, "maxChars": max}, text: text}, err
	case "wait":
		err := page.Wait(ctx, o.positionals[1])
		return output{data: map[string]any{"conditionMet": err == nil}, text: "condition observed"}, err
	case "screenshot":
		data, err := page.Screenshot(ctx, o.full)
		if err != nil {
			return output{}, err
		}
		path := o.out
		if path == "" && len(o.positionals) > 1 {
			path = o.positionals[1]
		}
		if path == "" {
			path = filepath.Join("data", "screenshots", "screenshot-"+rand.Text()+".png")
		}
		if !strings.EqualFold(filepath.Ext(path), ".png") {
			return output{}, usagef("screenshot output must end in .png")
		}
		path, err = filepath.Abs(path)
		if err != nil {
			return output{}, err
		}
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return output{}, err
		}
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return output{}, errors.New("cannot create screenshot; existing files are never overwritten")
		}
		_, writeErr := file.Write(data)
		closeErr := file.Close()
		if err := errors.Join(writeErr, closeErr); err != nil {
			return output{}, err
		}
		return output{data: map[string]any{"path": path, "bytes": len(data), "format": "png"}, text: fmt.Sprintf("%s · %d bytes", path, len(data))}, nil
	}
	journal, err := store.OpenJournal(lock)
	if err != nil {
		return output{}, err
	}
	kind := driver.Click
	switch name {
	case "open":
		kind = driver.Navigate
	case "type", "fill":
		kind = driver.InsertText
	case "press":
		kind = driver.Press
	case "scroll":
		kind = driver.Scroll
	}
	if name == "open" {
		state.DirectDocument = ""
		if err := store.Save(state); err != nil {
			return output{}, err
		}
	}
	result, actionErr := journal.Execute(ctx, sessionstore.ActionScope{BrowserID: state.Browser.ID, TargetID: selected.ID}, kind, func(ctx context.Context) (driver.ActionResult, error) {
		if name != "open" {
			if err := page.CheckOrigin(ctx, permissions.Origins); err != nil {
				blocked := driver.NewAction(kind)
				blocked.Status = driver.Blocked
				blocked.FinishedAt = time.Now().UnixMilli()
				return blocked, err
			}
		}
		switch name {
		case "open":
			return page.Navigate(ctx, o.positionals[1])
		case "press":
			keys, _ := agentKeys(o.positionals[1])
			return page.Press(ctx, keys)
		case "scroll":
			x, y, _ := scrollDeltas(o.positionals[1:])
			return page.Act(ctx, driver.AgentRequest{Operation: "scroll", X: x, Y: y, Origins: permissions.Origins})
		case "type", "fill":
			return page.Act(ctx, driver.AgentRequest{Operation: "type", Target: o.positionals[1], Epoch: state.DirectDocument, Text: o.positionals[2], Clear: o.clear || name == "fill", Origins: permissions.Origins})
		default:
			return page.Act(ctx, driver.AgentRequest{Operation: "click", Target: o.positionals[1], Epoch: state.DirectDocument, Origins: permissions.Origins})
		}
	})
	if actionErr != nil {
		return output{}, &cmdError{Message: scrub.Text(actionErr.Error()), Result: result, Hint: "Observe snapshot/read before deciding what to do next; do not repeat uncertain input."}
	}
	out := output{data: map[string]any{"action": result, "tabId": selected.ID}, text: fmt.Sprintf("%s: %s · input acknowledged; verify with snapshot/read/wait", name, result.Status)}
	if o.snap {
		next, err := snapshot()
		if err != nil {
			return output{}, &cmdError{Message: "action acknowledged but follow-up snapshot failed", Result: result, Hint: "Do not repeat input; run snapshot separately."}
		}
		out.data = map[string]any{"action": result, "snapshot": next.data}
		out.text += "\n" + next.text
	}
	return out, nil
}

func selectAgentPage(pages []driver.PageInfo, state sessionstore.State, selector string) (driver.PageInfo, error) {
	if selector == "" {
		selector = state.DirectTarget
		if selector == "" && len(pages) == 1 {
			return pages[0], nil
		}
	}
	if index, err := strconv.Atoi(selector); err == nil {
		if index < 1 || index > len(state.DirectTabs) {
			return driver.PageInfo{}, usagef("tab index is unknown; run tabs first or pass its target ID")
		}
		selector = state.DirectTabs[index-1]
	}
	for _, page := range pages {
		if page.ID == selector {
			return page, nil
		}
	}
	return driver.PageInfo{}, errors.New("no unambiguous selected page; run open, or tabs then --tab <target-id>")
}

func agentSnapshotOutput(value driver.AgentSnapshot, o directOptions) output {
	total := len(value.Nodes)
	nodes := make([]driver.AgentNode, 0)
	var lines []string
	for _, node := range value.Nodes {
		line := fmt.Sprintf("[%d] %s %q", node.ID, node.Role, node.Name)
		if node.Value != "" {
			line += " value=" + strconv.Quote(node.Value)
		}
		if node.Disabled {
			line += " disabled"
		}
		if o.bench.Grep != "" && !strings.Contains(strings.ToLower(line), strings.ToLower(o.bench.Grep)) {
			continue
		}
		if o.bench.Limit > 0 && len(nodes) >= o.bench.Limit {
			continue
		}
		nodes = append(nodes, node)
		lines = append(lines, line)
	}
	value.Nodes = nodes
	text := value.Title + " · " + value.URL + "\n" + strings.Join(lines, "\n")
	if total > len(nodes) {
		text += fmt.Sprintf("\n(%d of %d nodes shown)", len(nodes), total)
	}
	if value.Truncated {
		text += "\n(truncated: collection budget reached)"
	}
	text += "\n(coverage: main document/open shadow roots; child frames not collected)"
	return output{data: map[string]any{"snapshot": value, "shown": len(nodes), "total": total}, text: text}
}

func scrollDeltas(args []string) (float64, float64, error) {
	y := 0.0
	var err error
	switch args[0] {
	case "up":
		y = -600
	case "down":
		y = 600
	default:
		y, err = strconv.ParseFloat(args[0], 64)
	}
	x := 0.0
	if err == nil && len(args) > 1 {
		x, err = strconv.ParseFloat(args[1], 64)
	}
	if err != nil || x != x || y != y || x > 1e6 || x < -1e6 || y > 1e6 || y < -1e6 {
		return 0, 0, usagef("scroll deltas must be finite and between -1000000 and 1000000")
	}
	return x, y, nil
}

func agentKeys(chord string) ([]driver.Key, error) {
	parts := strings.Split(chord, "+")
	keys := make([]driver.Key, 0, len(parts))
	known := map[string]driver.Key{"Control": {Key: "Control", Code: "ControlLeft", VirtualKey: 17}, "Alt": {Key: "Alt", Code: "AltLeft", VirtualKey: 18}, "Shift": {Key: "Shift", Code: "ShiftLeft", VirtualKey: 16}, "Meta": {Key: "Meta", Code: "MetaLeft", VirtualKey: 91}, "Enter": {Key: "Enter", Code: "Enter", VirtualKey: 13}, "Tab": {Key: "Tab", Code: "Tab", VirtualKey: 9}, "Escape": {Key: "Escape", Code: "Escape", VirtualKey: 27}, "Backspace": {Key: "Backspace", Code: "Backspace", VirtualKey: 8}, "Delete": {Key: "Delete", Code: "Delete", VirtualKey: 46}, "Space": {Key: " ", Code: "Space", VirtualKey: 32}, "ArrowLeft": {Key: "ArrowLeft", Code: "ArrowLeft", VirtualKey: 37}, "ArrowRight": {Key: "ArrowRight", Code: "ArrowRight", VirtualKey: 39}, "ArrowUp": {Key: "ArrowUp", Code: "ArrowUp", VirtualKey: 38}, "ArrowDown": {Key: "ArrowDown", Code: "ArrowDown", VirtualKey: 40}, "Home": {Key: "Home", Code: "Home", VirtualKey: 36}, "End": {Key: "End", Code: "End", VirtualKey: 35}}
	if len(parts) > 8 {
		return nil, usagef("key chord exceeds eight keys")
	}
	seen := map[string]bool{}
	for index, part := range parts {
		if part == "Ctrl" {
			part = "Control"
		}
		key, ok := known[part]
		modifier := part == "Control" || part == "Alt" || part == "Shift" || part == "Meta"
		if seen[part] || index < len(parts)-1 && !modifier {
			return nil, usagef("invalid key chord: modifiers precede one final key; duplicates are not allowed")
		}
		seen[part] = true
		if !ok {
			if len(part) != 1 || !((part[0] >= 'a' && part[0] <= 'z') || (part[0] >= 'A' && part[0] <= 'Z') || (part[0] >= '0' && part[0] <= '9')) {
				return nil, usagef("unsupported key; use Enter/Tab/Escape/arrows or ASCII letters/digits")
			}
			key = driver.Key{Key: part, VirtualKey: int(strings.ToUpper(part)[0])}
			if part[0] >= '0' && part[0] <= '9' {
				key.Code = "Digit" + part
			} else {
				key.Code = "Key" + strings.ToUpper(part)
			}
			if seen["Shift"] {
				if part[0] >= '0' && part[0] <= '9' {
					key.Key = string(")!@#$%^&*("[part[0]-'0'])
				} else {
					key.Key = strings.ToUpper(part)
				}
			}
		}
		keys = append(keys, key)
	}
	return keys, nil
}
