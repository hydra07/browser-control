package cdp

import (
	"errors"
	"net/url"
	"slices"
	"strings"

	"github.com/hydra07/browsercontrol/cli/internal/driver"
	"github.com/hydra07/browsercontrol/cli/internal/privacy"
)

type fixtureDOMNode struct {
	driver.DOMNode
	sensitive, omitted, suppressText bool
}

var fixtureAttributes = map[string]bool{"id": true, "class": true, "name": true, "type": true, "role": true, "placeholder": true, "autocomplete": true, "title": true, "for": true, "href": true, "src": true, "value": true, "data-testid": true, "data-test": true, "tabindex": true, "disabled": true, "checked": true, "selected": true}
var fixtureStates = map[string]bool{"disabled": true, "checked": true, "expanded": true, "selected": true, "focused": true, "required": true, "invalid": true, "pressed": true, "busy": true, "protected": true, "modal": true}

func sanitizeCapture(raw captureDOM, frames []captureFrame, trees map[string][]captureAXNode, missing []string, options driver.CaptureOptions, browser string) (driver.Capture, error) {
	read := func(index int) (string, error) {
		if index == -1 {
			return "", nil
		}
		if index < 0 || index >= len(raw.Strings) {
			return "", errors.New("invalid DOM snapshot string index")
		}
		return raw.Strings[index], nil
	}
	var documents [][]fixtureDOMNode
	var secrets []string
	for _, frame := range frames {
		secrets = append(secrets, privacy.URLCredentials(frame.Frame.URL)...)
	}
	sensitiveHandles, omittedHandles := map[int]bool{}, map[int]bool{}
	for _, doc := range raw.Documents {
		uri, err := read(doc.DocumentURL)
		if err != nil {
			return driver.Capture{}, err
		}
		secrets = append(secrets, privacy.URLCredentials(uri)...)
		n := doc.Nodes
		count := len(n.NodeType)
		if count != len(n.ParentIndex) || count != len(n.NodeName) || count != len(n.NodeValue) || count != len(n.BackendNodeID) || len(n.Attributes) != 0 && count != len(n.Attributes) {
			return driver.Capture{}, errors.New("inconsistent DOM snapshot arrays")
		}
		values := map[int]string{}
		shadows := map[int]string{}
		for table, rare := range []rareStrings{n.InputValue, n.TextValue, n.ShadowRootType} {
			if len(rare.Index) != len(rare.Value) {
				return driver.Capture{}, errors.New("invalid DOM value table")
			}
			for i, index := range rare.Index {
				if index < 0 || index >= count {
					return driver.Capture{}, errors.New("invalid DOM value node index")
				}
				value, err := read(rare.Value[i])
				if err != nil {
					return driver.Capture{}, err
				}
				if table == 2 {
					if value != "open" && value != "closed" && value != "user-agent" {
						return driver.Capture{}, errors.New("invalid shadow root type")
					}
					shadows[index] = value
				} else {
					values[index] = value
				}
			}
		}
		nodes := make([]fixtureDOMNode, 0, count)
		for i := 0; i < count; i++ {
			if n.ParentIndex[i] < -1 || n.ParentIndex[i] >= i {
				return driver.Capture{}, errors.New("invalid DOM parent relationship")
			}
			name, err := read(n.NodeName[i])
			if err != nil {
				return driver.Capture{}, err
			}
			text, err := read(n.NodeValue[i])
			if err != nil {
				return driver.Capture{}, err
			}
			node := fixtureDOMNode{DOMNode: driver.DOMNode{Index: i, Parent: n.ParentIndex[i], Handle: n.BackendNodeID[i], Type: n.NodeType[i], Name: name, Text: text, Value: values[i], Attributes: map[string]string{}}}
			node.ShadowRoot = shadows[i]
			if node.Parent >= 0 {
				parent := nodes[node.Parent]
				node.sensitive, node.omitted, node.suppressText = parent.sensitive, parent.omitted, parent.suppressText
			}
			if len(n.Attributes) != 0 {
				attributes := n.Attributes[i]
				if len(attributes)%2 != 0 {
					return driver.Capture{}, errors.New("invalid DOM attribute pairs")
				}
				for j := 0; j < len(attributes); j += 2 {
					key, err := read(attributes[j])
					if err != nil {
						return driver.Capture{}, err
					}
					value, err := read(attributes[j+1])
					if err != nil {
						return driver.Capture{}, err
					}
					key = strings.ToLower(key)
					if key == "href" || key == "src" {
						secrets = append(secrets, privacy.URLCredentials(value)...)
					}
					if privacy.ClassifyField(strings.TrimPrefix(key, "data-")) == privacy.Secret {
						secrets = append(secrets, value)
					}
					if fixtureAttributes[key] || strings.HasPrefix(key, "aria-") {
						node.Attributes[key] = value
					}
				}
			}
			for _, key := range []string{"name", "id", "type", "autocomplete", "aria-label", "placeholder"} {
				node.sensitive = node.sensitive || privacy.ClassifyField(node.Attributes[key]) == privacy.Secret
			}
			for _, token := range strings.Fields(node.Attributes["autocomplete"]) {
				node.sensitive = node.sensitive || privacy.ClassifyField(token) == privacy.Secret
			}
			node.sensitive = node.sensitive || strings.EqualFold(node.Attributes["type"], "hidden")
			for _, class := range strings.Fields(node.Attributes["class"] + " " + node.Attributes["id"]) {
				node.omitted = node.omitted || strings.HasPrefix(class, "__bc_")
			}
			tag := strings.ToUpper(name)
			node.suppressText = node.suppressText || tag == "SCRIPT" || tag == "STYLE" || tag == "NOSCRIPT" || node.Type == 8
			if node.sensitive {
				if node.Handle > 0 {
					sensitiveHandles[node.Handle] = true
				}
				secrets = append(secrets, node.Value, node.Attributes["value"])
				if !node.suppressText {
					secrets = append(secrets, node.Text)
				}
			}
			if node.omitted {
				omittedHandles[node.Handle] = true
			}
			nodes = append(nodes, node)
		}
		documents = append(documents, nodes)
	}
	for _, nodes := range trees {
		for _, node := range nodes {
			protected := sensitiveHandles[node.BackendDOMNodeID]
			for _, property := range node.Properties {
				protected = protected || property.Name == "protected" && property.Value.text() == "true"
			}
			if protected {
				secrets = append(secrets, node.Value.text())
			}
		}
	}
	if len(secrets) > 4096 {
		return driver.Capture{}, errors.New("credential redaction budget exceeded")
	}
	scrubber := privacy.NewScrubber(secrets)
	capture := driver.Capture{Epoch: newCaptureEpoch(), URL: scrubber.URL(frames[0].Frame.URL), Browser: scrubber.Text(browser), Frames: []driver.Frame{}, Documents: []driver.Document{}, Accessibility: []driver.AccessTree{}, MissingFrames: slices.Clone(missing)}
	remaining := options.MaxNodes
	domFrames := map[string]bool{}
	for i, rawDoc := range raw.Documents {
		frame, err := read(rawDoc.FrameID)
		if err != nil || frame == "" {
			return driver.Capture{}, errors.New("invalid DOM document frame")
		}
		if i >= options.MaxFrames {
			capture.Truncated = true
			capture.MissingFrames = append(capture.MissingFrames, frame)
			continue
		}
		uri, err := read(rawDoc.DocumentURL)
		if err != nil {
			return driver.Capture{}, err
		}
		title, err := read(rawDoc.Title)
		if err != nil {
			return driver.Capture{}, err
		}
		doc := driver.Document{FrameID: frame, URL: scrubber.URL(uri), Title: scrubber.Text(title), Nodes: []driver.DOMNode{}}
		for _, node := range documents[i] {
			if node.omitted {
				continue
			}
			if remaining <= 0 {
				capture.Truncated = true
				break
			}
			remaining--
			safe := node.DOMNode
			safe.Name = scrubber.Text(safe.Name)
			if node.suppressText {
				safe.Text = ""
			}
			safe.Text, safe.Value = scrubber.Text(safe.Text), scrubber.Text(safe.Value)
			if node.sensitive {
				if safe.Text != "" {
					safe.Text = privacy.Redacted
				}
				if safe.Value != "" {
					safe.Value = privacy.Redacted
				}
			}
			for key, value := range safe.Attributes {
				if key == "href" || key == "src" {
					if base, err := url.Parse(uri); err == nil {
						if relative, err := url.Parse(value); err == nil {
							value = base.ResolveReference(relative).String()
						}
					}
					safe.Attributes[key] = scrubber.URL(value)
				} else {
					safe.Attributes[key] = scrubber.Text(value)
				}
				if node.sensitive && key == "value" {
					safe.Attributes[key] = privacy.Redacted
				}
			}
			doc.Nodes = append(doc.Nodes, safe)
		}
		domFrames[frame] = true
		capture.Documents = append(capture.Documents, doc)
	}
	for i, rawFrame := range frames {
		frame := rawFrame.Frame
		if i >= options.MaxFrames {
			capture.Truncated = true
			continue
		}
		capture.Frames = append(capture.Frames, driver.Frame{ID: frame.ID, ParentID: frame.ParentID, URL: scrubber.URL(frame.URL)})
		nodes, found := trees[frame.ID]
		if !found || !domFrames[frame.ID] {
			capture.MissingFrames = append(capture.MissingFrames, frame.ID)
		}
		tree := driver.AccessTree{FrameID: frame.ID, Nodes: []driver.AccessNode{}}
		omit := omittedAXNodes(nodes, omittedHandles)
		for _, node := range nodes {
			if omit[node.NodeID] {
				continue
			}
			if remaining <= 0 {
				capture.Truncated = true
				break
			}
			remaining--
			safe := driver.AccessNode{ID: node.NodeID, ParentID: node.ParentID, Handle: node.BackendDOMNodeID, Role: scrubber.Text(node.Role.text()), Name: scrubber.Text(node.Name.text()), Value: scrubber.Text(node.Value.text()), Ignored: node.Ignored, States: map[string]string{}}
			for _, child := range node.ChildIDs {
				if !omit[child] {
					safe.Children = append(safe.Children, child)
				}
			}
			for _, property := range node.Properties {
				if fixtureStates[property.Name] {
					safe.States[property.Name] = scrubber.Text(property.Value.text())
				}
			}
			if sensitiveHandles[node.BackendDOMNodeID] || safe.States["protected"] == "true" {
				if safe.Value != "" {
					safe.Value = privacy.Redacted
				}
			}
			tree.Nodes = append(tree.Nodes, safe)
		}
		capture.Accessibility = append(capture.Accessibility, tree)
	}
	slices.Sort(capture.MissingFrames)
	capture.MissingFrames = slices.Compact(capture.MissingFrames)
	capture.Truncated = capture.Truncated || len(capture.MissingFrames) > 0
	return capture, nil
}

func omittedAXNodes(nodes []captureAXNode, handles map[int]bool) map[string]bool {
	byID := map[string]captureAXNode{}
	var pending []string
	for _, node := range nodes {
		byID[node.NodeID] = node
		if node.BackendDOMNodeID != 0 && handles[node.BackendDOMNodeID] {
			pending = append(pending, node.NodeID)
		}
	}
	omit := map[string]bool{}
	for len(pending) > 0 {
		id := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if omit[id] {
			continue
		}
		omit[id] = true
		pending = append(pending, byID[id].ChildIDs...)
	}
	return omit
}
